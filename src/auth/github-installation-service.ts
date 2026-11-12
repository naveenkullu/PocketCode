import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GitHubAppConfig, ServerConfig } from "../server/index.js";
import { createGitHubInstallationToken, fetchAuthenticatedGitHubIdentity, fetchVerifiedInstallation, GitHubAppApiError } from "./github-app-auth.js";
import { getGitHubUserAccessToken, GitHubTokenError } from "./github-user-token-service.js";
import { validateSession } from "./session-service.js";

const SESSION_COOKIE = "pocketcode_session";

export interface GitHubInstallationRouteDependencies {
  database: Database.Database;
  config: ServerConfig;
  fetchImpl?: typeof fetch;
  validateConfiguration: () => GitHubAppConfig;
}

function cookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of header?.split(";") ?? []) {
    const index = item.indexOf("=");
    if (index > 0) result.set(item.slice(0, index).trim(), item.slice(index + 1).trim());
  }
  return result;
}

function requireUser(request: FastifyRequest, dependencies: GitHubInstallationRouteDependencies): string | null {
  const token = cookies(request.headers.cookie).get(SESSION_COOKIE);
  const session = validateSession(dependencies.database, token);
  return session?.userId ?? null;
}

function safeRedirect(reply: FastifyReply, location: string) {
  return reply.header("Cache-Control", "no-store").redirect(location, 303);
}

export function registerGitHubInstallationRoutes(
  app: FastifyInstance,
  dependencies: GitHubInstallationRouteDependencies,
): void {
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  app.get("/api/github/install", async (request, reply) => {
    const userId = requireUser(request, dependencies);
    if (!userId) return reply.status(401).send({ error: "unauthorized" });
    try {
      const config = dependencies.validateConfiguration();
      if (!config.slug) return reply.status(503).send({ error: "github_installation_unavailable" });
      const installUrl = new URL(`https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`);
      const csrfState = randomBytes(32).toString("base64url");
      const stateHash = createHash("sha256").update(csrfState).digest("hex");
      dependencies.database.prepare("INSERT INTO github_installation_states (state_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(stateHash, userId, new Date(Date.now() + 10 * 60_000).toISOString());
      installUrl.searchParams.set("state", csrfState);
      installUrl.searchParams.set("redirect_uri", config.setupUrl ?? new URL("/api/github/setup", dependencies.config.publicBaseUrl).toString());
      return reply.redirect(installUrl.toString(), 302);
    } catch {
      request.log.warn("GitHub installation configuration unavailable");
      return reply.status(503).send({ error: "github_installation_unavailable" });
    }
  });

  app.get("/api/github/setup", async (request, reply) => {
    const userId = requireUser(request, dependencies);
    if (!userId) return reply.status(401).send({ error: "unauthorized" });
    const query = request.query as { installation_id?: unknown; setup_action?: unknown; state?: unknown };
    if (typeof query.state !== "string") return safeRedirect(reply, "/?installation=failed");
    const stateHash = createHash("sha256").update(query.state).digest("hex");
    const stateRow = dependencies.database.prepare(`DELETE FROM github_installation_states
      WHERE state_hash = ? AND user_id = ? AND expires_at > ? RETURNING user_id`)
      .get(stateHash, userId, new Date().toISOString()) as { user_id: string } | undefined;
    if (!stateRow) return safeRedirect(reply, "/?installation=failed");
    if (query.setup_action === "cancel") return safeRedirect(reply, "/?installation=cancelled");
    if (typeof query.installation_id !== "string" || !/^\d+$/.test(query.installation_id)) {
      return safeRedirect(reply, "/?installation=failed");
    }
    try {
      const appConfig = dependencies.validateConfiguration();
      const verified = await fetchVerifiedInstallation(query.installation_id, appConfig, fetchImpl);
      if (verified.appId !== appConfig.appId) return safeRedirect(reply, "/?installation=failed");
      const userToken = await getGitHubUserAccessToken({
        database: dependencies.database,
        userId,
        clientId: appConfig.clientId!,
        clientSecret: appConfig.clientSecret!,
        encryptionKey: appConfig.tokenEncryptionKey!,
        fetchImpl,
      });
      const identity = await fetchAuthenticatedGitHubIdentity(userToken, fetchImpl);
      const installationBelongsToUser = verified.accountType === "User" && verified.accountId === identity.id;
      const organizationIsAuthorized = verified.accountType === "Organization" &&
        (await checkOrganizationRelationship(identity.login, verified.accountLogin, userToken, fetchImpl));
      if (!installationBelongsToUser && !organizationIsAuthorized) {
        return safeRedirect(reply, "/?installation=failed");
      }

      const status = verified.suspended ? "suspended" : "active";
      dependencies.database.prepare(`
        INSERT INTO github_installations
          (id, user_id, installation_id, account_id, account_login, account_type, repository_selection, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          account_id = excluded.account_id,
          account_login = excluded.account_login,
          account_type = excluded.account_type,
          repository_selection = excluded.repository_selection,
          status = excluded.status,
          updated_at = excluded.updated_at
        WHERE github_installations.user_id = excluded.user_id
      `).run(randomUUID(), userId, verified.installationId, verified.accountId, verified.accountLogin,
        verified.accountType, verified.repositorySelection, status, new Date().toISOString());
      const saved = dependencies.database.prepare("SELECT user_id AS userId FROM github_installations WHERE installation_id = ?")
        .get(verified.installationId) as { userId: string } | undefined;
      if (saved?.userId !== userId) return safeRedirect(reply, "/?installation=failed");
      return safeRedirect(reply, `/?installation=${status === "suspended" ? "suspended" : "connected"}`);
    } catch (error) {
      if (error instanceof GitHubTokenError && error.code === "github_reconnect_required") {
        return safeRedirect(reply, "/?installation=reconnect");
      }
      if (error instanceof GitHubAppApiError && error.code === "not_found") {
        return safeRedirect(reply, "/?installation=unavailable");
      }
      request.log.warn("GitHub installation verification failed");
      return safeRedirect(reply, "/?installation=unavailable");
    }
  });

  app.get("/api/github/repositories", async (request, reply) => {
    const userId = requireUser(request, dependencies);
    if (!userId) return reply.status(401).send({ error: "unauthorized" });
    let appConfig: GitHubAppConfig;
    try { appConfig = dependencies.validateConfiguration(); }
    catch (error) {
      const code = error instanceof Error && error.message.startsWith("Missing required GitHub App configuration:")
        ? "github_app_configuration_missing"
        : "github_app_configuration_invalid";
      request.log.warn({ code }, "GitHub repository listing configuration is unavailable");
      return reply.header("Cache-Control", "no-store").status(503).send({ error: code });
    }
    const userInstallations = dependencies.database.prepare(`
      SELECT installation_id AS installationId, status FROM github_installations
      WHERE user_id = ? ORDER BY installation_id
    `).all(userId) as Array<{ installationId: string; status: string }>;
    const installations = userInstallations.filter((installation) => installation.status === "active");
    if (installations.length === 0) {
      if (userInstallations.some((installation) => installation.status === "suspended")) {
        return reply.header("Cache-Control", "no-store").status(403).send({ error: "github_installation_suspended" });
      }
      return reply.header("Cache-Control", "no-store").status(409).send({ error: "github_installation_required" });
    }
    const repositories = new Map<string, Record<string, unknown>>();
    try {
      for (const { installationId } of installations) {
        const verified = await fetchVerifiedInstallation(installationId, appConfig, fetchImpl);
        if (verified.suspended) {
          return reply.header("Cache-Control", "no-store").status(403).send({ error: "github_installation_suspended" });
        }
        const token = await createGitHubInstallationToken(installationId, appConfig, fetchImpl);
        for (let page = 1; page <= 100; page++) {
          const response = await fetchImpl(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, {
            headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
            signal: AbortSignal.timeout(10_000),
          });
          if (response.status === 429 || response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
            throw new GitHubAppApiError("rate_limited");
          }
          if (response.status === 404 || response.status === 401) throw new GitHubAppApiError("not_found");
          if (response.status === 403) throw new GitHubAppApiError("permission_denied");
          if (!response.ok) throw new GitHubAppApiError("unavailable");
          let body: unknown;
          try { body = await response.json(); } catch { throw new GitHubAppApiError("invalid_response"); }
          if (!isRecord(body) || !Array.isArray(body.repositories)) throw new GitHubAppApiError("invalid_response");
          for (const repository of body.repositories) {
            if (!isRecord(repository) || !isRecord(repository.owner) ||
                !validRepositoryId(repository.id) || typeof repository.name !== "string" ||
                typeof repository.full_name !== "string" || typeof repository.owner.login !== "string" ||
                typeof repository.private !== "boolean" || typeof repository.html_url !== "string" ||
                !(repository.default_branch === null || typeof repository.default_branch === "string") ||
                !isRecord(repository.permissions)) throw new GitHubAppApiError("invalid_response");
            const key = String(repository.id);
            const previous = repositories.get(key);
            const permissions = {
              read: repository.permissions.pull === true || repository.permissions.push === true || repository.permissions.admin === true,
              write: repository.permissions.push === true || repository.permissions.admin === true,
            };
            repositories.set(key, {
              id: key, name: repository.name, fullName: repository.full_name,
              ownerLogin: repository.owner.login, private: repository.private,
              defaultBranch: repository.default_branch, htmlUrl: repository.html_url,
              installationId: previous?.installationId ?? installationId,
              permissions: {
                read: permissions.read || (previous?.permissions as { read: boolean } | undefined)?.read === true,
                write: permissions.write || (previous?.permissions as { write: boolean } | undefined)?.write === true,
              },
            });
          }
          if (body.repositories.length < 100) break;
          if (page === 100) throw new GitHubAppApiError("unavailable");
        }
      }
      return reply.header("Cache-Control", "no-store").send({ repositories: [...repositories.values()] });
    } catch (error) {
      const cause = error instanceof GitHubAppApiError ? error.code : "unavailable";
      const code = cause === "rate_limited" ? "github_rate_limited"
        : cause === "permission_denied" ? "github_insufficient_permissions"
          : cause === "not_found" ? "github_installation_unavailable"
            : cause === "invalid_response" ? "github_invalid_response"
              : "github_repositories_unavailable";
      request.log.warn({ code }, "GitHub repository listing failed");
      const status = cause === "rate_limited" ? 429
        : cause === "permission_denied" ? 403
          : cause === "not_found" ? 409
            : cause === "invalid_response" ? 502
              : 503;
      return reply.header("Cache-Control", "no-store").status(status).send({ error: code });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRepositoryId(value: unknown): boolean {
  return (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" && /^\d+$/.test(value));
}

async function checkOrganizationRelationship(
  username: string,
  organization: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/orgs/${encodeURIComponent(organization)}/members/${encodeURIComponent(username)}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new GitHubAppApiError("unavailable"); }
  if (!response.ok) return false;
  let membership: unknown;
  try { membership = await response.json(); } catch { throw new GitHubAppApiError("invalid_response"); }
  if (typeof membership !== "object" || membership === null || !("state" in membership)) return false;
  return membership.state === "active";
}