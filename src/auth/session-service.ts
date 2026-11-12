import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const DEFAULT_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = "pocketcode_session";
const OAUTH_BINDING_COOKIE_NAME = "pocketcode_oauth_binding";

interface SessionOptions {
  expiresInMs?: number;
  now?: Date;
}

export interface ValidSession {
  id: string;
  userId: string;
  expiresAt: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createSession(
  database: Database.Database,
  userId: string,
  options: SessionOptions = {},
): { token: string; expiresAt: string } {
  const expiresInMs = options.expiresInMs ?? DEFAULT_SESSION_LIFETIME_MS;
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0) {
    throw new Error("Session lifetime must be a positive safe integer.");
  }

  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + expiresInMs).toISOString();
  const token = randomBytes(32).toString("base64url");
  database
    .prepare(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    )
    .run(randomUUID(), userId, hashToken(token), expiresAt);

  return { token, expiresAt };
}

export function validateSession(
  database: Database.Database,
  token: string | undefined,
  now = new Date(),
): ValidSession | null {
  if (!token) {
    return null;
  }

  const session = database
    .prepare(
      "SELECT id, user_id AS userId, expires_at AS expiresAt FROM sessions WHERE token_hash = ?",
    )
    .get(hashToken(token)) as ValidSession | undefined;

  if (!session) {
    return null;
  }
  if (Date.parse(session.expiresAt) <= now.getTime()) {
    database.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    return null;
  }
  return session;
}

export function revokeSession(database: Database.Database, token: string): boolean {
  const result = database
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .run(hashToken(token));
  return result.changes > 0;
}

export function deleteExpiredSessions(
  database: Database.Database,
  now = new Date(),
): number {
  const result = database
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .run(now.toISOString());
  return result.changes;
}

export function serializeSessionCookie(
  token: string,
  options: { maxAgeSeconds?: number; secure?: boolean } = {},
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Session token contains invalid cookie characters.");
  }

  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_SESSION_LIFETIME_MS / 1000;
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error("Cookie lifetime must be a positive safe integer.");
  }

  const secure = options.secure ?? process.env.NODE_ENV === "production";
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function serializeOAuthBindingCookie(
  token: string,
  options: { maxAgeSeconds?: number; secure?: boolean } = {},
): string {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new Error("OAuth binding token contains invalid cookie characters.");
  }
  const maxAgeSeconds = options.maxAgeSeconds ?? 600;
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error("Cookie lifetime must be a positive safe integer.");
  }
  const secure = options.secure ?? process.env.NODE_ENV === "production";
  return [
    `${OAUTH_BINDING_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearOAuthBindingCookie(options: { secure?: boolean } = {}): string {
  const secure = options.secure ?? process.env.NODE_ENV === "production";
  return [
    `${OAUTH_BINDING_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
