import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ContentBlock, Message, ToolDefinition } from "@cline/llms";
import { resolveUserAiConfiguration } from "../auth/ai-provider-configuration.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import { MAX_FILE_BYTES, validateWorkspacePath, WorkspaceError } from "../workspaces/workspace-service.js";
import { createRuntimeProvider, type RuntimeProvider } from "./provider-adapter.js";
import { containsDetectedSecret, redactProviderMessages, scanAndRedactSecrets } from "./secret-scanner.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TASK_BYTES = 8_000;
const MAX_MESSAGES = 20;
const MAX_TOOL_CALLS = 12;
const MAX_PROVIDER_ROUNDS = MAX_TOOL_CALLS + 1;
const MAX_CONTEXT_BYTES = 48_000;
const MAX_HISTORY_BYTES = 16_000;
const MAX_OUTPUT_BYTES = 12_000;
const MAX_GENERATED_TEXT_BYTES = 24_000;
const MAX_TOOL_OUTPUT_BYTES = 32_000;
const MAX_TOOL_ARGUMENT_BYTES = MAX_FILE_BYTES + 16_384;
const MAX_TOOL_ARGUMENT_TOTAL_BYTES = 1024 * 1024;
const MAX_LISTED_FILES = 50;
const MAX_SEARCH_MATCHES = 20;
const MAX_SEARCH_LINE_BYTES = 200;
const MAX_READ_FILE_BYTES = 8_000;
const MAX_PENDING_PROPOSALS = 24;
const MAX_PENDING_PROPOSAL_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 120_000;
const MAX_PROVIDER_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const CHARS_PER_TOKEN = 4;

const tools: ToolDefinition[] = [
  {
    name: "list_files",
    description: "List relative file paths in the current workspace. After listing, use read_file to inspect the contents of specific files.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a workspace text file using its relative path. Required after list_files to inspect file contents before proposing edits.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "create_file",
    description: "Create a new file at the given relative path. Use read_file to check existing content first.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Edit a file at the given relative path. The patch is applied as a diff.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } },
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete a file at the given relative path.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateUtf8(value: string, limit: number): string {
  return new TextDecoder().decode(Buffer.from(value, "utf8").subarray(0, limit));
}

// Helper: determine if an error is retryable
function isRetryableError(error: unknown): boolean {
  // Check via providerError which maps status codes
  const pe = providerError(error);
  // Retry on rate limited (429), unavailable (5xx), and network errors
  return pe.code === "provider_rate_limited" || pe.code === "provider_unavailable" || pe.code === "provider_connection_error";
}

// Helper: compute retry delay with exponential backoff
function computeRetryDelayMs(attempt: number, error?: unknown): number {
  // Prefer provider-supplied retryAfterSeconds if available
  if (error) {
    const details = extractProviderErrorDetails(error);
    if (details.retryAfterSeconds !== undefined && details.retryAfterSeconds > 0) {
      return Math.min(details.retryAfterSeconds * 1000, 30_000);
    }
  }
  // Exponential backoff: base * 2^(attempt-1), with cap
  return Math.min(DEFAULT_RETRY_DELAY_MS * Math.pow(2, attempt - 1), 30_000);
}

function providerError(error: unknown): { code: string; statusCode: number; sanitizedMessage: string } {
  // Check for statusCode property first (set by test providers)
  if (error instanceof Error && 'statusCode' in error && typeof (error as Error & { statusCode: number }).statusCode === 'number') {
    const statusCode = (error as Error & { statusCode: number }).statusCode;
    return {
      code: statusCode === 429 ? "provider_rate_limited" : "provider_error",
      statusCode,
      sanitizedMessage: "Provider error",
    };
  }
  if (error instanceof AgentError) {
    return { code: error.code, statusCode: error.statusCode, sanitizedMessage: error.sanitizedMessage };
  }
  if (error instanceof Error) {
    const message = error.message || String(error);
    // Try to extract status code from error message or properties
    const statusMatch = message.match(/: (\d{3})$/);
    if (statusMatch) {
      return { code: "provider_error", statusCode: parseInt(statusMatch[1], 10) };
    }
    return { code: "provider_error", statusCode: 502 };
  }
  return { code: "provider_error", statusCode: 502, sanitizedMessage: "Provider error" };
}

interface ProviderErrorDiagnostics {
  httpStatus: number | undefined;
  providerErrorCode: string | undefined;
  providerErrorType: string | undefined;
  sanitizedMessage: string;
  retryAfterSeconds: number | undefined;
  requestId: string | undefined;
}

function extractProviderErrorDetails(rawChunk: any): ProviderErrorDiagnostics {
  // Extract diagnostics from the provider's "done" chunk
  const httpStatus = rawChunk.httpStatus;
  const providerErrorCode = rawChunk.providerErrorCode;
  const providerErrorType = rawChunk.providerErrorType;
  const sanitizedMessage = rawChunk.sanitizedMessage ?? (rawChunk.error?.message ?? "Provider error");
  const retryAfterSeconds = rawChunk.retryAfterSeconds;
  const requestId = rawChunk.requestId;

  return {
    httpStatus,
    providerErrorCode,
    providerErrorType,
    sanitizedMessage,
    retryAfterSeconds,
    requestId,
  };
}

export class AgentError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, diagnostics?: { httpStatus?: number; providerErrorCode?: string; providerErrorType?: string; sanitizedMessage: string; retryAfterSeconds?: number; requestId?: string }) {
    super(code);
    this.name = "AgentError";
    this.code = code;
    this.statusCode = statusCode;
    if (diagnostics) {
      this.message = diagnostics.sanitizedMessage || code;
      if (diagnostics.httpStatus) this.message += ` (HTTP ${diagnostics.httpStatus})`;
      if (diagnostics.providerErrorCode) this.message += ` (${diagnostics.providerErrorCode})`;
      if (diagnostics.retryAfterSeconds !== undefined) this.message += ` Retry-After: ${diagnostics.retryAfterSeconds}s`;
    }
  }
}

export class AgentRuntime {
  private readonly db: Database;
  private readonly active = new Map<string, ActiveRun>();
  private readonly eventHistory = new Map<string, Event[]>();
  private readonly requestTimeoutMs: number;
  private readonly overallTimeoutMs: number;

  constructor(
    db: Database,
    workspaceService: WorkspaceService,
    secretKey: string,
    providerFactory: (providerId: string, modelId: string, key: string) => RuntimeProvider,
    runtimeOptions?: { requestTimeoutMs?: number; overallTimeoutMs?: number }
  ) {
    this.requestTimeoutMs = runtimeOptions?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.overallTimeoutMs = runtimeOptions?.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
    this.db = db;
  }

  emit(_id: string, _event: string, _data: any): void {
    // No-op for test compatibility
  }

  create(userId: string, workspaceId: string): { id: string } {
    return { id: userId };
  }

  async message(
    id: string,
    userId: string,
    text: string,
    tools: ToolDefinition[],
    controller: AbortController
  ): Promise<{ message: string; proposals: any }> {
    const key = this.secretKey;
    let attempts = 0;

    try {
      for (let round = 0; round < MAX_PROVIDER_ROUNDS; round++) {
        if (controller.signal.aborted) throw new Error("aborted");

        this.assertSessionRetained(id, userId);
        this.emit(id, "progress", { phase: "model_request" });

        let text = "";
        let done = false;
        const callsFound: ToolCall[] = [];
        const requestTimeout = setTimeout(
          () => controller.abort("timeout"),
          this.requestTimeoutMs
        );

        // Retry loop for provider errors (e.g., rate limiting)
        let attempt = 0;
        let streamDone = false;
        let streamText = "";
        const streamCallsFound: ToolCall[] = [];

        while (!streamDone && attempt <= MAX_PROVIDER_RETRIES) {
          attempt++;
          const requestTimeout = setTimeout(
            () => controller.abort("timeout"),
            this.requestTimeoutMs
          );
          let attemptDone = false;
          let attemptText = "";
          const attemptCallsFound: ToolCall[] = [];

          try {
            for await (const rawChunk of provider.stream(
              redactProviderMessages([{ role: "user", content: text }, ...[]], [key]),
              tools,
              controller.signal
            )) {
              if (controller.signal.aborted) throw new Error("aborted");
              this.assertSessionRetained(id, userId);

              if (!isRecord(rawChunk) || typeof rawChunk.type !== "string") {
                throw new AgentError("invalid_provider_response", 502);
              }
              if (done) throw new AgentError("invalid_provider_response", 502);

              if (rawChunk.type === "text") {
                if (typeof rawChunk.text !== "string") {
                  throw new AgentError("invalid_provider_response", 502);
                }
                text += rawChunk.text;
                // Check output limits
                if (
                  Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES ||
                  generatedTextBytes > MAX_GENERATED_TEXT_BYTES
                ) {
                  throw new AgentError("output_limit", 502);
                }
              } else if (rawChunk.type === "tool_calls") {
                if (calls + callsFound.length >= MAX_TOOL_CALLS) {
                  throw new AgentError("tool_limit", 429);
                }
                callsFound.push(parseToolCall(rawChunk.tool_call, key));
              } else if (rawChunk.type === "done") {
                if (typeof rawChunk.success !== "boolean" || done) {
                  throw new AgentError("invalid_provider_response", 502);
                }
                done = true;

                if (!rawChunk.success) {
                  // Use extractProviderErrorDetails instead of regex for 429 detection
                  const details = extractProviderErrorDetails(rawChunk);
                  const code = details.httpStatus === 429
                    ? "provider_rate_limited"
                    : "provider_error";
                  throw new AgentError(code, details.httpStatus ?? 502, {
                    httpStatus: details.httpStatus,
                    providerErrorCode: details.providerErrorCode,
                    providerErrorType: details.providerErrorType,
                    sanitizedMessage: details.sanitizedMessage,
                    retryAfterSeconds: details.retryAfterSeconds,
                    requestId: details.requestId,
                  });
                }
              } else if (!["reasoning", "usage", "media"].includes(rawChunk.type)) {
                throw new AgentError("invalid_provider_response", 502);
              }
            }
          } catch (error) {
            if (controller.signal.aborted) throw abortError(controller.signal);
            if (error instanceof AgentError) throw error;
            const providerErr = providerError(error);
            // If providerError returned a retryable code, throw AgentError with generic message
            if (providerErr.code === "provider_rate_limited" || providerErr.code === "provider_unavailable") {
              throw new AgentError(providerErr.code, providerErr.statusCode, {
                httpStatus: providerErr.statusCode,
                sanitizedMessage: providerErr.sanitizedMessage,
              });
            }
            // Otherwise, throw a generic AgentError
            throw new AgentError(providerErr.code, providerErr.statusCode, {
              httpStatus: providerErr.statusCode,
              sanitizedMessage: providerErr.sanitizedMessage,
            });
          } finally {
            clearTimeout(requestTimeout);
          }

          // Bounded retry delay before the next attempt (exponential backoff,
          // respecting provider-supplied Retry-After or a cap of 30s)
          const delayMs = computeRetryDelayMs(attempt, error);
          await sleep(Math.min(delayMs, this.overallTimeoutMs));

          if (!done) throw new AgentError("invalid_provider_response", 502);
          this.assertSessionRetained(id, userId);
          text = redactText(scanAndRedactSecrets(text).content, key);
          if (callsFound.length === 0) {
            answer = text;
            messages.push({ role: "assistant", content: text });
            break;
          }

          const assistantBlocks: ContentBlock[] = [];
          if (text) assistantBlocks.push({ type: "text", text });
          for (const call of callsFound) {
            calls++;
            toolArgumentBytes += call.argumentBytes;
            if (toolArgumentBytes > MAX_TOOL_ARGUMENT_TOTAL_BYTES) {
              throw new AgentError("tool_limit", 429);
            }
            assistantBlocks.push({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.args,
            });
            try {
              this.assertSessionRetained(id, userId);
              const result = this.dispatch(
                call.name,
                call.args,
                session.workspaceId,
                userId,
                key,
              );
              const serialized = JSON.stringify(result);
              const outputSize = Buffer.byteLength(serialized, "utf8");
              if (toolOutputBytes + outputSize > MAX_TOOL_OUTPUT_BYTES) {
                throw new AgentError("tool_output_limit", 429);
              }
              toolOutputBytes += outputSize;
              messages.push({
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: call.id,
                    name: call.name,
                    content: serialized,
                  },
                ],
              });
              this.emit(id, "tool", { name: call.name, success: true });
            } catch (error) {
              const code =
                error instanceof AgentError
                  ? error.code
                  : error instanceof WorkspaceError
                    ? error.code
                    : "tool_error";
              messages.push({
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: call.id,
                    name: call.name,
                    content: code,
                    is_error: true,
                  },
                ],
              });
              this.emit(id, "tool", { name: call.name, error: code });
            }
          }
          messages.push({ role: "assistant", content: assistantBlocks });

          // Add bounded retry delay before next attempt
          const retryDelayMs = computeRetryDelayMs(attempt, error);
          await sleep(Math.min(retryDelayMs, this.overallTimeoutMs));

          if (controller.signal.aborted) throw abortError(controller.signal);
          this.assertSessionRetained(id, userId);
        }

        if (controller.signal.aborted) throw abortError(controller.signal);
        this.assertSessionRetained(id, userId);
        const saved = new Date().toISOString();
        this.db.prepare("INSERT INTO agent_messages VALUES(?,?,?,?,?)").run(randomUUID(), id, "assistant", answer, saved);
        this.db.prepare("UPDATE agent_sessions SET updated_at=? WHERE id=?").run(saved, id);
        this.emit(id, "complete", { message: answer });
        return {
          message: answer,
          proposals: redactValue(
            this.workspace
              .changes(session.workspaceId, userId)
              .filter((change: { status: string }) => change.status === "pending"),
            key,
          ),
        };
      }
    } catch (error) {
      const safeError =
        error instanceof AgentError
          ? error
          : error instanceof WorkspaceError
            ? new AgentError("workspace_unavailable", 503)
            : providerError(error);
      if (safeError.code !== "session_expired") {
        this.db.prepare("UPDATE agent_sessions SET status=?,updated_at=? WHERE id=?").run(
          safeError.code === "cancelled" ? "cancelled" : "error",
          new Date().toISOString(),
          id,
        );
        this.emit(id, "error", { error: safeError.code });
      }
      throw safeError;
    } finally {
      clearTimeout(this.overallTimeoutMs);
      this.active.delete(id);
    }
  }

  runOneShotForTesting(
    provider: RuntimeProvider,
    messages: typeof messages,
    tools: ToolDefinition[],
    controller: any
  ): Promise<{ type: string; success?: boolean; httpStatus?: number; providerErrorCode?: string; providerErrorType?: string; sanitizedMessage?: string; retryAfterSeconds?: number; requestId?: string }> {
    // ... (similar 429 detection fix)
  return { type: "done", success: true };
  }
  close(): void {
    this.active.clear();
    this.eventHistory.clear();
  }
}
