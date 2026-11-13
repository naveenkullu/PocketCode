import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createServer,
  loadServerConfig,
  requireGitHubAppConfig,
  type GitHubAppConfig,
  type ServerConfig,
} from "../src/server/index.js";
import { openDatabase } from "../src/storage/database.js";
import { decryptToken, encryptToken } from "../src/auth/token-encryption.js";
import { createSession } from "../src/auth/session-service.js";
import { createHash, generateKeyPairSync } from "node:crypto";

const testConfig: ServerConfig = {
  port: 3000,
  host: "127.0.0.1",
  publicBaseUrl: "http://127.0.0.1:3000",
};

const testGitHubAppPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("Fastify server factory", () => {
  it("constructs without listening and serves the existing health response", async () => {
    const database = openDatabase(":memory:");
    const app = createServer({ config: testConfig, database });

    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        status: "ok",
        service: "pocketcode-api",
      });
      assert.equal(app.server.listening, false);
    } finally {
      await app.close();
    }
  });

  it("returns the existing not-found response for unknown routes", async () => {
    const app = createServer({ config: testConfig, database: openDatabase(":memory:") });

    try {
      const response = await app.inject({ method: "GET", url: "/not-a-route" });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), {
        statusCode: 404,
        error: "Not Found",
        message: "Not Found",
      });
    } finally {
      await app.close();
    }
  });

  it("closes an injected database when the Fastify instance closes", async () => {
    const database = openDatabase(":memory:");
    const app = createServer({ config: testConfig, database });

    await app.close();

    assert.throws(() => database.prepare("SELECT 1").get(), /not open|closed/i);
  });
});

const validGitHubConfig: GitHubAppConfig = {
  clientId: "Iv1.example123",
  clientSecret: "test-secret-value",
  slug: "pocketcode-test-app",
  appId: "12345",
  privateKey: testGitHubAppPrivateKey,
  callbackUrl: "http://localhost:3000/auth/github/callback",
  setupUrl: "https://pocketcode-test-app.github.app/api/github/setup",
  tokenEncryptionKey: "0123456789abcdef".repeat(4),
};

describe("GitHub App configuration", () => {
  it("defaults the host to the loopback address in development", () => {
    assert.equal(loadServerConfig({ NODE_ENV: "development" }).host, "127.0.0.1");
  });

  it("defaults the host to all interfaces in production", () => {
    assert.equal(
      loadServerConfig({ NODE_ENV: "production", FRONTEND_URL: "https://example.com" }).host,
      "0.0.0.0",
    );
  });

  it("uses an explicitly configured host in production", () => {
    assert.equal(
      loadServerConfig({
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        FRONTEND_URL: "https://example.com",
      }).host,
      "127.0.0.1",
    );
  });

  it("reports missing required variable names without exposing secret values", () => {
    const secret = "must-never-appear-in-errors";
    const config: ServerConfig = {
      ...testConfig,
      githubApp: { ...validGitHubConfig, clientSecret: secret, callbackUrl: undefined },
    };
    assert.throws(
      () => requireGitHubAppConfig(config, "user-authorization"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /GITHUB_APP_CALLBACK_URL/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  });

  it("loads and validates a valid development configuration", () => {
    const config = loadServerConfig({
      PORT: "3000",
      GITHUB_APP_CLIENT_ID: validGitHubConfig.clientId,
      GITHUB_APP_CLIENT_SECRET: validGitHubConfig.clientSecret,
      GITHUB_APP_SLUG: validGitHubConfig.slug,
      GITHUB_APP_ID: validGitHubConfig.appId,
      GITHUB_APP_PRIVATE_KEY: validGitHubConfig.privateKey,
      GITHUB_APP_CALLBACK_URL: validGitHubConfig.callbackUrl,
      GITHUB_APP_SETUP_URL: validGitHubConfig.setupUrl,
      TOKEN_ENCRYPTION_KEY: validGitHubConfig.tokenEncryptionKey,
    });
    assert.equal(requireGitHubAppConfig(config, "user-authorization").slug, "pocketcode-test-app");
    assert.equal(config.frontendUrl, "http://localhost:5173");
  });

  it("uses an explicitly configured frontend origin", () => {
    const config = loadServerConfig({
      PORT: "3000",
      FRONTEND_URL: "http://localhost:5173",
    });
    assert.equal(config.frontendUrl, "http://localhost:5173");
  });

  it("rejects an invalid callback URL without echoing its contents", () => {
    const secretValue = "not-a-url-secret-marker";
    assert.throws(
      () => loadServerConfig({ GITHUB_APP_CALLBACK_URL: secretValue }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /GITHUB_APP_CALLBACK_URL/);
        assert.doesNotMatch(error.message, new RegExp(secretValue));
        return true;
      },
    );
  });

  it("requires HTTPS callback and setup URLs in production", () => {
    assert.throws(
      () => loadServerConfig({
        NODE_ENV: "production",
        GITHUB_APP_CALLBACK_URL: "http://github-callback-secret-marker.invalid/callback",
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /GITHUB_APP_CALLBACK_URL/);
        assert.doesNotMatch(error.message, /secret-marker/);
        return true;
      },
    );
  });

  it("requires and validates a private key only for App JWT operations", () => {
    const config: ServerConfig = {
      ...testConfig,
      githubApp: { ...validGitHubConfig, privateKey: undefined },
    };
    assert.doesNotThrow(() => requireGitHubAppConfig(config, "user-authorization"));
    assert.throws(() => requireGitHubAppConfig(config, "app-jwt"), /GITHUB_APP_PRIVATE_KEY/);

    const malformedKeyConfig: ServerConfig = {
      ...testConfig,
      githubApp: { ...validGitHubConfig, privateKey: "private-key-secret-marker" },
    };
    assert.doesNotThrow(() => requireGitHubAppConfig(malformedKeyConfig, "user-authorization"));
    assert.throws(
      () => requireGitHubAppConfig(malformedKeyConfig, "app-jwt"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /GITHUB_APP_PRIVATE_KEY/);
        assert.doesNotMatch(error.message, /secret-marker/);
        return true;
      },
    );
  });
});

function authTestApp(
  fetchImpl: typeof fetch = async () => { throw new Error("Unexpected GitHub network request"); },
  configOverrides: Partial<ServerConfig> = {},
) {
  const database = openDatabase(":memory:");
  const config: ServerConfig = {
    ...testConfig,
    ...configOverrides,
    githubApp: validGitHubConfig,
  };
  const app = createServer({ config, database, fetchImpl });
  return { app, database };
}

function cookieValue(setCookie: string | string[] | undefined, name: string): string {
  const header = Array.isArray(setCookie) ? setCookie.find((item) => item.startsWith(`${name}=`)) : setCookie;
  assert.ok(header, `Expected ${name} cookie`);
  return header.split(";")[0].slice(name.length + 1);
}

describe("GitHub App user authorization routes", () => {
  it("redirects with state and an S256 PKCE challenge without exposing the verifier", async () => {
    const { app, database } = authTestApp();
    try {
      const response = await app.inject({ method: "GET", url: "/auth/github/start" });
      assert.equal(response.statusCode, 302);
      const location = new URL(response.headers.location!);
      assert.equal(location.origin + location.pathname, "https://github.com/login/oauth/authorize");
      assert.equal(location.searchParams.get("client_id"), validGitHubConfig.clientId);
      assert.equal(location.searchParams.get("redirect_uri"), validGitHubConfig.callbackUrl);
      assert.equal(location.searchParams.get("code_challenge_method"), "S256");
      assert.equal(location.searchParams.get("scope"), "offline_access");
      assert.equal(location.searchParams.get("code_verifier"), null);
      assert.equal(location.searchParams.get("state")?.length, 43);
      const cookies = Array.isArray(response.headers["set-cookie"])
        ? response.headers["set-cookie"] as string[]
        : [response.headers["set-cookie"] as string];
      assert.match(cookies.join("; "), /HttpOnly/);
      const row = database.prepare("SELECT * FROM oauth_states").get() as Record<string, unknown>;
      assert.equal(row.state_hash, createHash("sha256").update(location.searchParams.get("state")!).digest("hex"));
      const { decryptToken: decrypt } = await import("../src/auth/token-encryption.js");
      const verifier = decrypt(String(row.encrypted_code_verifier), validGitHubConfig.tokenEncryptionKey);
      assert.equal(createHash("sha256").update(verifier).digest("base64url"), location.searchParams.get("code_challenge"));
      assert.equal(row.browser_binding_hash, createHash("sha256").update(cookieValue(cookies, "pocketcode_oauth_binding")).digest("hex"));
    } finally { await app.close(); }
  });

  it("completes callback, persists identity/encrypted tokens, and issues a session cookie", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/access_token")) return Response.json({
        access_token: "github-access-secret", refresh_token: "github-refresh-secret",
        expires_in: 28800, refresh_token_expires_in: 15897600,
      });
      return Response.json({ id: 987654, login: "pocket-user", email: "private@example.com" });
    };
    const { app, database } = authTestApp(mockFetch, { frontendUrl: "http://localhost:5173" });
    try {
      const start = await app.inject({ method: "GET", url: "/auth/github/start" });
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      const cookies = Array.isArray(start.headers["set-cookie"])
        ? start.headers["set-cookie"] as string[]
        : [start.headers["set-cookie"] as string];
      const binding = cookieValue(cookies, "pocketcode_oauth_binding");
      const stateCookie = cookieValue(cookies, "pocketcode_oauth_state");
      const callback = await app.inject({
        method: "GET", url: `/auth/github/callback?code=temporary-code&state=${state}`,
        headers: { cookie: `pocketcode_oauth_binding=${binding}; pocketcode_oauth_state=${stateCookie}` },
      });
      assert.equal(callback.statusCode, 303);
      assert.equal(callback.headers.location, "http://localhost:5173/?auth=connected");
      const tokenBody = new URLSearchParams(String(calls[0].init?.body));
      assert.equal(tokenBody.get("code"), "temporary-code");
      assert.equal(tokenBody.get("code_verifier")?.length, 43);
      const authHeader = new Headers(calls[1].init?.headers).get("Authorization");
      assert.equal(authHeader, "Bearer github-access-secret");

      const user = database.prepare("SELECT id, github_user_id, github_username FROM users").get() as { id: string; github_user_id: string; github_username: string };
      assert.deepEqual({ github_user_id: user.github_user_id, github_username: user.github_username }, { github_user_id: "987654", github_username: "pocket-user" });
      const stored = database.prepare("SELECT * FROM github_connections WHERE user_id = ?").get(user.id) as { encrypted_access_token: string; encrypted_refresh_token: string; access_token_expires_at: string; refresh_token_expires_at: string };
      assert.equal(decryptToken(stored.encrypted_access_token, validGitHubConfig.tokenEncryptionKey), "github-access-secret");
      assert.equal(decryptToken(stored.encrypted_refresh_token, validGitHubConfig.tokenEncryptionKey), "github-refresh-secret");
      assert.ok(stored.access_token_expires_at);
      assert.ok(stored.refresh_token_expires_at);
      assert.equal(database.prepare("SELECT count(*) AS count FROM sessions").get()?.count, 1);
      const sessionCookie = (callback.headers["set-cookie"] as string[]).find((item) => item.startsWith("pocketcode_session="))!;
      assert.match(sessionCookie, /HttpOnly/);
      assert.match(sessionCookie, /SameSite=Lax/);
      assert.doesNotMatch(callback.body, /github-access-secret|github-refresh-secret/);
    } finally { await app.close(); }
  });

  it("rejects wrong, replayed, expired, and browser-mismatched state without calling GitHub", async () => {
    let fetchCount = 0;
    const { app, database } = authTestApp(async () => { fetchCount++; return Response.json({}); });
    try {
      const start = await app.inject({ method: "GET", url: "/auth/github/start" });
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      const cookies = start.headers["set-cookie"] as string[];
      const binding = cookieValue(cookies, "pocketcode_oauth_binding");
      const stateCookie = cookieValue(cookies, "pocketcode_oauth_state");
      const request = (providedState: string, cookieState: string, cookieBinding = binding) => app.inject({
        method: "GET", url: `/auth/github/callback?code=code&state=${providedState}`,
        headers: { cookie: `pocketcode_oauth_binding=${cookieBinding}; pocketcode_oauth_state=${cookieState}` },
      });
      assert.equal((await request("wrong", "wrong-cookie-state")).statusCode, 303);
      const expiredStart = await app.inject({ method: "GET", url: "/auth/github/start" });
      const expiredState = new URL(expiredStart.headers.location!).searchParams.get("state")!;
      const expiredCookies = expiredStart.headers["set-cookie"] as string[];
      const expiredHash = createHash("sha256").update(expiredState).digest("hex");
      database.prepare("UPDATE oauth_states SET expires_at = ? WHERE state_hash = ?").run("2000-01-01T00:00:00.000Z", expiredHash);
      assert.equal((await request(expiredState, expiredState, cookieValue(expiredCookies, "pocketcode_oauth_binding"))).statusCode, 303);
      const mismatchStart = await app.inject({ method: "GET", url: "/auth/github/start" });
      const mismatchState = new URL(mismatchStart.headers.location!).searchParams.get("state")!;
      const mismatchCookies = mismatchStart.headers["set-cookie"] as string[];
      assert.equal((await request(mismatchState, mismatchState, "wrong-binding")).statusCode, 303);
      const replayStart = await app.inject({ method: "GET", url: "/auth/github/start" });
      const replayState = new URL(replayStart.headers.location!).searchParams.get("state")!;
      const replayCookies = replayStart.headers["set-cookie"] as string[];
      const replayHeaders = { cookie: `pocketcode_oauth_binding=${cookieValue(replayCookies, "pocketcode_oauth_binding")}; pocketcode_oauth_state=${replayState}` };
      const callbackUrl = `/auth/github/callback?code=code&state=${replayState}`;
      assert.equal((await app.inject({ method: "GET", url: callbackUrl, headers: replayHeaders })).statusCode, 303);
      assert.equal((await app.inject({ method: "GET", url: callbackUrl, headers: replayHeaders })).statusCode, 303);
      assert.equal(fetchCount, 1);
    } finally { await app.close(); }
  });

  it("handles authorization cancellation and malformed token or identity responses safely", async () => {
    const { app } = authTestApp(async (input) => String(input).endsWith("/access_token")
      ? Response.json({ access_token: "" }) : Response.json({ id: 1 }));
    try {
      const start = await app.inject({ method: "GET", url: "/auth/github/start" });
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      const cookies = start.headers["set-cookie"] as string[];
      const cookieHeader = `pocketcode_oauth_binding=${cookieValue(cookies, "pocketcode_oauth_binding")}; pocketcode_oauth_state=${state}`;
      const canceled = await app.inject({ method: "GET", url: `/auth/github/callback?error=access_denied&state=${state}`, headers: { cookie: cookieHeader } });
      assert.equal(canceled.statusCode, 303);
      const malformed = await app.inject({ method: "GET", url: `/auth/github/callback?code=code&state=${state}`, headers: { cookie: cookieHeader } });
      assert.equal(malformed.statusCode, 303);
    } finally { await app.close(); }
  });

  it("rejects a malformed GitHub identity after a valid token exchange", async () => {
    let userRequestCount = 0;
    const { app, database } = authTestApp(async (input) => {
      if (String(input).endsWith("/access_token")) return Response.json({ access_token: "valid-test-access" });
      userRequestCount++;
      return Response.json({ id: "not-numeric", login: "" });
    }, { frontendUrl: "http://localhost:5173" });
    try {
      const start = await app.inject({ method: "GET", url: "/auth/github/start" });
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      const cookies = start.headers["set-cookie"] as string[];
      const cookie = `pocketcode_oauth_binding=${cookieValue(cookies, "pocketcode_oauth_binding")}; pocketcode_oauth_state=${state}`;
      const callback = await app.inject({ method: "GET", url: `/auth/github/callback?code=code&state=${state}`, headers: { cookie } });
      assert.equal(callback.statusCode, 303);
      assert.equal(callback.headers.location, "http://localhost:5173/?auth=failed");
      assert.equal(userRequestCount, 1);
      assert.equal(database.prepare("SELECT count(*) AS count FROM users").get()?.count, 0);
      assert.equal(database.prepare("SELECT count(*) AS count FROM github_connections").get()?.count, 0);
    } finally { await app.close(); }
  });

  it("does not expose configured secrets or OAuth values in callback output or logs", async () => {
    const secretMarker = "callback-secret-marker";
    const logs: string[] = [];
    const logger = {
      info: (...args: unknown[]) => logs.push(JSON.stringify(args)),
      warn: (...args: unknown[]) => logs.push(JSON.stringify(args)),
      error: (...args: unknown[]) => logs.push(JSON.stringify(args)),
      debug: () => undefined,
      trace: () => undefined,
      fatal: () => undefined,
      child: () => logger,
    };
    const database = openDatabase(":memory:");
    const app = createServer({
      config: { ...testConfig, githubApp: { ...validGitHubConfig, clientSecret: secretMarker } },
      database,
      fetchImpl: async () => { throw new Error(secretMarker); },
    });
    app.log = logger as never;
    try {
      const start = await app.inject({ method: "GET", url: "/auth/github/start" });
      const state = new URL(start.headers.location!).searchParams.get("state")!;
      const cookies = start.headers["set-cookie"] as string[];
      const cookie = `pocketcode_oauth_binding=${cookieValue(cookies, "pocketcode_oauth_binding")}; pocketcode_oauth_state=${state}`;
      const codeMarker = "one-time-code-secret-marker";
      const callback = await app.inject({ method: "GET", url: `/auth/github/callback?code=${codeMarker}&state=${state}`, headers: { cookie } });
      assert.equal(callback.statusCode, 303);
      assert.doesNotMatch(callback.body, new RegExp(`${secretMarker}|${codeMarker}|${state}`));
      assert.doesNotMatch(logs.join("\n"), new RegExp(`${secretMarker}|${codeMarker}|${state}`));
    } finally { await app.close(); }
  });

  it("returns minimal identity, rejects anonymous access, and enforces origin/CSRF on logout", async () => {
    const { app, database } = authTestApp();
    try {
      assert.equal((await app.inject({ method: "GET", url: "/auth/me" })).statusCode, 401);
      const userId = "auth-me-user";
      database.prepare("INSERT INTO users (id, github_user_id, github_username) VALUES (?, ?, ?)").run(userId, "123", "safe-name");
      const session = createSession(database, userId);
      const cookie = `pocketcode_session=${session.token}`;
      const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
      assert.equal(me.statusCode, 200);
      assert.deepEqual(me.json(), { user: { id: userId, githubUsername: "safe-name" }, githubConnected: false, csrfToken: me.json().csrfToken });
      assert.doesNotMatch(me.body, /github-access-secret|github-refresh-secret|encrypted_access_token|encrypted_refresh_token/i);
      assert.equal((await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, origin: "https://attacker.invalid", "x-csrf-token": me.json().csrfToken } })).statusCode, 403);
      assert.equal((await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, origin: testConfig.publicBaseUrl, "x-csrf-token": "wrong" } })).statusCode, 403);
      const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, origin: testConfig.publicBaseUrl, "x-csrf-token": me.json().csrfToken } });
      assert.equal(logout.statusCode, 204);
      assert.match(logout.headers["set-cookie"] as string, /Max-Age=0/);
      assert.equal((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode, 401);
    } finally { await app.close(); }
  });

  it("uses the configured frontend origin for authenticated logout CSRF checks", async () => {
    const { app, database } = authTestApp(undefined, { frontendUrl: "http://localhost:5173" });
    const userId = "frontend-origin-user";
    database.prepare("INSERT INTO users (id, github_user_id, github_username) VALUES (?, ?, ?)")
      .run(userId, "321", "frontend-user");
    const session = createSession(database, userId);
    const cookie = `pocketcode_session=${session.token}`;

    try {
      const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
      assert.equal(me.statusCode, 200);
      const csrfToken = me.json().csrfToken as string;
      assert.equal((await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { cookie, origin: testConfig.publicBaseUrl, "x-csrf-token": csrfToken },
      })).statusCode, 403);
      assert.equal((await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { cookie, origin: "http://localhost:5173", "x-csrf-token": csrfToken },
      })).statusCode, 204);
    } finally { await app.close(); }
  });
});

describe("GitHub App installation routes", () => {
  function installationApp(fetchImpl: typeof fetch = async () => { throw new Error("Unexpected mocked GitHub request"); }) {
    const database = openDatabase(":memory:");
    const userId = "installation-user";
    database.prepare("INSERT INTO users (id, github_user_id, github_username) VALUES (?, ?, ?)")
      .run(userId, "777", "installation-owner");
    const session = createSession(database, userId);
    const config: ServerConfig = { ...testConfig, githubApp: validGitHubConfig };
    return { app: createServer({ config, database, fetchImpl }), database, userId, session };
  }

  async function beginInstall(app: ReturnType<typeof createServer>, session: ReturnType<typeof createSession>) {
    const response = await app.inject({ method: "GET", url: "/api/github/install", headers: { cookie: `pocketcode_session=${session.token}` } });
    const redirect = new URL(response.headers.location!, "http://localhost");
    const state = redirect.searchParams.get("state")!;
    assert.equal(redirect.pathname, "/apps/pocketcode-test-app/installations/new");
    return { response, state };
  }

  function githubInstallResponse(overrides: Record<string, unknown> = {}) {
    return Response.json({
      id: 456, app_id: 12345, account: { id: 777, login: "installation-owner", type: "User" },
      repository_selection: "selected", suspended_at: null, ...overrides,
    });
  }

  it("redirects signed-in users to the fixed App installation URL and requires session", async () => {
    const { app, session, database } = installationApp();
    try {
      assert.equal((await app.inject({ method: "GET", url: "/api/github/install" })).statusCode, 401);
      const { response, state } = await beginInstall(app, session);
      assert.equal(response.statusCode, 302);
      assert.equal(state.length, 43);
      assert.equal(database.prepare("SELECT count(*) AS count FROM github_installation_states").get()?.count, 1);
      assert.equal(database.prepare("SELECT user_id FROM github_installation_states").get()?.user_id, "installation-user");
    } finally { await app.close(); }
  });

  it("verifies an installation, account ownership, app id and stores selected/all access idempotently", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input); requests.push(url);
      if (url.includes("/app/installations/")) return githubInstallResponse();
      if (url.endsWith("/user")) return Response.json({ id: 777, login: "installation-owner" });
      return Response.json({});
    };
    const { app, session, database } = installationApp(fetchImpl);
    try {
      database.prepare(`INSERT INTO github_connections
        (id, user_id, encrypted_access_token, updated_at) VALUES (?, ?, ?, ?)`)
        .run("connection-install", "installation-user", encryptToken("user-token", validGitHubConfig.tokenEncryptionKey!), new Date().toISOString());
      const { state } = await beginInstall(app, session);
      const callback = () => app.inject({ method: "GET", url: `/api/github/setup?installation_id=456&setup_action=install&state=${state}`, headers: { cookie: `pocketcode_session=${session.token}` } });
      assert.equal((await callback()).headers.location, "/?installation=connected");
      assert.equal((await callback()).headers.location, "/?installation=failed");
      assert.equal((database.prepare("SELECT count(*) AS count FROM github_installations").get() as { count: number }).count, 1);
      const saved = database.prepare("SELECT * FROM github_installations").get() as Record<string, unknown>;
      assert.equal(saved.installation_id, "456");
      assert.equal(saved.repository_selection, "selected");
      assert.equal(saved.account_login, "installation-owner");
      assert.equal(requests.filter((url) => url.includes("/app/installations/")).length, 1);
      assert.match(requests[0], /app\/installations\/456$/);
    } finally { await app.close(); }
  });

  it("rejects spoofed ids, wrong app, wrong account, and unbound setup state", async () => {
    const variants = [
      { response: githubInstallResponse({ app_id: 999 }), identity: { id: 777, login: "installation-owner" }, expected: "/?installation=unavailable" },
      { response: githubInstallResponse({ account: { id: 999, login: "other-user", type: "User" } }), identity: { id: 777, login: "installation-owner" } },
    ];
    for (const variant of variants) {
      const { app, session, database } = installationApp(async (input) => String(input).includes("/app/installations/")
        ? variant.response : Response.json(variant.identity));
      try {
        database.prepare(`INSERT INTO github_connections
          (id, user_id, encrypted_access_token, updated_at) VALUES (?, ?, ?, ?)`)
          .run("connection-install", "installation-user", encryptToken("user-token", validGitHubConfig.tokenEncryptionKey!), new Date().toISOString());
        const { state } = await beginInstall(app, session);
        const response = await app.inject({ method: "GET", url: `/api/github/setup?installation_id=456&setup_action=install&state=${state}`, headers: { cookie: `pocketcode_session=${session.token}` } });
        assert.equal(response.headers.location, variant.expected ?? "/?installation=failed");
        assert.equal((database.prepare("SELECT count(*) AS count FROM github_installations").get() as { count: number }).count, 0);
      } finally { await app.close(); }
    }

    const { app, session, database } = installationApp(async () => githubInstallResponse());
    try {
      database.prepare(`INSERT INTO github_connections
        (id, user_id, encrypted_access_token, updated_at) VALUES (?, ?, ?, ?)`)
        .run("connection-install", "installation-user", encryptToken("user-token", validGitHubConfig.tokenEncryptionKey!), new Date().toISOString());
      const { state } = await beginInstall(app, session);
      const callback = await app.inject({ method: "GET", url: `/api/github/setup?installation_id=456&state=${state}`, headers: { cookie: `pocketcode_session=${session.token}` } });
      assert.equal(callback.headers.location, "/?installation=unavailable");
      assert.equal(database.prepare("SELECT count(*) AS count FROM github_installation_states").get()?.count, 0);
    } finally { await app.close(); }
  });

  it("accepts active organization membership and handles suspension, cancellation and API failures", async () => {
    const orgFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/app/installations/")) return githubInstallResponse({ account: { id: 88, login: "trusted-org", type: "Organization" }, repository_selection: "all" });
      if (url.endsWith("/user")) return Response.json({ id: 777, login: "installation-owner" });
      if (url.includes("/orgs/trusted-org/members/installation-owner")) return Response.json({ state: "active" });
      return new Response("Not found", { status: 404 });
    };
    const { app, session, database } = installationApp(orgFetch);
    try {
      database.prepare(`INSERT INTO github_connections
        (id, user_id, encrypted_access_token, updated_at) VALUES (?, ?, ?, ?)`)
        .run("connection-install", "installation-user", encryptToken("user-token", validGitHubConfig.tokenEncryptionKey!), new Date().toISOString());
      const { state } = await beginInstall(app, session);
      const response = await app.inject({ method: "GET", url: `/api/github/setup?installation_id=456&state=${state}`, headers: { cookie: `pocketcode_session=${session.token}` } });
      assert.equal(response.headers.location, "/?installation=connected");
      const saved = database.prepare("SELECT repository_selection, account_type FROM github_installations").get() as { repository_selection: string; account_type: string };
      assert.deepEqual(saved, { repository_selection: "all", account_type: "Organization" });
    } finally { await app.close(); }

    const suspended = installationApp(async (input) => String(input).includes("/app/installations/")
      ? githubInstallResponse({ suspended_at: "2026-01-01T00:00:00Z" })
      : String(input).endsWith("/user") ? Response.json({ id: 777, login: "installation-owner" }) : Response.json({}));
    try {
      suspended.database.prepare(`INSERT INTO github_connections
        (id, user_id, encrypted_access_token, updated_at) VALUES (?, ?, ?, ?)`)
        .run("connection-install", "installation-user", encryptToken("user-token", validGitHubConfig.tokenEncryptionKey!), new Date().toISOString());
      const { state } = await beginInstall(suspended.app, suspended.session);
      const response = await suspended.app.inject({ method: "GET", url: `/api/github/setup?installation_id=456&state=${state}`, headers: { cookie: `pocketcode_session=${suspended.session.token}` } });
      assert.equal(response.headers.location, "/?installation=suspended");
      assert.equal((suspended.database.prepare("SELECT status FROM github_installations").get() as { status: string }).status, "suspended");
      const cancelStart = await beginInstall(suspended.app, suspended.session);
      const cancel = await suspended.app.inject({ method: "GET", url: `/api/github/setup?setup_action=cancel&state=${cancelStart.state}`, headers: { cookie: `pocketcode_session=${suspended.session.token}` } });
      assert.equal(cancel.headers.location, "/?installation=cancelled");
    } finally { await suspended.app.close(); }
  });

  it("does not reveal private keys, JWTs or API errors and prevents cross-user installation overwrite", async () => {
    const { app, session, database } = installationApp(async (input) => String(input).includes("/app/installations/")
      ? new Response("private-key-secret-marker", { status: 500 }) : Response.json({}));
    try {
      const { state } = await beginInstall(app, session);
      const response = await app.inject({ method: "GET", url: `/api/github/setup?installation_id=456&state=${state}`, headers: { cookie: `pocketcode_session=${session.token}` } });
      assert.equal(response.headers.location, "/?installation=unavailable");
      assert.doesNotMatch(response.body, /private-key-secret-marker|BEGIN PRIVATE KEY|eyJ/);

      database.prepare(`INSERT INTO github_installations
        (id, user_id, installation_id, account_id, account_login, account_type, repository_selection, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("record-other", "installation-user", "999", "7", "org", "Organization", "selected", "active");
      assert.equal((database.prepare("SELECT user_id FROM github_installations WHERE installation_id = ?").get("999") as { user_id: string }).user_id, "installation-user");
      assert.throws(() => database.prepare(`INSERT INTO github_installations
        (id, user_id, installation_id, account_id, account_login, account_type, repository_selection, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("record-cross-user", "different-user", "999", "7", "org", "Organization", "selected", "active"));
    } finally { await app.close(); }
  });
});