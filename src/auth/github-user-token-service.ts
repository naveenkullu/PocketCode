import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { decryptToken, encryptToken } from "./token-encryption.js";

const REFRESH_URL = "https://github.com/login/oauth/access_token";
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const REFRESH_LOCK_WAIT_MS = 15_000;
const REFRESH_LOCK_POLL_MS = 50;

export type GitHubTokenFailureCode =
  | "github_reconnect_required"
  | "github_refresh_rate_limited"
  | "github_refresh_unavailable";

export class GitHubTokenError extends Error {
  constructor(readonly code: GitHubTokenFailureCode) {
    super(code);
    this.name = "GitHubTokenError";
  }
}

export interface GitHubTokenConnection {
  id: string;
  userId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  reconnectRequired: number;
  refreshLockOwner?: string | null;
  refreshLockExpiresAt?: string | null;
}

export interface GitHubUserTokenOptions {
  database: Database.Database;
  userId: string;
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onLog?: (level: "warn", message: string) => void;
}

const inFlightRefreshes = new Map<string, Promise<string>>();

function getConnection(database: Database.Database, userId: string): GitHubTokenConnection | undefined {
  return database.prepare(`
    SELECT id, user_id AS userId, encrypted_access_token AS encryptedAccessToken,
      encrypted_refresh_token AS encryptedRefreshToken,
      access_token_expires_at AS accessTokenExpiresAt,
      refresh_token_expires_at AS refreshTokenExpiresAt,
      reconnect_required AS reconnectRequired,
      refresh_lock_owner AS refreshLockOwner,
      refresh_lock_expires_at AS refreshLockExpiresAt
    FROM github_connections WHERE user_id = ?
  `).get(userId) as GitHubTokenConnection | undefined;
}

function accessTokenIsValid(connection: GitHubTokenConnection, now: number): boolean {
  if (!connection.accessTokenExpiresAt) return true;
  const expiry = Date.parse(connection.accessTokenExpiresAt);
  return Number.isFinite(expiry) && expiry - now > REFRESH_EARLY_MS;
}

async function exchangeRefreshToken(
  refreshToken: string,
  options: GitHubUserTokenOptions,
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(REFRESH_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GitHubTokenError("github_refresh_unavailable");
  }
  let result: unknown;
  try { result = await response.json(); } catch { throw new GitHubTokenError("github_refresh_unavailable"); }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new GitHubTokenError("github_refresh_unavailable");
  }
  const body = result as Record<string, unknown>;
  if (response.status === 429) throw new GitHubTokenError("github_refresh_rate_limited");
  if (body.error === "invalid_grant" || body.error === "bad_refresh_token" || body.error === "bad_verification_code") {
    throw new GitHubTokenError("github_reconnect_required");
  }
  if (!response.ok) throw new GitHubTokenError("github_refresh_unavailable");
  if (
    typeof body.access_token !== "string" || !body.access_token ||
    typeof body.refresh_token !== "string" || !body.refresh_token ||
    typeof body.expires_in !== "number" || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0 ||
    typeof body.refresh_token_expires_in !== "number" ||
    !Number.isSafeInteger(body.refresh_token_expires_in) || body.refresh_token_expires_in <= 0
  ) throw new GitHubTokenError("github_refresh_unavailable");
  return body;
}

function markReconnectRequired(database: Database.Database, userId: string): void {
  database.prepare("UPDATE github_connections SET reconnect_required = 1, updated_at = ? WHERE user_id = ?")
    .run(new Date().toISOString(), userId);
}

async function rotateToken(options: GitHubUserTokenOptions, expected: GitHubTokenConnection, owner: string): Promise<string> {
  const connection = getConnection(options.database, options.userId);
  if (!connection || connection.reconnectRequired) throw new GitHubTokenError("github_reconnect_required");
  if (accessTokenIsValid(connection, (options.now ?? Date.now)())) {
    return decryptToken(connection.encryptedAccessToken, options.encryptionKey);
  }
  if (!connection.encryptedRefreshToken) {
    markReconnectRequired(options.database, options.userId);
    throw new GitHubTokenError("github_reconnect_required");
  }
  if (connection.refreshTokenExpiresAt) {
    const refreshExpiry = Date.parse(connection.refreshTokenExpiresAt);
    if (!Number.isFinite(refreshExpiry) || refreshExpiry <= (options.now ?? Date.now)()) {
      markReconnectRequired(options.database, options.userId);
      throw new GitHubTokenError("github_reconnect_required");
    }
  }

  let refreshToken: string;
  try { refreshToken = decryptToken(connection.encryptedRefreshToken, options.encryptionKey); }
  catch { markReconnectRequired(options.database, options.userId); throw new GitHubTokenError("github_reconnect_required"); }

  let tokenResponse: Record<string, unknown>;
  try {
    tokenResponse = await exchangeRefreshToken(refreshToken, options);
  } catch (error) {
    if (error instanceof GitHubTokenError && error.code === "github_reconnect_required") {
      markReconnectRequired(options.database, options.userId);
    }
    options.onLog?.("warn", error instanceof GitHubTokenError ? error.code : "github_refresh_unavailable");
    throw error instanceof GitHubTokenError ? error : new GitHubTokenError("github_refresh_unavailable");
  }

  const now = (options.now ?? Date.now)();
  const accessExpiry = new Date(now + Number(tokenResponse.expires_in) * 1000).toISOString();
  const refreshExpiry = new Date(now + Number(tokenResponse.refresh_token_expires_in) * 1000).toISOString();
  const encryptedAccess = encryptToken(tokenResponse.access_token as string, options.encryptionKey);
  const encryptedRefresh = encryptToken(tokenResponse.refresh_token as string, options.encryptionKey);
  const persist = options.database.transaction(() => {
    const current = getConnection(options.database, options.userId);
    if (!current) throw new GitHubTokenError("github_reconnect_required");
    // Another process may have rotated the token while this process was calling GitHub.
    if (current.encryptedRefreshToken !== expected.encryptedRefreshToken) {
      if (accessTokenIsValid(current, now)) return decryptToken(current.encryptedAccessToken, options.encryptionKey);
      throw new GitHubTokenError("github_refresh_unavailable");
    }
    const updateResult = options.database.prepare("UPDATE github_connections SET encrypted_access_token = ?, encrypted_refresh_token = ?, access_token_expires_at = ?, refresh_token_expires_at = ?, reconnect_required = 0, refresh_lock_owner = NULL, refresh_lock_expires_at = NULL, updated_at = ? WHERE user_id = ? AND encrypted_refresh_token = ? AND refresh_lock_owner = ?")
      .run(encryptedAccess, encryptedRefresh, accessExpiry, refreshExpiry, new Date(now).toISOString(), options.userId, expected.encryptedRefreshToken, owner);
    if (updateResult.changes !== 1) {
      throw new GitHubTokenError("github_refresh_unavailable");
    }
    return tokenResponse.access_token as string;
  });
  try { return persist(); }
  catch { throw new GitHubTokenError("github_refresh_unavailable"); }
}

/** Returns a valid GitHub user access token; the credential remains inside backend code. */
export async function getGitHubUserAccessToken(options: GitHubUserTokenOptions): Promise<string> {
  const connection = getConnection(options.database, options.userId);
  if (!connection || connection.reconnectRequired) throw new GitHubTokenError("github_reconnect_required");
  const now = (options.now ?? Date.now)();
  if (accessTokenIsValid(connection, now)) {
    try { return decryptToken(connection.encryptedAccessToken, options.encryptionKey); }
    catch { throw new GitHubTokenError("github_reconnect_required"); }
  }
  const key = connection.id;
  const existing = inFlightRefreshes.get(key);
  if (existing) {
    return existing;
  }
  const latest = getConnection(options.database, options.userId);
  if (!latest) throw new GitHubTokenError("github_reconnect_required");
  if (accessTokenIsValid(latest, (options.now ?? Date.now)())) return decryptToken(latest.encryptedAccessToken, options.encryptionKey);
  const owner = randomUUID();
  const nowIso = new Date((options.now ?? Date.now)()).toISOString();
  const lockUntil = new Date((options.now ?? Date.now)() + REFRESH_LOCK_WAIT_MS).toISOString();
  const claim = options.database.prepare(`UPDATE github_connections
    SET refresh_lock_owner = ?, refresh_lock_expires_at = ?
    WHERE user_id = ? AND reconnect_required = 0
      AND (refresh_lock_owner IS NULL OR refresh_lock_expires_at <= ?)`)
    .run(owner, lockUntil, options.userId, nowIso);
  if (claim.changes !== 1) {
    const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_POLL_MS));
      const current = getConnection(options.database, options.userId);
      if (!current || current.reconnectRequired) throw new GitHubTokenError("github_reconnect_required");
      if (accessTokenIsValid(current, (options.now ?? Date.now)())) {
        return decryptToken(current.encryptedAccessToken, options.encryptionKey);
      }
    }
    throw new GitHubTokenError("github_refresh_unavailable");
  }
  const refresh = rotateToken(options, latest, owner).finally(() => {
    options.database.prepare(`UPDATE github_connections SET refresh_lock_owner = NULL,
      refresh_lock_expires_at = NULL WHERE user_id = ? AND refresh_lock_owner = ?`)
      .run(options.userId, owner);
  });
  inFlightRefreshes.set(key, refresh);
  try { return await refresh; }
  finally { if (inFlightRefreshes.get(key) === refresh) inFlightRefreshes.delete(key); }
}