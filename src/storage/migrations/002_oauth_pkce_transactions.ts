import type Database from "better-sqlite3";

export function up(database: Database.Database): void {
  database.exec(`
    ALTER TABLE oauth_states ADD COLUMN browser_binding_hash TEXT;
    ALTER TABLE oauth_states ADD COLUMN encrypted_code_verifier TEXT;
  `);
}