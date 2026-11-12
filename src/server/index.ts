import Fastify, { type FastifyError } from "fastify";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../storage/database.js";
import { registerGitHubUserAuthorizationRoutes } from "../auth/github-user-authorization.js";
import { registerGitHubInstallationRoutes } from "../auth/github-installation-service.js";
import { registerGitHubRepositoryExplorerRoutes } from "../auth/github-repository-explorer.js";
import { registerAiProviderConfigurationRoutes } from "../auth/ai-provider-configuration.js";
import { registerWorkspaceRoutes } from "../workspaces/workspace-routes.js";
import { registerAgentRoutes } from "../agents/agent-routes.js";
import { WorkspaceService } from "../workspaces/workspace-service.js";
import { registerRepositoryBranchRoutes } from "../repositories/repository-branch-routes.js";
import { RepositoryBranchService } from "../repositories/repository-branch-service.js";

export interface ServerConfig {
  port: number;
  host: string;
  publicBaseUrl: string;
  frontendUrl?: string;
  isProduction?: boolean;
  githubApp?: GitHubAppConfig;
}

export interface GitHubAppConfig {
  clientId?: string;
  clientSecret?: string;
  slug?: string;
  appId?: string;
  privateKey?: string;
  callbackUrl?: string;
  setupUrl?: string;
  tokenEncryptionKey?: string;
}

export type GitHubAppOperation = "user-authorization" | "app-jwt";

const GITHUB_APP_ENV = {
  clientId: "GITHUB_APP_CLIENT_ID",
  clientSecret: "GITHUB_APP_CLIENT_SECRET",
  slug: "GITHUB_APP_SLUG",
  appId: "GITHUB_APP_ID",
  privateKey: "GITHUB_APP_PRIVATE_KEY",
  callbackUrl: "GITHUB_APP_CALLBACK_URL",
  setupUrl: "GITHUB_APP_SETUP_URL",
  tokenEncryptionKey: "TOKEN_ENCRYPTION_KEY",
} as const;

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function validateAbsoluteUrl(name: string, value: string, isProduction: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL${isProduction ? "." : " (HTTP is allowed in development)."}`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    (isProduction && parsed.protocol !== "https:")
  ) {
    throw new Error(`${name} must be an absolute ${isProduction ? "HTTPS" : "HTTP or HTTPS"} URL without credentials, query, or fragment.`);
  }
}

export function requireGitHubAppConfig(
  config: ServerConfig,
  operation: GitHubAppOperation,
): GitHubAppConfig {
  const github = config.githubApp ?? {};
  const required: Array<keyof GitHubAppConfig> = [
    "clientId", "clientSecret", "callbackUrl", "tokenEncryptionKey",
  ];
  if (operation === "app-jwt") required.push("appId", "privateKey", "slug");

  for (const key of required) {
    if (!github[key]) {
      const variable = GITHUB_APP_ENV[key];
      throw new Error(`Missing required GitHub App configuration: ${variable}.`);
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(github.clientId!)) {
    throw new Error(`${GITHUB_APP_ENV.clientId} has an invalid format.`);
  }
  if (github.slug && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(github.slug)) {
    throw new Error(`${GITHUB_APP_ENV.slug} has an invalid format.`);
  }
  if (!/^\d+$/.test(github.appId ?? "") && operation === "app-jwt") {
    throw new Error(`${GITHUB_APP_ENV.appId} must contain only digits.`);
  }
  if (!/^[\da-fA-F]{64}$/.test(github.tokenEncryptionKey!)) {
    throw new Error(`${GITHUB_APP_ENV.tokenEncryptionKey} must be 32 bytes encoded as 64 hexadecimal characters.`);
  }
  if (operation === "app-jwt" && !/^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/.test(github.privateKey!)) {
    throw new Error(`${GITHUB_APP_ENV.privateKey} must contain a PEM-encoded private key.`);
  }
  validateAbsoluteUrl(GITHUB_APP_ENV.callbackUrl, github.callbackUrl!, config.isProduction ?? false);
  if (github.setupUrl) {
    validateAbsoluteUrl(GITHUB_APP_ENV.setupUrl, github.setupUrl, config.isProduction ?? false);
  }
  return github;
}

export interface ServerOptions {
  config?: ServerConfig;
  database?: ReturnType<typeof openDatabase>;
  fetchImpl?: typeof fetch;
  workspaceRoot?: string;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const portValue = env.PORT?.trim() || "3000";
  if (!/^\d+$/.test(portValue)) {
    throw new Error("Invalid PORT: expected an integer between 1 and 65535.");
  }
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT: expected an integer between 1 and 65535.");
  }

  const host = env.HOST?.trim() || "127.0.0.1";
  if (/\s/.test(host)) {
    throw new Error("Invalid HOST: expected a hostname or IP address.");
  }

  const publicBaseUrl = env.PUBLIC_BASE_URL?.trim() || `http://localhost:${port}`;
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(publicBaseUrl);
  } catch {
    throw new Error("Invalid PUBLIC_BASE_URL: expected an absolute HTTP or HTTPS URL.");
  }
  if (
    !["http:", "https:"].includes(parsedBaseUrl.protocol) ||
    parsedBaseUrl.username ||
    parsedBaseUrl.password ||
    parsedBaseUrl.search ||
    parsedBaseUrl.hash
  ) {
    throw new Error("Invalid PUBLIC_BASE_URL: expected an absolute HTTP or HTTPS URL.");
  }

  const isProduction = env.NODE_ENV === "production";
  const frontendUrl = optionalTrimmed(env.FRONTEND_URL) ??
    (isProduction ? publicBaseUrl : "http://localhost:5173");
  const githubApp: GitHubAppConfig = {
    clientId: optionalTrimmed(env[GITHUB_APP_ENV.clientId]),
    clientSecret: optionalTrimmed(env[GITHUB_APP_ENV.clientSecret]),
    slug: optionalTrimmed(env[GITHUB_APP_ENV.slug]),
    appId: optionalTrimmed(env[GITHUB_APP_ENV.appId]),
    privateKey: optionalTrimmed(env[GITHUB_APP_ENV.privateKey]),
    callbackUrl: optionalTrimmed(env[GITHUB_APP_ENV.callbackUrl]),
    setupUrl: optionalTrimmed(env[GITHUB_APP_ENV.setupUrl]),
    tokenEncryptionKey: optionalTrimmed(env[GITHUB_APP_ENV.tokenEncryptionKey]),
  };
  for (const [name, value] of [
    [GITHUB_APP_ENV.callbackUrl, githubApp.callbackUrl],
    [GITHUB_APP_ENV.setupUrl, githubApp.setupUrl],
  ] as const) {
    if (value) validateAbsoluteUrl(name, value, isProduction);
  }
  validateAbsoluteUrl("FRONTEND_URL", frontendUrl, isProduction);

  return { port, host, publicBaseUrl, frontendUrl, isProduction, githubApp };
}

export function createServer(options: ServerOptions = {}) {
  const config = options.config ?? loadServerConfig();
  const database = options.database ?? openDatabase();
  const app = Fastify({
    logger: {
      redact: ["req.headers.authorization", "req.headers.cookie", "req.url"],
    },
  });

  app.get("/health", async () => ({
    status: "ok" as const,
    service: "pocketcode-api" as const,
  }));

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({
      statusCode: 404,
      error: "Not Found",
      message: "Not Found",
    }),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const candidateStatusCode = error.statusCode;
    const statusCode =
      typeof candidateStatusCode === "number" &&
      Number.isInteger(candidateStatusCode) &&
      candidateStatusCode >= 400 &&
      candidateStatusCode < 500
        ? candidateStatusCode
        : 500;
    request.log.error({ statusCode, errorName: error.name }, "Request failed");

    const isProduction = config.isProduction ?? process.env.NODE_ENV === "production";
    const message = statusCode >= 500 || isProduction ? "Request failed" : error.message;
    return reply.status(statusCode).send({
      statusCode,
      error: statusCode >= 500 ? "Internal Server Error" : "Client Error",
      message,
    });
  });

  app.addHook("onClose", async () => {
    database.close();
  });

  registerGitHubUserAuthorizationRoutes(app, {
    database,
    githubApp: config.githubApp ?? {},
    frontendUrl: config.frontendUrl ?? config.publicBaseUrl,
    isProduction: config.isProduction ?? process.env.NODE_ENV === "production",
    fetchImpl: options.fetchImpl,
    validateConfiguration: () => requireGitHubAppConfig(config, "user-authorization"),
  });
  registerGitHubInstallationRoutes(app, {
    database,
    config,
    fetchImpl: options.fetchImpl,
    validateConfiguration: () => requireGitHubAppConfig(config, "app-jwt"),
  });
  registerGitHubRepositoryExplorerRoutes(app, {
    database,
    fetchImpl: options.fetchImpl,
    validateConfiguration: () => requireGitHubAppConfig(config, "app-jwt"),
  });
  const repositoryBranchService = new RepositoryBranchService(database, options.fetchImpl);
  registerRepositoryBranchRoutes(app, {
    database,
    config,
    validateConfiguration: () => requireGitHubAppConfig(config, "app-jwt"),
    service: repositoryBranchService,
  });
  registerAiProviderConfigurationRoutes(app, {
    database,
    config,
    encryptionKey: config.githubApp?.tokenEncryptionKey,
  });
  const workspaceService = new WorkspaceService(database, { rootDirectory: options.workspaceRoot });
  app.addHook("onClose", async () => { workspaceService.shutdownCleanup(); });
  registerWorkspaceRoutes(app, {
    database,
    config,
    fetchImpl: options.fetchImpl,
    validateConfiguration: () => requireGitHubAppConfig(config, "app-jwt"),
    service: workspaceService,
    repositoryBranches: repositoryBranchService,
    ownsService: true,
  });
  registerAgentRoutes(app, { database, config, workspace: workspaceService!, encryptionKey: config.githubApp?.tokenEncryptionKey });

  return app;
}

export async function startServer(): Promise<void> {
  // Keep dotenv loading in the executable startup path, not module import or tests.
  await import("dotenv/config");
  const config = loadServerConfig();
  const app = createServer({ config });

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    await app.close();
    throw error;
  }
  app.log.info(
    { host: config.host, port: config.port, publicBaseUrl: config.publicBaseUrl },
    "PocketCode API listening",
  );

  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    app.log.info({ signal }, "Shutting down PocketCode API");
    try {
      await app.close();
      app.log.info("PocketCode API stopped");
    } catch {
      app.log.error("PocketCode API shutdown failed");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown startup error";
    console.error(`PocketCode API startup failed: ${message}`);
    process.exitCode = 1;
  });
}
