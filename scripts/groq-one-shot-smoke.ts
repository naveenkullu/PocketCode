import "dotenv/config";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession } from "../src/auth/session-service.js";
import { AgentError, AgentRuntime } from "../src/agents/agent-runtime.js";
import { createOneShotGroqRuntimeProvider } from "../src/agents/provider-adapter.js";
import { containsDetectedSecret } from "../src/agents/secret-scanner.js";
import { openDatabase } from "../src/storage/database.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
import { decryptUserAiCredential } from "../src/auth/ai-provider-configuration.js";

type SmokeReport = {
  preflight: "passed" | "failed";
  realProviderRequests: number;
  result: "not_run" | "succeeded" | "failed";
  errorCategory?: string;
  toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
    success: boolean;
    errorCategory?: string;
  }>;
  expectedTools: string[];
  missingExpectedTools: string[];
  proposalCount: number;
  rejectedProposal: boolean;
  approvedProposal: boolean;
  onlyApprovedChangeApplied: boolean;
  messagesAndEventsSecretFree: boolean;
  cleanup: "complete" | "incomplete";
};

class SmokeCheckError extends Error {
  constructor(readonly code: string) { super(code); }
}

function assertSmoke(condition: unknown, code: string): asserts condition {
  if (!condition) throw new SmokeCheckError(code);
}

function isSecretFree(value: string, credential: string): boolean {
  return !containsDetectedSecret(value) && !value.includes(credential);
}

function report(value: SmokeReport): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const result: SmokeReport = {
    preflight: "failed",
    realProviderRequests: 0,
    result: "not_run",
    toolCalls: [],
    expectedTools: [
      "list_files",
      "read_file:src/format.ts",
      "read_file:src/summary.ts",
      "propose_edit_file:src/format.ts",
      "propose_edit_file:src/summary.ts",
    ],
    missingExpectedTools: [],
    proposalCount: 0,
    rejectedProposal: false,
    approvedProposal: false,
    onlyApprovedChangeApplied: false,
    messagesAndEventsSecretFree: false,
    cleanup: "incomplete",
  };
  const userId = process.env.POCKETCODE_SMOKE_USER_ID;
  const tokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (
    process.env.POCKETCODE_RUN_LIVE_GROQ_SMOKE !== "1" ||
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE !== "1" ||
    process.env.NODE_ENV === "production" ||
    !userId ||
    !tokenEncryptionKey ||
    !/^[\da-fA-F]{64}$/.test(tokenEncryptionKey)
  ) {
    result.errorCategory = "smoke_preflight_not_enabled";
    result.cleanup = "complete";
    report(result);
    process.exitCode = 1;
    return;
  }

  let sourceDatabase: ReturnType<typeof openDatabase> | undefined;
  let database: ReturnType<typeof openDatabase> | undefined;
  let workspace: WorkspaceService | undefined;
  let runtime: AgentRuntime | undefined;
  let tempDirectory: string | undefined;
  let credential = "";
  let activeProvider: ReturnType<typeof createOneShotGroqRuntimeProvider> | undefined;
  let streamInvocations = 0;
  let sessionId = "";
  let workspaceId = "";
  let requestCount = 0;
  try {
    sourceDatabase = openDatabase();
    const source = sourceDatabase.prepare(`
      SELECT u.id AS userId, u.github_username AS username,
        s.provider_id AS providerId, s.model_id AS modelId,
        c.encrypted_api_key AS encryptedApiKey
      FROM users u
      JOIN user_ai_provider_settings s ON s.user_id = u.id
      JOIN user_ai_provider_credentials c ON c.user_id = u.id AND c.provider_id = s.provider_id
      WHERE u.id = ? AND s.provider_id = 'groq'
    `).get(userId) as {
      userId: string;
      username: string;
      providerId: string;
      modelId: string;
      encryptedApiKey: string;
    } | undefined;
    assertSmoke(source?.providerId === "groq", "groq_configuration_missing");
    assertSmoke(typeof source.modelId === "string" && source.modelId.length > 0, "groq_model_missing");

    database = openDatabase(":memory:");
    database.prepare("INSERT INTO users(id,github_username) VALUES(?,?)").run(userId, source.username);
    database.prepare(`
      INSERT INTO user_ai_provider_settings(user_id,provider_id,model_id)
      VALUES(?,?,?)
    `).run(userId, source.providerId, source.modelId);
    database.prepare(`
      INSERT INTO user_ai_provider_credentials(user_id,provider_id,encrypted_api_key)
      VALUES(?,?,?)
    `).run(userId, source.providerId, source.encryptedApiKey);
    const decryptedCredential = decryptUserAiCredential(database, userId, "groq", tokenEncryptionKey);
    assertSmoke(typeof decryptedCredential === "string" && decryptedCredential.length > 0, "groq_credential_missing");
    credential = decryptedCredential;

    createSession(database, userId);
    const sessionRow = database.prepare("SELECT id FROM sessions WHERE user_id=?").get(userId) as { id: string };
    tempDirectory = mkdtempSync(path.join(os.tmpdir(), "pocketcode-groq-smoke-"));
    workspace = new WorkspaceService(database, { rootDirectory: path.join(tempDirectory, "workspaces") });
    const createdWorkspace = workspace.create(
      userId,
      sessionRow.id,
      "synthetic-smoke",
      "main",
      "synthetic",
      [
        { path: "src/format.ts", content: "export function formatName(name: string) {\n  return name.trim();\n}\n" },
        { path: "src/summary.ts", content: "import { formatName } from './format';\n\nexport function summary(name: string) {\n  return `Hello ${formatName(name)}`;\n}\n" },
      ],
    );
    workspaceId = createdWorkspace.id;

    runtime = new AgentRuntime(database, workspace, tokenEncryptionKey, (providerId, modelId, apiKey) => {
      assertSmoke(providerId === "groq", "unexpected_provider");
      activeProvider = createOneShotGroqRuntimeProvider(modelId, apiKey);
      return {
        async *stream(messages, tools, signal) {
          streamInvocations++;
          yield* activeProvider!.provider.stream(messages, tools, signal);
        },
      };
    });
    const session = runtime.create(userId, workspaceId);
    sessionId = session.id;
    assertSmoke(session.providerId === "groq" && session.modelId === source.modelId, "session_configuration_mismatch");
    result.preflight = "passed";

    result.result = "failed";
    const response = await runtime.runOneShotForTesting(
      sessionId,
      userId,
      "You must: (1) Call list_files to see all files in the workspace. (2) Call read_file for src/format.ts to read its content. (3) Call read_file for src/summary.ts to read its content. (4) Propose an edit to src/format.ts so formatName normalizes internal whitespace (replace multiple spaces with single space). (5) Propose an edit to src/summary.ts so it uses the updated formatName helper. Do not apply any changes; only propose edits.",
    );
    requestCount = activeProvider?.requestCount() ?? 0;
    result.realProviderRequests = requestCount;
    assertSmoke(streamInvocations === 1 && requestCount === 1, "provider_request_count_mismatch");
    result.toolCalls = response.toolCalls.map((call) => ({
      name: call.name,
      arguments: call.arguments ?? {},
      success: call.success,
      errorCategory: call.success ? undefined : (typeof call.error === "string" ? call.error : call.error?.code ?? "tool_failed"),
    }));
    result.proposalCount = response.proposals.length;

    const exercised = new Set(
      response.toolCalls
        .filter((call) => call.success)
        .map((call) => (call.path ? `${call.name}:${call.path}` : call.name))
    );
    result.missingExpectedTools = result.expectedTools.filter((expected) => !exercised.has(expected));
    assertSmoke(exercised.has("list_files"), "list_files_not_exercised");
    assertSmoke(exercised.has("read_file:src/format.ts"), "format_read_not_exercised");
    assertSmoke(exercised.has("read_file:src/summary.ts"), "summary_read_not_exercised");
    assertSmoke(response.proposals.length === 2, "expected_two_file_proposals");

    const originalFormat = "export function formatName(name: string) {\n  return name.trim();\n}\n";
    const originalSummary = "import { formatName } from './format';\n\nexport function summary(name: string) {\n  return `Hello ${formatName(name)}`;\n}\n";
    assertSmoke(workspace.readFile(workspaceId, userId, "src/format.ts").content === originalFormat, "workspace_changed_before_approval");
    assertSmoke(workspace.readFile(workspaceId, userId, "src/summary.ts").content === originalSummary, "workspace_changed_before_approval");

    const proposals = response.proposals as Array<{ id: string; path: string; status: string }>;
    const formatProposal = proposals.find((proposal) => proposal.path === "src/format.ts");
    const summaryProposal = proposals.find((proposal) => proposal.path === "src/summary.ts");
    assertSmoke(formatProposal?.status === "pending" && summaryProposal?.status === "pending", "expected_pending_file_proposals");
    workspace.decide(workspaceId, userId, summaryProposal.id, "reject");
    result.rejectedProposal = true;
    assertSmoke(workspace.readFile(workspaceId, userId, "src/format.ts").content === originalFormat, "rejection_changed_workspace");
    assertSmoke(workspace.readFile(workspaceId, userId, "src/summary.ts").content === originalSummary, "rejection_changed_workspace");
    workspace.decide(workspaceId, userId, formatProposal.id, "approve");
    result.approvedProposal = true;
    result.onlyApprovedChangeApplied =
      workspace.readFile(workspaceId, userId, "src/format.ts").content !== originalFormat &&
      workspace.readFile(workspaceId, userId, "src/summary.ts").content === originalSummary;
    assertSmoke(result.onlyApprovedChangeApplied, "approval_applied_unapproved_change");

    const storedMessages = database.prepare("SELECT content FROM agent_messages WHERE session_id=?")
      .all(sessionId) as Array<{ content: string }>;
    const events = runtime.events(sessionId, userId);
    const storedProposals = database.prepare("SELECT proposed_content AS content FROM workspace_changes WHERE workspace_id=?")
      .all(workspaceId) as Array<{ content: string | null }>;
    result.messagesAndEventsSecretFree =
      storedMessages.every((message) => isSecretFree(message.content, credential)) &&
      events.every((event) => isSecretFree(JSON.stringify(event), credential)) &&
      storedProposals.every((proposal) => proposal.content === null || isSecretFree(proposal.content, credential));
    assertSmoke(result.messagesAndEventsSecretFree, "secret_found_in_persisted_messages_or_events");
    result.result = "succeeded";
  } catch (error) {
    requestCount = activeProvider?.requestCount() ?? requestCount;
    result.realProviderRequests = requestCount;
    result.errorCategory = error instanceof SmokeCheckError
      ? error.code
      : error instanceof AgentError
        ? error.code
        : "smoke_test_failed";
    result.result = requestCount > 0 ? "failed" : "not_run";
  } finally {
    let cleanupSucceeded = true;
    for (const cleanup of [
      () => runtime?.close(),
      () => workspace?.shutdownCleanup(),
      () => database?.close(),
      () => sourceDatabase?.close(),
      () => { if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true }); },
    ]) {
      try { cleanup(); } catch { cleanupSucceeded = false; }
    }
    result.cleanup = cleanupSucceeded ? "complete" : "incomplete";
    credential = "";
    report(result);
  }
  if (result.result !== "succeeded" || result.cleanup !== "complete") process.exitCode = 1;
}

void main();
