import { createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GitHubAppConfig, ServerConfig } from "../server/index.js";
import { validateSession } from "../auth/session-service.js";
import { RepositoryBranchError, RepositoryBranchService } from "./repository-branch-service.js";

interface Dependencies {
  database: Database.Database;
  config: ServerConfig;
  validateConfiguration: () => GitHubAppConfig;
  service: RepositoryBranchService;
}

function cookie(header: string | undefined): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === "pocketcode_session") return part.slice(index + 1).trim();
  }
  return undefined;
}

function session(request: FastifyRequest, database: Database.Database) {
  return validateSession(database, cookie(request.headers.cookie));
}

function csrfValid(request: FastifyRequest, sessionId: string, key: string, config: ServerConfig): boolean {
  const origin = request.headers.origin;
  const supplied = request.headers["x-csrf-token"];
  const expected = createHmac("sha256", Buffer.from(key, "hex"))
    .update(`pocketcode-csrf:${sessionId}`).digest("base64url");
  return typeof origin === "string" && origin === new URL(config.frontendUrl ?? config.publicBaseUrl).origin &&
    typeof supplied === "string" && supplied.length === expected.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function registerRepositoryBranchRoutes(app: FastifyInstance, dependencies: Dependencies): void {
  const key = dependencies.config.githubApp?.tokenEncryptionKey;

  app.get("/api/repository-connections/:repositoryId", async (request, reply) => {
    const authenticated = session(request, dependencies.database);
    if (!authenticated) return reply.header("Cache-Control", "no-store").status(401).send({ error: "unauthorized" });
    const repositoryId = (request.params as { repositoryId?: unknown }).repositoryId;
    if (typeof repositoryId !== "string" || !/^\d{1,20}$/.test(repositoryId)) {
      return reply.header("Cache-Control", "no-store").status(400).send({ error: "invalid_repository_id" });
    }
    try {
      const config = dependencies.validateConfiguration();
      const connection = await dependencies.service.get(authenticated.userId, repositoryId, config);
      return reply.header("Cache-Control", "no-store").send({ connection });
    } catch (error) {
      const status = error instanceof RepositoryBranchError ? error.statusCode : 503;
      const code = error instanceof RepositoryBranchError ? error.code : "repository_branch_unavailable";
      request.log.warn({ code }, "Repository branch lookup failed");
      return reply.header("Cache-Control", "no-store").status(status).send({ error: code });
    }
  });

  app.post("/api/repository-connections", async (request, reply) => {
    const authenticated = session(request, dependencies.database);
    if (!authenticated) return reply.header("Cache-Control", "no-store").status(401).send({ error: "unauthorized" });
    if (!key || !/^[\da-fA-F]{64}$/.test(key) || !csrfValid(request, authenticated.id, key, dependencies.config)) {
      return reply.header("Cache-Control", "no-store").status(403).send({ error: "forbidden" });
    }
    const body = request.body as { repositoryId?: unknown; confirmed?: unknown } | null;
    if (!body || typeof body.repositoryId !== "string" || !/^\d{1,20}$/.test(body.repositoryId)) {
      return reply.header("Cache-Control", "no-store").status(400).send({ error: "invalid_repository_id" });
    }
    try {
      const config = dependencies.validateConfiguration();
      const connection = await dependencies.service.provision(
        authenticated.userId, body.repositoryId, config, body.confirmed === true,
      );
      return reply.header("Cache-Control", "no-store").status(200).send({ connection });
    } catch (error) {
      const status = error instanceof RepositoryBranchError ? error.statusCode : 503;
      const code = error instanceof RepositoryBranchError ? error.code : "repository_branch_unavailable";
      request.log.warn({ code }, "Repository branch provisioning failed");
      return reply.header("Cache-Control", "no-store").status(status).send({ error: code });
    }
  });
}
