import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createSession } from "../src/auth/session-service.js";
import { decryptUserAiCredential } from "../src/auth/ai-provider-configuration.js";
import { openDatabase } from "../src/storage/database.js";
import { createServer, type ServerConfig } from "../src/server/index.js";

const KEY = "0123456789abcdef".repeat(4);
const providerConfig: ServerConfig = { port: 3000, host: "127.0.0.1", publicBaseUrl: "http://127.0.0.1:3000" };
const SECRET_MARKER = "fake-test-key-never-return-this";

function fixture(encryptionKey: string | undefined | null = KEY) {
  const database = openDatabase(":memory:");
  const userId = randomUUID();
  database.prepare("INSERT INTO users (id, github_username) VALUES (?, ?)").run(userId, `test-${userId}`);
  const session = createSession(database, userId);
  const app = createServer({
    config: { ...providerConfig, githubApp: encryptionKey === null ? {} : { tokenEncryptionKey: encryptionKey } },
    database,
  });
  const sessionId = (database.prepare("SELECT id FROM sessions WHERE user_id = ?").get(userId) as { id: string }).id;
  const csrf = encryptionKey && /^[\da-fA-F]{64}$/.test(encryptionKey)
    ? createHmac("sha256", Buffer.from(encryptionKey, "hex")).update(`pocketcode-csrf:${sessionId}`).digest("base64url")
    : "invalid";
  const headers = { cookie: `pocketcode_session=${session.token}`, origin: providerConfig.publicBaseUrl, "x-csrf-token": csrf };
  return { app, database, userId, session, headers };
}

describe("BYOK provider configuration", () => {
  it("advertises the supported providers without claiming a fixed model catalog", async () => {
    const { app } = fixture();
    try {
      const response = await app.inject({ method: "GET", url: "/api/ai/providers" });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().providers.map((item: { id: string }) => item.id), ["gemini", "openai", "anthropic", "groq", "openrouter"]);
      assert.deepEqual(response.json().providers.map((item: { sdkProviderId: string }) => item.sdkProviderId), ["gemini", "openai-compatible", "anthropic", "groq", "openrouter"]);
      assert.equal(response.json().providers.every((item: { modelIds: unknown }) => item.modelIds === null), true);
      assert.match(response.json().modelIdsNote, /user/);
    } finally { await app.close(); }
  });

  it("encrypts, replaces, selects, and removes credentials without returning plaintext", async () => {
    const { app, database, userId, headers } = fixture();
    try {
      const add = (apiKey: string) => app.inject({ method: "PUT", url: "/api/ai/credentials/groq", headers, payload: { apiKey } });
      const first = await add(SECRET_MARKER);
      assert.equal(first.statusCode, 200);
      assert.doesNotMatch(first.body, new RegExp(SECRET_MARKER));
      assert.equal(decryptUserAiCredential(database, userId, "groq", KEY), SECRET_MARKER);
      const secondSecret = `${SECRET_MARKER}-replacement`;
      const second = await add(secondSecret);
      assert.equal(second.statusCode, 200);
      assert.doesNotMatch(second.body, new RegExp(secondSecret));
      assert.equal(decryptUserAiCredential(database, userId, "groq", KEY), secondSecret);
      const encrypted = (database.prepare("SELECT encrypted_api_key AS value FROM user_ai_provider_credentials WHERE user_id = ?").get(userId) as { value: string }).value;
      assert.doesNotMatch(encrypted, new RegExp(secondSecret));

      const selected = await app.inject({ method: "PUT", url: "/api/ai/configuration", headers, payload: { providerId: "groq", modelId: "org/model-name" } });
      assert.equal(selected.statusCode, 200);
      assert.deepEqual(selected.json().selected, { providerId: "groq", modelId: "org/model-name" });
      assert.equal(selected.json().selected.modelId, "org/model-name");
      const get = await app.inject({ method: "GET", url: "/api/ai/configuration", headers });
      assert.equal(get.statusCode, 200);
      assert.deepEqual(get.json().selected, { providerId: "groq", modelId: "org/model-name" });
      assert.equal(get.json().credentials.find((item: { providerId: string }) => item.providerId === "groq").configured, true);
      assert.doesNotMatch(get.body, new RegExp(`${SECRET_MARKER}|encrypted_api_key|apiKey`));

      const removed = await app.inject({ method: "DELETE", url: "/api/ai/credentials/groq", headers });
      assert.equal(removed.statusCode, 200);
      assert.equal(removed.json().configured, false);
      assert.equal(decryptUserAiCredential(database, userId, "groq", KEY), null);
      assert.equal((database.prepare("SELECT count(*) AS count FROM user_ai_provider_credentials WHERE user_id = ?").get(userId) as { count: number }).count, 0);
    } finally { await app.close(); }
  });

  it("isolates credentials and selection by authenticated user", async () => {
    const { app, database, userId, headers } = fixture();
    const otherId = randomUUID();
    database.prepare("INSERT INTO users (id, github_username) VALUES (?, ?)").run(otherId, `test-${otherId}`);
    const otherSession = createSession(database, otherId);
    try {
      await app.inject({ method: "PUT", url: "/api/ai/credentials/groq", headers, payload: { apiKey: SECRET_MARKER } });
      const other = await app.inject({ method: "GET", url: "/api/ai/configuration", headers: { cookie: `pocketcode_session=${otherSession.token}` } });
      assert.equal(other.statusCode, 200);
      assert.equal(other.json().selected, null);
      assert.equal(other.json().credentials.find((item: { providerId: string }) => item.providerId === "groq").configured, false);
      assert.equal(decryptUserAiCredential(database, otherId, "groq", KEY), null);
      assert.equal(decryptUserAiCredential(database, userId, "groq", KEY), SECRET_MARKER);
    } finally { await app.close(); }
  });

  it("requires authentication and validates providers, models, and credentials", async () => {
    const { app, headers } = fixture();
    try {
      assert.equal((await app.inject({ method: "GET", url: "/api/ai/configuration" })).statusCode, 401);
      assert.equal((await app.inject({ method: "PUT", url: "/api/ai/configuration", headers, payload: { providerId: "xai", modelId: "model" } })).statusCode, 400);
      assert.equal((await app.inject({ method: "PUT", url: "/api/ai/configuration", headers, payload: { providerId: "openai", modelId: " model " } })).statusCode, 400);
      assert.equal((await app.inject({ method: "PUT", url: "/api/ai/credentials/unknown", headers, payload: { apiKey: SECRET_MARKER } })).statusCode, 400);
      assert.equal((await app.inject({ method: "PUT", url: "/api/ai/credentials/openai", headers, payload: { apiKey: " secret\nvalue" } })).statusCode, 400);
    } finally { await app.close(); }
  });

  it("enforces origin and session-bound CSRF protection for mutations", async () => {
    const { app, headers } = fixture();
    try {
      const { origin: _origin, ...headersWithoutOrigin } = headers;
      const noOrigin = await app.inject({ method: "PUT", url: "/api/ai/credentials/openai", headers: headersWithoutOrigin, payload: { apiKey: SECRET_MARKER } });
      assert.equal(noOrigin.statusCode, 403);
      const foreignOrigin = await app.inject({ method: "PUT", url: "/api/ai/credentials/openai", headers: { ...headers, origin: "https://attacker.invalid" }, payload: { apiKey: SECRET_MARKER } });
      assert.equal(foreignOrigin.statusCode, 403);
      const badCsrf = await app.inject({ method: "DELETE", url: "/api/ai/credentials/openai", headers: { ...headers, "x-csrf-token": "wrong" } });
      assert.equal(badCsrf.statusCode, 403);
    } finally { await app.close(); }
  });

  it("fails closed when encryption configuration is missing or invalid", async () => {
    for (const encryptionKey of [null, "invalid"] as const) {
      const { app, headers } = fixture(encryptionKey);
      try {
        const response = await app.inject({ method: "PUT", url: "/api/ai/credentials/openai", headers, payload: { apiKey: SECRET_MARKER } });
        assert.equal(response.statusCode, 503);
        assert.doesNotMatch(response.body, /TOKEN_ENCRYPTION_KEY|fake-test-key/);
      } finally { await app.close(); }
    }
  });

  it("does not use TOKEN_ENCRYPTION_KEY from the process environment as an account fallback", async () => {
    const previous = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    const { app, headers } = fixture(null);
    try {
      const response = await app.inject({ method: "PUT", url: "/api/ai/credentials/openai", headers, payload: { apiKey: SECRET_MARKER } });
      assert.equal(response.statusCode, 503);
    } finally {
      if (previous === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previous;
      await app.close();
    }
  });
});