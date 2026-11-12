import type Database from "better-sqlite3";

export function up(database: Database.Database): void {
  database.exec(`
    CREATE TABLE repository_branches (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL,
      installation_id TEXT NOT NULL REFERENCES github_installations(installation_id) ON DELETE RESTRICT,
      owner_login TEXT NOT NULL CHECK (length(trim(owner_login)) > 0),
      repository_name TEXT NOT NULL CHECK (length(trim(repository_name)) > 0),
      default_branch TEXT NOT NULL CHECK (length(default_branch) BETWEEN 1 AND 255),
      base_commit_sha TEXT NOT NULL,
      feature_branch TEXT NOT NULL CHECK (length(feature_branch) BETWEEN 1 AND 255),
      head_commit_sha TEXT,
      status TEXT NOT NULL CHECK (status IN ('provisioning','active','branch_missing','access_lost','branch_collision','recovery_required')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, repository_id),
      UNIQUE (repository_id, feature_branch)
    );
    CREATE INDEX repository_branches_user_status_idx ON repository_branches(user_id, status);
    CREATE INDEX repository_branches_installation_idx ON repository_branches(installation_id);
  `);
}
