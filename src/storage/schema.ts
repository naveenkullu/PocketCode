import type Database from "better-sqlite3";
import { up as createInitialSchema } from "./migrations/001_initial.js";
import { up as addOAuthPkceTransactions } from "./migrations/002_oauth_pkce_transactions.js";
import { up as addGitHubRefreshStatus } from "./migrations/003_github_refresh_status.js";
import { up as addGitHubInstallations } from "./migrations/004_github_installations.js";
import { up as addUserAiProviderSettings } from "./migrations/005_user_ai_provider_settings.js";
import { up as addWorkspaces } from "./migrations/006_workspaces.js";
import { up as addAgentSessions } from "./migrations/007_agent_sessions.js";
import { up as clearLegacyAgentHistory } from "./migrations/008_clear_legacy_agent_history.js";
import { up as addRepositoryBranches } from "./migrations/009_repository_branches.js";

interface Migration {
  version: number;
  up(database: Database.Database): void;
}

const migrations: Migration[] = [
  { version: 1, up: createInitialSchema },
  { version: 2, up: addOAuthPkceTransactions },
  { version: 3, up: addGitHubRefreshStatus },
  { version: 4, up: addGitHubInstallations },
  { version: 5, up: addUserAiProviderSettings },
  { version: 6, up: addWorkspaces },
  { version: 7, up: addAgentSessions },
  { version: 8, up: clearLegacyAgentHistory },
  { version: 9, up: addRepositoryBranches },
];

export function initializeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const getVersion = database.prepare(
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
  );
  const recordVersion = database.prepare(
    "INSERT INTO schema_migrations (version) VALUES (?)",
  );

  for (const migration of migrations) {
    const current = getVersion.get() as { version: number } | undefined;
    if (current && current.version >= migration.version) {
      continue;
    }

    database.transaction(() => {
      migration.up(database);
      recordVersion.run(migration.version);
    })();
  }
}
