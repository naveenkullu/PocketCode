import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openDatabase } from "../src/storage/database.js";
import { encryptToken, decryptToken } from "../src/auth/token-encryption.js";
import {
  getGitHubUserAccessToken,
  GitHubTokenError,
  type GitHubUserTokenOptions,
} from "../src/auth/github-user-token-service.js";

const KEY = "0123456789abcdef".repeat(4);
let database: ReturnType<typeof openDatabase>;
let userId: string;

beforeEach(() => {
  database = openDatabase(":memory:");
  userId = randomUUID();
  database.prepare("INSERT INTO users (id, github_user_id, github_username) VALUES (?, ?, ?)")
    .run(userId, "123456", "refresh-test-user");
});

afterEach(() => database.close());

function setConnection(options: { accessExpiry: string | null; refreshToken?: string | null; refreshExpiry?: string | null; accessToken?: string; reconnect?: number } ): void {
  database.prepare(`INSERT INTO github_connections
    (id, user_id, encrypted_access_token, encrypted_refresh_token, access_token_expires_at,
      refresh_token_expires_at, reconnect_required)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), userId, encryptToken(options.accessToken ?? "old-access", KEY),
      options.refreshToken === null ? null : encryptToken(options.refreshToken ?? "old-refresh", KEY),
      options.accessExpiry, options.refreshExpiry ?? null, options.reconnect ?? 0);
}

function options(fetchImpl: typeof fetch, now = Date.now): GitHubUserTokenOptions {
  return { database, userId, clientId: "test-client", clientSecret: "test-client-secret", encryptionKey: KEY, fetchImpl, now };
}

function successResponse(access = "new-access", refresh = "new-refresh"): Response {
  return Response.json({ access_token: access, refresh_token: refresh, expires_in: 28800, refresh_token_expires_in: 15897600 });
}

describe("GitHub user token lifecycle", () => {
  it("returns a safely unexpired access token without refreshing", async () => {
    const now = Date.now();
    setConnection({ accessExpiry: new Date(now + 10 * 60_000).toISOString() });
    let calls = 0;
    const token = await getGitHubUserAccessToken(options(async () => { calls++; return successResponse(); }, () => now));
    assert.equal(token, "old-access");
    assert.equal(calls, 0);
  });

  it("refreshes an expired or near-expiry token and atomically persists the rotated token pair", async () => {
    const now = Date.now();
    setConnection({ accessExpiry: new Date(now + 30_000).toISOString(), refreshExpiry: new Date(now + 60_000_000).toISOString() });
    let requestBody: Record<string, unknown> = {};
    const token = await getGitHubUserAccessToken(options(async (_url, init) => {
      requestBody = Object.fromEntries(new URLSearchParams(String(init?.body)));
      return successResponse();
    }, () => now));
    assert.equal(token, "new-access");
    assert.equal(requestBody.grant_type, "refresh_token");
    assert.equal(requestBody.refresh_token, "old-refresh");
    const saved = database.prepare("SELECT * FROM github_connections WHERE user_id = ?").get(userId) as {
      encrypted_access_token: string; encrypted_refresh_token: string; access_token_expires_at: string;
      refresh_token_expires_at: string; reconnect_required: number;
    };
    assert.equal(decryptToken(saved.encrypted_access_token, KEY), "new-access");
    assert.equal(decryptToken(saved.encrypted_refresh_token, KEY), "new-refresh");
    assert.ok(Date.parse(saved.access_token_expires_at) > now);
    assert.ok(Date.parse(saved.refresh_token_expires_at) > now);
    assert.equal(saved.reconnect_required, 0);
  });

  it("marks reconnect required when no refresh token is available", async () => {
    setConnection({ accessExpiry: "2000-01-01T00:00:00.000Z", refreshToken: null });
    await assert.rejects(getGitHubUserAccessToken(options(async () => successResponse())), (error: unknown) => error instanceof GitHubTokenError && error.code === "github_reconnect_required");
    assert.equal((database.prepare("SELECT reconnect_required FROM github_connections").get() as { reconnect_required: number }).reconnect_required, 1);
  });

  it("rejects malformed refresh responses without altering stored credentials", async () => {
    setConnection({ accessExpiry: "2000-01-01T00:00:00.000Z" });
    const before = database.prepare("SELECT encrypted_access_token, encrypted_refresh_token FROM github_connections").get();
    await assert.rejects(getGitHubUserAccessToken(options(async () => Response.json({ access_token: "partial" }))), (error: unknown) => error instanceof GitHubTokenError && error.code === "github_refresh_unavailable");
    assert.deepEqual(database.prepare("SELECT encrypted_access_token, encrypted_refresh_token FROM github_connections").get(), before);
  });

  it("marks revoked credentials reconnect-required and does not expose upstream details", async () => {
    setConnection({ accessExpiry: "2000-01-01T00:00:00.000Z" });
    const logs: string[] = [];
    await assert.rejects(getGitHubUserAccessToken({
      ...options(async () => Response.json({ error: "invalid_grant", error_description: "refresh-secret-description" }, { status: 400 })),
      onLog: (_level, message) => logs.push(message),
    }), (error: unknown) => error instanceof GitHubTokenError && error.code === "github_reconnect_required" && !error.message.includes("refresh-secret"));
    assert.equal((database.prepare("SELECT reconnect_required FROM github_connections").get() as { reconnect_required: number }).reconnect_required, 1);
    assert.doesNotMatch(logs.join(""), /refresh-secret-description/);
  });

  it("maps rate limits and network timeouts to non-secret errors", async () => {
    setConnection({ accessExpiry: "2000-01-01T00:00:00.000Z" });
    await assert.rejects(getGitHubUserAccessToken(options(async () => new Response("{}", { status: 429 }))), (error: unknown) => error instanceof GitHubTokenError && error.code === "github_refresh_rate_limited");
    await assert.rejects(getGitHubUserAccessToken(options(async () => { throw new Error("secret-value"); })), (error: unknown) => error instanceof GitHubTokenError && !error.message.includes("secret-value"));
  });

  it("serializes concurrent refreshes so rotating refresh tokens are consumed once", async () => {
    setConnection({ accessExpiry: "2000-01-01T00:00:00.000Z" });
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return successResponse();
    };
    const [first, second] = await Promise.all([
      getGitHubUserAccessToken(options(fetchImpl)),
      getGitHubUserAccessToken(options(fetchImpl)),
    ]);
    assert.equal(first, "new-access");
    assert.equal(second, "new-access");
    assert.equal(calls, 1);
  });

  it("does not accept a refresh response if atomic persistence fails", async () => {
    setConnection({ accessExpiry: "2000-01-01T00:00:00.000Z" });
    database.exec("CREATE TRIGGER fail_token_rotation BEFORE UPDATE OF encrypted_access_token ON github_connections BEGIN SELECT RAISE(FAIL, 'simulated database error'); END;");
    await assert.rejects(getGitHubUserAccessToken(options(async () => successResponse())), (error: unknown) => error instanceof GitHubTokenError && error.code === "github_refresh_unavailable");
    const saved = database.prepare("SELECT encrypted_access_token FROM github_connections").get() as { encrypted_access_token: string };
    assert.equal(decryptToken(saved.encrypted_access_token, KEY), "old-access");
  });
});