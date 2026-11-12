import type Database from "better-sqlite3";

export function up(database: Database.Database): void {
  database.exec(`
    CREATE TABLE user_ai_provider_settings (
      user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL CHECK (provider_id IN ('gemini', 'openai-compatible', 'anthropic', 'groq', 'openrouter')),
      model_id TEXT NOT NULL CHECK (length(trim(model_id)) BETWEEN 1 AND 200),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE user_ai_provider_credentials (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL CHECK (provider_id IN ('gemini', 'openai-compatible', 'anthropic', 'groq', 'openrouter')),
      encrypted_api_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (user_id, provider_id)
    );
    CREATE INDEX user_ai_provider_credentials_user_id_idx ON user_ai_provider_credentials(user_id);
  `);
}