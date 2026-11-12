import type Database from "better-sqlite3";

export function up(database: Database.Database): void {
  database.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL,
      branch_ref TEXT NOT NULL CHECK (length(branch_ref) BETWEEN 1 AND 255),
      source_commit_sha TEXT NOT NULL,
      snapshot_bytes INTEGER NOT NULL CHECK (snapshot_bytes >= 0),
      snapshot_file_count INTEGER NOT NULL CHECK (snapshot_file_count >= 0),
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      CHECK (julianday(expires_at) IS NOT NULL)
    );
    CREATE INDEX workspaces_user_idx ON workspaces(user_id, created_at);
    CREATE INDEX workspaces_expiry_idx ON workspaces(expires_at);

    CREATE TABLE workspace_files (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      PRIMARY KEY (workspace_id, path)
    );
    CREATE TABLE workspace_changes (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      base_version INTEGER NOT NULL CHECK (base_version >= 0),
      operation TEXT NOT NULL CHECK (operation IN ('create_file','edit_file','delete_file')),
      path TEXT NOT NULL,
      original_content TEXT,
      proposed_content TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX workspace_changes_workspace_idx ON workspace_changes(workspace_id, created_at);
    CREATE INDEX workspace_changes_owner_idx ON workspace_changes(user_id, workspace_id);
  `);
}