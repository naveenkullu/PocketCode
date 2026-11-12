import type Database from "better-sqlite3";

export function up(database: Database.Database): void {
  database.exec(`
    CREATE TABLE github_installation_states (
      state_hash TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL)
    );
    CREATE INDEX github_installation_states_expiry_idx ON github_installation_states(expires_at);
    CREATE TABLE github_installations (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      installation_id TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      account_login TEXT NOT NULL CHECK (length(trim(account_login)) > 0),
      account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
      repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'deleted')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX github_installations_user_id_idx ON github_installations(user_id);
    CREATE INDEX github_installations_account_id_idx ON github_installations(account_id);
  `);
}