import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { initializeSchema } from "./schema.js";

export function openDatabase(
  databasePath = path.resolve(process.cwd(), "data", "pocketcode.sqlite"),
): Database.Database {
  if (databasePath !== ":memory:") {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    initializeSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
