import { createSign } from "node:crypto";
import type { GitHubAppConfig } from "../server/index.js";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

export class GitHubAppApiError extends Error {
  constructor(readonly code: "not_found" | "permission_denied" | "rate_limited" | "unavailable" | "invalid_response") {
    super(code);
    this.name = "GitHubAppApiError";
  }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function createGitHubAppJwt(config: GitHubAppConfig, now = Date.now()): string {
  if (!config.appId || !config.privateKey) throw new Error("GitHub App JWT configuration is unavailable.");
  const privateKey = config.privateKey.replace(/\\n/g, "\n");
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 8 * 60, iss: config.appId }));
  const input = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(privateKey).toString("base64url")}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface VerifiedInstallation {
  installationId: string;
  accountId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  suspended: boolean;
  appId?: string;
}

export async function fetchVerifiedInstallation(
  installationId: string,
  config: GitHubAppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedInstallation> {
  const jwt = createGitHubAppJwt(config);
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GitHubAppApiError("unavailable");
  }
  if (response.status === 429 || response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    throw new GitHubAppApiError("rate_limited");
  }
  if (response.status === 404) throw new GitHubAppApiError("not_found");
  if (response.status === 403) throw new GitHubAppApiError("permission_denied");
  if (!response.ok) throw new GitHubAppApiError("unavailable");
  let body: unknown;
  try { body = await response.json(); } catch { throw new GitHubAppApiError("invalid_response"); }
  if (!record(body) || !record(body.account)) throw new GitHubAppApiError("invalid_response");
  const account = body.account;
  if (
    (typeof body.id !== "number" && typeof body.id !== "string") || !/^\d+$/.test(String(body.id)) ||
    (typeof account.id !== "number" && typeof account.id !== "string") || !/^\d+$/.test(String(account.id)) ||
    typeof account.login !== "string" || !account.login.trim() ||
    (account.type !== "User" && account.type !== "Organization") ||
    (body.repository_selection !== "all" && body.repository_selection !== "selected") ||
    (typeof body.app_id !== "number" && typeof body.app_id !== "string") ||
    String(body.app_id) !== config.appId
  ) throw new GitHubAppApiError("invalid_response");
  return {
    installationId: String(body.id),
    accountId: String(account.id),
    accountLogin: account.login,
    accountType: account.type,
    repositorySelection: body.repository_selection,
    suspended: body.suspended_at !== null && body.suspended_at !== undefined,
    appId: String(body.app_id),
  };
}

export async function createGitHubInstallationToken(
  installationId: string,
  config: GitHubAppConfig,
  fetchImpl: typeof fetch = fetch,
  permissions: { contents: "read" | "write" } = { contents: "read" },
): Promise<string> {
  const jwt = createGitHubAppJwt(config);
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: JSON.stringify({ permissions: { metadata: "read", contents: permissions.contents } }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GitHubAppApiError("unavailable");
  }
  if (response.status === 429 || response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    throw new GitHubAppApiError("rate_limited");
  }
  if (response.status === 404) throw new GitHubAppApiError("not_found");
  if (response.status === 403 || response.status === 422) throw new GitHubAppApiError("permission_denied");
  if (!response.ok) throw new GitHubAppApiError("unavailable");
  let body: unknown;
  try { body = await response.json(); } catch { throw new GitHubAppApiError("invalid_response"); }
  if (!record(body) || typeof body.token !== "string" || !body.token.trim() ||
      typeof body.expires_at !== "string" || !Number.isFinite(Date.parse(body.expires_at)) ||
      Date.parse(body.expires_at) <= Date.now()) {
    throw new GitHubAppApiError("invalid_response");
  }
  return body.token;
}

export async function fetchAuthenticatedGitHubIdentity(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; login: string }> {
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API}/user`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}`, "X-GitHub-Api-Version": API_VERSION },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new GitHubAppApiError("unavailable"); }
  if (!response.ok) throw new GitHubAppApiError("unavailable");
  let body: unknown;
  try { body = await response.json(); } catch { throw new GitHubAppApiError("invalid_response"); }
  if (!record(body) || !/^\d+$/.test(String(body.id)) || typeof body.login !== "string" || !body.login.trim()) {
    throw new GitHubAppApiError("invalid_response");
  }
  return { id: String(body.id), login: body.login };
}