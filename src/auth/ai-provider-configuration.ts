import { createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerConfig } from "../server/index.js";
import { decryptToken, encryptToken } from "./token-encryption.js";
import { validateSession } from "./session-service.js";

import { BUILT_IN_PROVIDER_IDS } from "@cline/llms";

const SDK_PROVIDER_IDS = new Set<string>(BUILT_IN_PROVIDER_IDS);

export const AI_PROVIDERS = [
  { id: "gemini", name: "Google Gemini", sdkProviderId: "gemini" },
  { id: "openai", name: "OpenAI", sdkProviderId: "openai-compatible" },
  { id: "anthropic", name: "Anthropic", sdkProviderId: "anthropic" },
  { id: "groq", name: "Groq", sdkProviderId: "groq" },
  { id: "openrouter", name: "OpenRouter", sdkProviderId: "openrouter" },
] as const;

export type AiProviderId = (typeof AI_PROVIDERS)[number]["id"];
type SdkProviderId = (typeof AI_PROVIDERS)[number]["sdkProviderId"];

if (AI_PROVIDERS.some(({ sdkProviderId }) => !SDK_PROVIDER_IDS.has(sdkProviderId))) {
  throw new Error("PocketCode AI provider configuration does not match the installed Cline SDK.");
}

interface Dependencies {
  database: Database.Database;
  config: ServerConfig;
  encryptionKey?: string;
}

interface ProviderSettingsRow { providerId: SdkProviderId; modelId: string }
interface CredentialRow { providerId: SdkProviderId }
const SESSION_COOKIE = "pocketcode_session";
const MAX_API_KEY_LENGTH = 8192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index > 0) result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}

function authenticatedUser(request: FastifyRequest, database: Database.Database): { userId: string; sessionId: string } | null {
  const session = validateSession(database, cookies(request.headers.cookie).get(SESSION_COOKIE));
  return session ? { userId: session.userId, sessionId: session.id } : null;
}

function csrfToken(sessionId: string, key: string): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`pocketcode-csrf:${sessionId}`).digest("base64url");
}

function expectedOrigin(config: ServerConfig): string {
  return new URL(config.frontendUrl ?? config.publicBaseUrl).origin;
}

function validCsrf(request: FastifyRequest, sessionId: string, key: string, config: ServerConfig): boolean {
  const origin = request.headers.origin;
  const supplied = request.headers["x-csrf-token"];
  const expected = csrfToken(sessionId, key);
  return typeof origin === "string" && origin === expectedOrigin(config) &&
    typeof supplied === "string" && supplied.length === expected.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function provider(value: unknown): (typeof AI_PROVIDERS)[number] | undefined {
  return AI_PROVIDERS.find((entry) => entry.id === value);
}

function validModelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/[\0\r\n]/.test(value);
}

function currentConfiguration(database: Database.Database, userId: string) {
  const settings = database.prepare(`SELECT provider_id AS providerId, model_id AS modelId
    FROM user_ai_provider_settings WHERE user_id = ?`).get(userId) as ProviderSettingsRow | undefined;
  const credentials = database.prepare(`SELECT provider_id AS providerId
    FROM user_ai_provider_credentials WHERE user_id = ?`).all(userId) as CredentialRow[];
  const credentialProviders = new Set(credentials.map(({ providerId }) => providerId));
  return {
    selected: settings ? {
      providerId: AI_PROVIDERS.find((entry) => entry.sdkProviderId === settings.providerId)!.id,
      modelId: settings.modelId,
    } : null,
    credentials: AI_PROVIDERS.map((entry) => ({ providerId: entry.id, configured: credentialProviders.has(entry.sdkProviderId) })),
  };
}

function keyFor(dependencies: Dependencies): string | undefined {
  return dependencies.encryptionKey ?? dependencies.config.githubApp?.tokenEncryptionKey;
}

function invalidateAgentSessions(database: Database.Database, userId: string): void {
  database.prepare(`DELETE FROM agent_messages
    WHERE session_id IN (SELECT id FROM agent_sessions WHERE user_id = ?)`).run(userId);
  database.prepare("DELETE FROM agent_sessions WHERE user_id = ?").run(userId);
}

export function registerAiProviderConfigurationRoutes(app: FastifyInstance, dependencies: Dependencies): void {
  const { database } = dependencies;

  app.get("/api/ai/providers", async (_request, reply) => reply.header("Cache-Control", "no-store").send({
    providers: AI_PROVIDERS.map(({ id, name, sdkProviderId }) => ({
      id, name, sdkProviderId, modelIds: null, modelSelection: "user_supplied",
    })),
    modelIdsNote: "The installed SDK supports provider configuration but does not define a fixed selectable model catalog here. Model IDs are supplied by the user and validated for format only; availability is provider-dependent.",
  }));

  app.get("/api/ai/configuration", async (request, reply) => {
    const session = authenticatedUser(request, database);
    if (!session) return reply.status(401).send({ error: "unauthorized" });
    return reply.header("Cache-Control", "no-store").send(currentConfiguration(database, session.userId));
  });

  app.put("/api/ai/configuration", async (request, reply) => {
    const session = authenticatedUser(request, database);
    if (!session) return reply.status(401).send({ error: "unauthorized" });
    const key = keyFor(dependencies);
    if (!key || !/^[\da-fA-F]{64}$/.test(key)) return reply.status(503).send({ error: "credential_storage_unavailable" });
    if (!validCsrf(request, session.sessionId, key, dependencies.config)) return reply.status(403).send({ error: "forbidden" });

    const body: unknown = request.body;
    if (!isRecord(body)) return reply.status(400).send({ error: "invalid_request" });
    const selectedProvider = provider(body.providerId);
    if (!selectedProvider || !validModelId(body.modelId)) return reply.status(400).send({ error: "invalid_provider_or_model" });

    database.prepare(`INSERT INTO user_ai_provider_settings (user_id, provider_id, model_id, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET provider_id = excluded.provider_id,
      model_id = excluded.model_id, updated_at = excluded.updated_at`)
      .run(session.userId, selectedProvider.sdkProviderId, body.modelId, new Date().toISOString());
    return reply.header("Cache-Control", "no-store").send(currentConfiguration(database, session.userId));
  });

  app.put("/api/ai/credentials/:providerId", async (request, reply) => {
    const session = authenticatedUser(request, database);
    if (!session) return reply.status(401).send({ error: "unauthorized" });
    const key = keyFor(dependencies);
    if (!key || !/^[\da-fA-F]{64}$/.test(key)) return reply.status(503).send({ error: "credential_storage_unavailable" });
    if (!validCsrf(request, session.sessionId, key, dependencies.config)) return reply.status(403).send({ error: "forbidden" });
    const route = request.params as { providerId?: string };
    const selectedProvider = provider(route.providerId);
    const body: unknown = request.body;
    if (!selectedProvider || !isRecord(body) || typeof body.apiKey !== "string" ||
        body.apiKey.length === 0 || body.apiKey.length > MAX_API_KEY_LENGTH || body.apiKey.trim() !== body.apiKey || /[\0\r\n]/.test(body.apiKey)) {
      return reply.status(400).send({ error: "invalid_provider_or_credential" });
    }

    const encrypted = encryptToken(body.apiKey, key);
    database.transaction(() => {
      invalidateAgentSessions(database, session.userId);
      database.prepare(`INSERT INTO user_ai_provider_credentials (user_id, provider_id, encrypted_api_key, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(user_id, provider_id) DO UPDATE SET encrypted_api_key = excluded.encrypted_api_key,
        updated_at = excluded.updated_at`)
        .run(session.userId, selectedProvider.sdkProviderId, encrypted, new Date().toISOString());
    })();
    return reply.header("Cache-Control", "no-store").send({ providerId: selectedProvider.id, configured: true });
  });

  app.delete("/api/ai/credentials/:providerId", async (request, reply) => {
    const session = authenticatedUser(request, database);
    if (!session) return reply.status(401).send({ error: "unauthorized" });
    const key = keyFor(dependencies);
    if (!key || !/^[\da-fA-F]{64}$/.test(key)) return reply.status(503).send({ error: "credential_storage_unavailable" });
    if (!validCsrf(request, session.sessionId, key, dependencies.config)) return reply.status(403).send({ error: "forbidden" });
    const route = request.params as { providerId?: string };
    const selectedProvider = provider(route.providerId);
    if (!selectedProvider) return reply.status(400).send({ error: "invalid_provider" });
    database.transaction(() => {
      invalidateAgentSessions(database, session.userId);
      database.prepare("DELETE FROM user_ai_provider_credentials WHERE user_id = ? AND provider_id = ?")
        .run(session.userId, selectedProvider.sdkProviderId);
    })();
    return reply.header("Cache-Control", "no-store").send({ providerId: selectedProvider.id, configured: false });
  });
}

export function decryptUserAiCredential(
  database: Database.Database,
  userId: string,
  providerId: AiProviderId,
  encryptionKey: string,
): string | null {
  const selected = provider(providerId)!;
  const row = database.prepare(`SELECT encrypted_api_key AS encryptedApiKey FROM user_ai_provider_credentials
    WHERE user_id = ? AND provider_id = ?`).get(userId, selected.sdkProviderId) as { encryptedApiKey: string } | undefined;
  return row ? decryptToken(row.encryptedApiKey, encryptionKey) : null;
}

/** Resolve only the authenticated user's selected provider configuration for backend runtime use. */
export function resolveUserAiConfiguration(database: Database.Database, userId: string, encryptionKey: string) {
  const row = database.prepare(`SELECT provider_id AS providerId, model_id AS modelId
    FROM user_ai_provider_settings WHERE user_id = ?`).get(userId) as ProviderSettingsRow | undefined;
  if (!row) return null;
  const entry = AI_PROVIDERS.find((item) => item.sdkProviderId === row.providerId);
  if (!entry) return null;
  const apiKey = decryptUserAiCredential(database, userId, entry.id, encryptionKey);
  return apiKey ? { providerId: row.providerId, modelId: row.modelId, apiKey } : { providerId: row.providerId, modelId: row.modelId, apiKey: null };
}