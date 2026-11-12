import type Database from "better-sqlite3";

export function up(database: Database.Database): void {
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      github_user_id TEXT UNIQUE,
      github_username TEXT NOT NULL CHECK (length(trim(github_username)) > 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE github_connections (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      encrypted_access_token TEXT NOT NULL,
      encrypted_refresh_token TEXT,
      access_token_expires_at TEXT,
      refresh_token_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE oauth_states (
      id TEXT PRIMARY KEY NOT NULL,
      state_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
    CREATE INDEX github_connections_user_id_idx ON github_connections(user_id);
    CREATE INDEX oauth_states_expires_at_idx ON oauth_states(expires_at);
  `);
}
