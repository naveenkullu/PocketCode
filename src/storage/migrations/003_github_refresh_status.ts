import type Database from "better-sqlite3";

export function up(database: Database.Database): void {
  database.exec(`
    ALTER TABLE github_connections
      ADD COLUMN reconnect_required INTEGER NOT NULL DEFAULT 0 CHECK (reconnect_required IN (0, 1));
    ALTER TABLE github_connections ADD COLUMN refresh_lock_owner TEXT;
    ALTER TABLE github_connections ADD COLUMN refresh_lock_expires_at TEXT;
  `);
}