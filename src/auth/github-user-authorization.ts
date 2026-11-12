import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { GitHubAppConfig } from "../server/index.js";
import { consumeOAuthTransaction, createOAuthState } from "./oauth-state-service.js";
import {
  createSession,
  serializeOAuthBindingCookie,
  serializeSessionCookie,
  validateSession,
  revokeSession,
} from "./session-service.js";
import { encryptToken } from "./token-encryption.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const SESSION_COOKIE_NAME = "pocketcode_session";
const BINDING_COOKIE_NAME = "pocketcode_oauth_binding";
const STATE_COOKIE_NAME = "pocketcode_oauth_state";

function createCsrfToken(sessionId: string, encryptionKey: string): string {
  return createHmac("sha256", Buffer.from(encryptionKey, "hex"))
    .update(`pocketcode-csrf:${sessionId}`)
    .digest("base64url");
}

export interface GitHubAuthorizationDependencies {
  database: Database.Database;
  githubApp: GitHubAppConfig;
  frontendUrl: string;
  isProduction: boolean;
  fetchImpl?: typeof fetch;
  validateConfiguration: () => GitHubAppConfig;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

function clearCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

function safeFailure(reply: import("fastify").FastifyReply, secure: boolean, frontendUrl: string) {
  return reply
    .header("Set-Cookie", [clearCookie(BINDING_COOKIE_NAME, secure), clearCookie(STATE_COOKIE_NAME, secure)])
    .redirect(new URL("/?auth=failed", frontendUrl).toString(), 303);
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("GitHub request failed.");
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

export function registerGitHubUserAuthorizationRoutes(
  app: import("fastify").FastifyInstance,
  dependencies: GitHubAuthorizationDependencies,
): void {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const { database, isProduction } = dependencies;

  app.get("/auth/github/start", async (_request, reply) => {
    let configured: GitHubAppConfig;
    try {
      configured = dependencies.validateConfiguration();
    } catch {
      return reply.status(503).send({ error: "github_authorization_unavailable" });
    }
    const binding = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const encryptionKey = configured.tokenEncryptionKey!;
    const { state } = createOAuthState(database, {
      browserBinding: binding,
      codeVerifier: verifier,
      encryptionKey,
    });
    const authorize = new URL(GITHUB_AUTHORIZE_URL);
    authorize.searchParams.set("client_id", configured.clientId!);
    authorize.searchParams.set("redirect_uri", configured.callbackUrl!);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("scope", "offline_access");
    authorize.searchParams.set("allow_signup", "true");
    reply.header("Cache-Control", "no-store");
    reply.header("Set-Cookie", [
      serializeOAuthBindingCookie(binding, { secure: isProduction }),
      `${STATE_COOKIE_NAME}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${isProduction ? "; Secure" : ""}`,
    ]);
    return reply.redirect(authorize.toString(), 302);
  });

  app.get("/auth/github/callback", async (request, reply) => {
    let configured: GitHubAppConfig;
    try {
      configured = dependencies.validateConfiguration();
    } catch {
      return safeFailure(reply, isProduction, dependencies.frontendUrl);
    }
    const query = request.query as { code?: unknown; state?: unknown; error?: unknown };
    const cookies = parseCookies(request.headers.cookie);
    const receivedState = typeof query.state === "string" ? query.state : undefined;
    const cookieState = cookies.get(STATE_COOKIE_NAME);
    const transaction = consumeOAuthTransaction(
      database,
      receivedState,
      cookies.get(BINDING_COOKIE_NAME),
      configured.tokenEncryptionKey!,
    );
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    if (!transaction || !cookieState || receivedState !== cookieState) return safeFailure(reply, isProduction, dependencies.frontendUrl);
    if (query.error !== undefined || typeof query.code !== "string" || !query.code) {
      return safeFailure(reply, isProduction, dependencies.frontendUrl);
    }

    try {
      const tokenResponse = await fetchJson(fetchImpl, GITHUB_TOKEN_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: configured.clientId!,
          client_secret: configured.clientSecret!,
          code: query.code,
          redirect_uri: configured.callbackUrl!,
          code_verifier: transaction.codeVerifier,
        }).toString(),
      });
      if (typeof tokenResponse.access_token !== "string" || !tokenResponse.access_token) {
        return safeFailure(reply, isProduction, dependencies.frontendUrl);
      }
      const accessToken = tokenResponse.access_token;
      const identity = await fetchJson(fetchImpl, GITHUB_USER_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (
        (typeof identity.id !== "number" && typeof identity.id !== "string") ||
        !String(identity.id).match(/^\d+$/) ||
        typeof identity.login !== "string" || !identity.login.trim()
      ) return safeFailure(reply, isProduction, dependencies.frontendUrl);

      const githubUserId = String(identity.id);
      const username = identity.login;
      const now = new Date().toISOString();
      const expiresAt = typeof tokenResponse.expires_in === "number" && tokenResponse.expires_in > 0
        ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
        : null;
      const refreshExpiresAt = typeof tokenResponse.refresh_token_expires_in === "number" && tokenResponse.refresh_token_expires_in > 0
        ? new Date(Date.now() + tokenResponse.refresh_token_expires_in * 1000).toISOString()
        : null;
      const userId = randomUUID();
      const persist = database.transaction(() => {
        const existing = database.prepare("SELECT id FROM users WHERE github_user_id = ?")
          .get(githubUserId) as { id: string } | undefined;
        const id = existing?.id ?? userId;
        if (existing) {
          database.prepare("UPDATE users SET github_username = ?, updated_at = ? WHERE id = ?")
            .run(username, now, id);
        } else {
          database.prepare("INSERT INTO users (id, github_user_id, github_username) VALUES (?, ?, ?)")
            .run(id, githubUserId, username);
        }
        database.prepare(`
          INSERT INTO github_connections
            (id, user_id, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            encrypted_access_token = excluded.encrypted_access_token,
            encrypted_refresh_token = excluded.encrypted_refresh_token,
            access_token_expires_at = excluded.access_token_expires_at,
            refresh_token_expires_at = excluded.refresh_token_expires_at,
            updated_at = excluded.updated_at
        `).run(
          randomUUID(), id, encryptToken(accessToken, configured.tokenEncryptionKey),
          typeof tokenResponse.refresh_token === "string" ? encryptToken(tokenResponse.refresh_token, configured.tokenEncryptionKey) : null,
          expiresAt, refreshExpiresAt, now,
        );
        const session = createSession(database, id);
        return { id, session };
      });
      const { session } = persist();
      reply.header("Set-Cookie", [
        serializeSessionCookie(session.token, { secure: isProduction }),
        clearCookie(BINDING_COOKIE_NAME, isProduction),
        clearCookie(STATE_COOKIE_NAME, isProduction),
      ]);
      return reply.redirect(new URL("/?auth=connected", dependencies.frontendUrl).toString(), 303);
    } catch {
      request.log.warn("GitHub authorization callback failed");
      return safeFailure(reply, isProduction, dependencies.frontendUrl);
    }
  });

  app.get("/auth/me", async (request, reply) => {
    const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE_NAME);
    const session = validateSession(database, token);
    if (!session) return reply.status(401).send({ error: "unauthorized" });
    const user = database.prepare(`
      SELECT u.id, u.github_username AS githubUsername,
        EXISTS(SELECT 1 FROM github_connections g WHERE g.user_id = u.id) AS githubConnected
      FROM users u WHERE u.id = ?
    `).get(session.userId) as { id: string; githubUsername: string; githubConnected: number } | undefined;
    if (!user) return reply.status(401).send({ error: "unauthorized" });
    return {
      user: { id: user.id, githubUsername: user.githubUsername },
      githubConnected: user.githubConnected === 1,
      csrfToken: createCsrfToken(session.id, dependencies.githubApp.tokenEncryptionKey!),
    };
  });

  app.post("/auth/logout", async (request, reply) => {
    const origin = request.headers.origin;
    const expected = new URL(dependencies.frontendUrl).origin;
    if (!origin || origin !== expected) return reply.status(403).send({ error: "forbidden" });
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies.get(SESSION_COOKIE_NAME);
    const session = validateSession(database, token);
    if (!session || !token) return reply.status(401).send({ error: "unauthorized" });
    const csrf = request.headers["x-csrf-token"];
    const expectedCsrf = createCsrfToken(session.id, dependencies.githubApp.tokenEncryptionKey!);
    if (
      typeof csrf !== "string" || csrf.length !== expectedCsrf.length ||
      !timingSafeEqual(Buffer.from(csrf), Buffer.from(expectedCsrf))
    ) return reply.status(403).send({ error: "forbidden" });
    revokeSession(database, token);
    reply.header("Set-Cookie", clearCookie(SESSION_COOKIE_NAME, isProduction));
    return reply.status(204).send();
  });

}