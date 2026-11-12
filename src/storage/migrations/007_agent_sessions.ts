import type Database from "better-sqlite3";

export function up(database: Database.Database): void {
  database.exec(`
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','complete','cancelled','error')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX agent_sessions_owner_idx ON agent_sessions(user_id, updated_at);
    CREATE INDEX agent_sessions_expiry_idx ON agent_sessions(expires_at);
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX agent_messages_session_idx ON agent_messages(session_id, created_at);
  `);
}