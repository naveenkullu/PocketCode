import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { decryptToken, encryptToken } from "./token-encryption.js";

const DEFAULT_STATE_LIFETIME_MS = 10 * 60 * 1000;

interface OAuthStateOptions {
  expiresInMs?: number;
  now?: Date;
  browserBinding?: string;
  codeVerifier?: string;
  encryptionKey?: string;
}

function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export function createOAuthState(
  database: Database.Database,
  options: OAuthStateOptions = {},
): { state: string; expiresAt: string } {
  const expiresInMs = options.expiresInMs ?? DEFAULT_STATE_LIFETIME_MS;
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0) {
    throw new Error("OAuth state lifetime must be a positive safe integer.");
  }

  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + expiresInMs).toISOString();
  const state = randomBytes(32).toString("base64url");
  if (Boolean(options.browserBinding) !== Boolean(options.codeVerifier)) {
    throw new Error("OAuth browser binding and PKCE verifier must be provided together.");
  }
  if (options.browserBinding && options.codeVerifier) {
    database.prepare(`
      INSERT INTO oauth_states (id, state_hash, expires_at, browser_binding_hash, encrypted_code_verifier)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      randomUUID(), hashState(state), expiresAt, hashState(options.browserBinding),
      encryptToken(options.codeVerifier, options.encryptionKey),
    );
  } else {
    database.prepare("INSERT INTO oauth_states (id, state_hash, expires_at) VALUES (?, ?, ?)")
      .run(randomUUID(), hashState(state), expiresAt);
  }

  return { state, expiresAt };
}

export function consumeOAuthTransaction(
  database: Database.Database,
  state: string | undefined,
  browserBinding: string | undefined,
  encryptionKey: string,
  now = new Date(),
): { codeVerifier: string } | null {
  if (!state) return null;
  const consume = database.transaction(() => {
    const record = database.prepare(`
      SELECT id, expires_at AS expiresAt, browser_binding_hash AS bindingHash,
        encrypted_code_verifier AS encryptedVerifier
      FROM oauth_states WHERE state_hash = ?
    `).get(hashState(state)) as {
      id: string; expiresAt: string; bindingHash: string | null; encryptedVerifier: string | null;
    } | undefined;
    if (!record) return null;
    database.prepare("DELETE FROM oauth_states WHERE id = ?").run(record.id);
    if (
      Date.parse(record.expiresAt) <= now.getTime() || !record.bindingHash ||
      !record.encryptedVerifier || !browserBinding || record.bindingHash !== hashState(browserBinding)
    ) return null;
    try {
      return { codeVerifier: decryptToken(record.encryptedVerifier, encryptionKey) };
    } catch {
      return null;
    }
  });
  return consume();
}

export function validateAndConsumeOAuthState(
  database: Database.Database,
  state: string | undefined,
  now = new Date(),
): boolean {
  if (!state) {
    return false;
  }

  const consume = database.transaction((providedState: string, currentTime: Date) => {
    const stateHash = hashState(providedState);
    const record = database
      .prepare("SELECT id, expires_at AS expiresAt FROM oauth_states WHERE state_hash = ?")
      .get(stateHash) as { id: string; expiresAt: string } | undefined;
    if (!record) {
      return false;
    }

    database.prepare("DELETE FROM oauth_states WHERE id = ?").run(record.id);
    return Date.parse(record.expiresAt) > currentTime.getTime();
  });

  return consume(state, now);
}
