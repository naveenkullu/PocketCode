import type Database from "better-sqlite3";

export function up(database: Database.Database): void {
  database.exec(`
    DELETE FROM agent_messages;
    DELETE FROM agent_sessions;
  `);
}
