import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createOAuthState,
  consumeOAuthTransaction,
  validateAndConsumeOAuthState,
} from "../src/auth/oauth-state-service.js";
import {
  createSession,
  deleteExpiredSessions,
  revokeSession,
  serializeSessionCookie,
  validateSession,
} from "../src/auth/session-service.js";
import { decryptToken, encryptToken } from "../src/auth/token-encryption.js";
import { openDatabase } from "../src/storage/database.js";

const TEST_KEY = "0123456789abcdef".repeat(4);
let temporaryDirectory: string;
let databasePath: string;
let database: ReturnType<typeof openDatabase>;
let userId: string;

function createUser(): string {
  const id = randomUUID();
  database
    .prepare("INSERT INTO users (id, github_username) VALUES (?, ?)")
    .run(id, `test-${id}`);
  return id;
}

beforeEach(() => {
  temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "pocketcode-test-"));
  databasePath = path.join(temporaryDirectory, "test.sqlite");
  database = openDatabase(databasePath);
  userId = createUser();
});

afterEach(() => {
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("SQLite database", () => {
  it("uses DATABASE_PATH when configured", () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "pocketcode-database-env-"));
    const configuredPath = path.join(temporaryDirectory, "configured.sqlite");
    const previousPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = configuredPath;

    try {
      const configuredDatabase = openDatabase();
      configuredDatabase.close();
      assert.equal(existsSync(configuredPath), true);
    } finally {
      if (previousPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousPath;
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("preserves the current-working-directory default when DATABASE_PATH is absent", () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "pocketcode-database-default-"));
    const previousPath = process.env.DATABASE_PATH;
    const previousWorkingDirectory = process.cwd();

    try {
      delete process.env.DATABASE_PATH;
      process.chdir(temporaryDirectory);
      const defaultPath = path.join(temporaryDirectory, "data", "pocketcode.sqlite");
      const defaultDatabase = openDatabase();
      defaultDatabase.close();
      assert.equal(existsSync(defaultPath), true);
    } finally {
      process.chdir(previousWorkingDirectory);
      if (previousPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousPath;
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("uses an explicitly passed database path instead of DATABASE_PATH", () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "pocketcode-database-override-"));
    const configuredPath = path.join(temporaryDirectory, "configured.sqlite");
    const explicitPath = path.join(temporaryDirectory, "explicit.sqlite");
    const previousPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = configuredPath;

    try {
      const explicitDatabase = openDatabase(explicitPath);
      explicitDatabase.close();
      assert.equal(existsSync(explicitPath), true);
      assert.equal(existsSync(configuredPath), false);
    } finally {
      if (previousPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousPath;
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("initializes the schema with foreign keys and indexes", () => {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      tables.map(({ name }) => name).sort(),
      ["agent_messages", "agent_sessions", "github_connections", "github_installation_states", "github_installations", "oauth_states", "repository_branches", "schema_migrations", "sessions", "user_ai_provider_credentials", "user_ai_provider_settings", "users", "workspace_changes", "workspace_files", "workspaces"],
    );
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(
      database
        .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
        .get() as { version: number },
      { version: 9 },
    );
  });

  it("persists data after closing and reopening", () => {
    const persistedUserId = userId;
    database.close();
    database = openDatabase(databasePath);
    assert.equal(
      (database.prepare("SELECT id FROM users WHERE id = ?").get(persistedUserId) as { id: string })
        .id,
      persistedUserId,
    );
  });
});

describe("sessions", () => {
  it("creates an opaque token and validates it using the stored hash", () => {
    const session = createSession(database, userId);
    const stored = database
      .prepare("SELECT token_hash FROM sessions WHERE user_id = ?")
      .get(userId) as { token_hash: string };
    assert.equal(session.token.length, 43);
    assert.equal(stored.token_hash, createHash("sha256").update(session.token).digest("hex"));
    assert.equal(validateSession(database, session.token)?.userId, userId);
    assert.equal(validateSession(database, "invalid"), null);
    assert.equal(validateSession(database, undefined), null);
  });

  it("rejects expired sessions and deletes them during validation", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const session = createSession(database, userId, { expiresInMs: 1, now });
    assert.equal(validateSession(database, session.token, new Date(now.getTime() + 1)), null);
    assert.equal(database.prepare("SELECT id FROM sessions").get(), undefined);
  });

  it("revokes sessions and deletes expired sessions", () => {
    const first = createSession(database, userId);
    const second = createSession(database, userId, { expiresInMs: 1 });
    assert.equal(revokeSession(database, first.token), true);
    assert.equal(revokeSession(database, first.token), false);
    assert.equal(deleteExpiredSessions(database, new Date(Date.now() + 10)), 1);
    assert.equal(validateSession(database, second.token), null);
  });

  it("serializes an HttpOnly, SameSite=Lax cookie with a bounded path and lifetime", () => {
    assert.equal(
      serializeSessionCookie("opaque-token", { maxAgeSeconds: 60, secure: true }),
      "pocketcode_session=opaque-token; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure",
    );
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.match(serializeSessionCookie("opaque-token"), /; Secure$/);
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });
});

describe("OAuth state", () => {
  it("validates and consumes each state exactly once", () => {
    const { state } = createOAuthState(database);
    const stored = database
      .prepare("SELECT state_hash FROM oauth_states")
      .get() as { state_hash: string };
    assert.equal(stored.state_hash, createHash("sha256").update(state).digest("hex"));
    assert.equal(validateAndConsumeOAuthState(database, "wrong-state"), false);
    assert.equal(validateAndConsumeOAuthState(database, state), true);
    assert.equal(validateAndConsumeOAuthState(database, state), false);
  });

  it("rejects expired and missing states", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const { state } = createOAuthState(database, { expiresInMs: 1, now });
    assert.equal(validateAndConsumeOAuthState(database, state, new Date(now.getTime() + 1)), false);
    assert.equal(database.prepare("SELECT id FROM oauth_states").get(), undefined);
    assert.equal(validateAndConsumeOAuthState(database, undefined), false);
  });

  it("stores only state and browser-binding hashes and encrypts PKCE verifiers", () => {
    const binding = "browser-binding-test-value";
    const verifier = "pkce-verifier-test-value";
    const { state } = createOAuthState(database, {
      browserBinding: binding,
      codeVerifier: verifier,
      encryptionKey: TEST_KEY,
    });
    const row = database.prepare(`SELECT state_hash, browser_binding_hash, encrypted_code_verifier
      FROM oauth_states`).get() as { state_hash: string; browser_binding_hash: string; encrypted_code_verifier: string };
    assert.equal(row.state_hash, createHash("sha256").update(state).digest("hex"));
    assert.equal(row.browser_binding_hash, createHash("sha256").update(binding).digest("hex"));
    assert.notEqual(row.encrypted_code_verifier, verifier);
    assert.deepEqual(consumeOAuthTransaction(database, state, binding, TEST_KEY), { codeVerifier: verifier });
    assert.equal(consumeOAuthTransaction(database, state, binding, TEST_KEY), null);
  });

  it("consumes expired and browser-mismatched PKCE transactions", () => {
    const now = new Date("2025-01-01T00:00:00.000Z");
    const expired = createOAuthState(database, {
      browserBinding: "binding-expired", codeVerifier: "verifier-expired", encryptionKey: TEST_KEY,
      now, expiresInMs: 1,
    });
    assert.equal(consumeOAuthTransaction(database, expired.state, "binding-expired", TEST_KEY, new Date(now.getTime() + 1)), null);
    const live = createOAuthState(database, {
      browserBinding: "binding-live", codeVerifier: "verifier-live", encryptionKey: TEST_KEY,
    });
    assert.equal(consumeOAuthTransaction(database, live.state, "wrong-binding", TEST_KEY), null);
    assert.equal(consumeOAuthTransaction(database, live.state, "binding-live", TEST_KEY), null);
  });
});

describe("token encryption", () => {
  it("encrypts and decrypts with AES-256-GCM", () => {
    const encrypted = encryptToken("sensitive-token", TEST_KEY);
    assert.equal(decryptToken(encrypted, TEST_KEY), "sensitive-token");
    assert.notEqual(encryptToken("sensitive-token", TEST_KEY), encrypted);
  });

  it("rejects an incorrect key and modified ciphertext", () => {
    const encrypted = encryptToken("sensitive-token", TEST_KEY);
    assert.throws(() => decryptToken(encrypted, "fedcba9876543210".repeat(4)));
    const [version, iv, tag, ciphertext] = encrypted.split(".");
    const modifiedCiphertext = Buffer.from(ciphertext, "base64url");
    modifiedCiphertext[0] ^= 1;
    const modified = `${version}.${iv}.${tag}.${modifiedCiphertext.toString("base64url")}`;
    assert.throws(() => decryptToken(modified, TEST_KEY), /Unable to decrypt token/);
  });
});
