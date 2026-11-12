import "dotenv/config";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession } from "../src/auth/session-service.js";
import { AgentRuntime, AgentError } from "../src/agents/agent-runtime.js";
import { createRuntimeProvider } from "../src/agents/provider-adapter.js";
import { containsDetectedSecret } from "../src/agents/secret-scanner.js";
import { openDatabase } from "../src/storage/database.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
import { decryptUserAiCredential } from "../src/auth/ai-provider-configuration.js";

// Debug: log environment
const debugInfo = {
  GROQ_SMOKE: process.env.POCKETCODE_RUN_LIVE_GROQ_SMOKE,
  AGENT_SMOKE: process.env.POCKETCODE_ENABLE_AGENT_SMOKE,
  USER_ID: process.env.POCKETCODE_SMOKE_USER_ID,
  TOKEN_KEY_LEN: process.env.TOKEN_ENCRYPTION_KEY?.length,
  TOKEN_KEY_MATCH: /^[\da-fA-F]{64}$/.test(process.env.TOKEN_ENCRYPTION_KEY || ""),
  NODE_ENV: process.env.NODE_ENV,
};
console.error("[DEBUG] ", JSON.stringify(debugInfo));

type SmokeReport = {
  preflight: "passed" | "failed";
  realProviderRequests: number;
  result: "not_run" | "succeeded" | "failed" | "limit_reached";
  errorCategory?: string;
  toolExecutions: Array<{
    name: string;
    arguments: Record<string, unknown>;
    success: boolean;
    errorCategory?: string;
  }>;
  providerRounds: number;
  proposalCount: number;
  stoppedByLimit: boolean;
  limitType?: "provider_requests" | "tool_executions" | "timeout" | "files" | "proposals";
  messagesAndEventsSecretFree: boolean;
  cleanup: "complete" | "incomplete";
};

class SmokeCheckError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
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
  console.error("[DEBUG] main() started");
  const result: SmokeReport = {
    preflight: "failed",
    realProviderRequests: 0,
    result: "not_run",
    toolExecutions: [],
    providerRounds: 0,
    proposalCount: 0,
    stoppedByLimit: false,
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
  let providerRequestCount = 0;
  let toolExecutionCount = 0;
  let stoppedByLimit = false;
  let limitType: SmokeReport["limitType"] = undefined;
  let sessionId = "";
  let workspaceId = "";

  const MAX_PROVIDER_REQUESTS = 4;
  const MAX_TOOL_EXECUTIONS = 6;
  const MAX_FILES = 2;
  const OVERALL_TIMEOUT_MS = 120_000;

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

    assertSmoke(source !== undefined, "user_not_found_or_no_groq_config");
    assertSmoke(source.providerId === "groq", "unexpected_provider");

    credential = decryptUserAiCredential(sourceDatabase, userId, "groq", Buffer.from(tokenEncryptionKey, "hex"));
    assertSmoke(typeof credential === "string" && credential.length > 0, "credential_decrypt_failed");

    tempDirectory = mkdtempSync(path.join(os.tmpdir(), "pocketcode-multi-turn-smoke-"));
    database = openDatabase(":memory:");
    workspace = new WorkspaceService(database, { rootDirectory: path.join(tempDirectory, "ws") });

    const originalFormat = "export function formatName(name: string) {\n  return name.trim();\n}\n";
    const originalSummary = "import { formatName } from './format';\n\nexport function summary(name: string) {\n  return `Hello ${formatName(name)}`;\n}\n";

    const ws = workspace.create("u1", "synthetic-session", "synthetic", "main", "synthetic", [
      { path: "src/format.ts", content: originalFormat },
      { path: "src/summary.ts", content: originalSummary },
    ]);
    workspaceId = ws.id;

    let countingProviderFactory = (providerId: string, modelId: string, apiKey: string) => {
      const baseProvider = createRuntimeProvider(providerId, modelId, apiKey);
      return {
        async *stream(messages, tools, signal) {
          providerRequestCount++;
          if (providerRequestCount > MAX_PROVIDER_REQUESTS) {
            stoppedByLimit = true;
            limitType = "provider_requests";
            throw new AgentError("provider_request_limit", 429);
          }
          for await (const chunk of baseProvider.stream(messages, tools, signal)) {
            yield chunk;
          }
        },
      };
    };
runtime = new AgentRuntime(
      database,
      workspace,
      tokenEncryptionKey,
      countingProviderFactory,
      { overallTimeoutMs: OVERALL_TIMEOUT_MS }
    );

    const session = runtime.create(userId, workspaceId);
    sessionId = session.id;

    result.preflight = "passed";
    result.result = "failed";

    const response = await runtime.message(
      sessionId,
      userId,
      "You are given two files: src/format.ts and src/summary.ts. " +
      "First, list the files in the workspace. " +
      "Then read both files to understand their content. " +
      "The formatName function in format.ts only trims whitespace but doesn't normalize internal whitespace. " +
      "The summary function uses formatName. " +
      "Propose an edit to src/format.ts so formatName normalizes internal whitespace (replace multiple spaces with single space). " +
      "Propose an edit to src/summary.ts so it uses the updated formatName helper. " +
      "Do not apply any changes; only propose edits."
    );

    result.realProviderRequests = providerRequestCount;
    result.providerRounds = providerRequestCount;

    const events = runtime.events(sessionId, userId);
    const toolEvents = events.filter((e) => e.type === "tool");
    result.toolExecutions = toolEvents.map((e) => {
      const data = e.data as { name: string; success: boolean; error?: string };
      return {
        name: data.name,
        arguments: {},
        success: data.success,
        errorCategory: data.success ? undefined : (data.error ?? "tool_failed"),
      };
    });
    toolExecutionCount = toolEvents.length;
    result.proposalCount = response.proposals.length;

    assertSmoke(providerRequestCount <= MAX_PROVIDER_REQUESTS, "provider_request_limit_exceeded");
    assertSmoke(toolExecutionCount <= MAX_TOOL_EXECUTIONS, "tool_execution_limit_exceeded");
    assertSmoke(workspace.listFiles(workspaceId, userId).length <= MAX_FILES, "file_count_limit_exceeded");

    const exercised = new Set(
      result.toolExecutions
        .filter((call) => call.success)
        .map((call) => call.name)
    );
    assertSmoke(exercised.has("list_files"), "list_files_not_exercised");
    assertSmoke(exercised.has("read_file"), "read_file_not_exercised");
    assertSmoke(response.proposals.length === 2, "expected_two_file_proposals");

    const originalFormatContent = workspace.readFile(workspaceId, userId, "src/format.ts").content;
    const originalSummaryContent = workspace.readFile(workspaceId, userId, "src/summary.ts").content;
    assertSmoke(originalFormatContent === originalFormat, "workspace_changed_before_approval");
    assertSmoke(originalSummaryContent === originalSummary, "workspace_changed_before_approval");

    const proposals = response.proposals as Array<{ id: string; path: string; status: string }>;
    const formatProposal = proposals.find((proposal) => proposal.path === "src/format.ts");
    const summaryProposal = proposals.find((proposal) => proposal.path === "src/summary.ts");
    assertSmoke(formatProposal?.status === "pending" && summaryProposal?.status === "pending", "expected_pending_file_proposals");

    workspace.decide(workspaceId, userId, summaryProposal!.id, "reject");
    assertSmoke(workspace.readFile(workspaceId, userId, "src/format.ts").content === originalFormat, "rejection_changed_workspace");
    assertSmoke(workspace.readFile(workspaceId, userId, "src/summary.ts").content === originalSummary, "rejection_changed_workspace");

    workspace.decide(workspaceId, userId, formatProposal!.id, "approve");
    const onlyApprovedChangeApplied =
      workspace.readFile(workspaceId, userId, "src/format.ts").content !== originalFormat &&
      workspace.readFile(workspaceId, userId, "src/summary.ts").content === originalSummary;
    assertSmoke(onlyApprovedChangeApplied, "approval_applied_unapproved_change");

    const storedMessages = database.prepare("SELECT content FROM agent_messages WHERE session_id=?")
      .all(sessionId) as Array<{ content: string }>;
    const eventsAll = runtime.events(sessionId, userId);
    const storedProposals = database.prepare("SELECT proposed_content AS content FROM workspace_changes WHERE workspace_id=?")
      .all(workspaceId) as Array<{ content: string | null }>;
    result.messagesAndEventsSecretFree =
      storedMessages.every((message) => isSecretFree(message.content, credential)) &&
      eventsAll.every((event) => isSecretFree(JSON.stringify(event), credential)) &&
      storedProposals.every((proposal) => proposal.content === null || isSecretFree(proposal.content, credential));
    assertSmoke(result.messagesAndEventsSecretFree, "secret_found_in_persisted_messages_or_events");

    result.result = "succeeded";
  } catch (error) {
    result.realProviderRequests = providerRequestCount;
    result.providerRounds = providerRequestCount;
    result.stoppedByLimit = stoppedByLimit;
    result.limitType = limitType;
    result.errorCategory = error instanceof SmokeCheckError
      ? error.code
      : error instanceof AgentError
        ? error.code
        : "smoke_test_failed";
    result.result = stoppedByLimit ? "limit_reached" : (providerRequestCount > 0 ? "failed" : "not_run");
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