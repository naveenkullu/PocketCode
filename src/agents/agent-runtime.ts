import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ContentBlock, Message, ToolDefinition } from "@cline/llms";
import { resolveUserAiConfiguration } from "../auth/ai-provider-configuration.js";
import type { WorkspaceService } from "../workspaces/workspace-service.js";
import {
  MAX_FILE_BYTES,
  validateWorkspacePath,
  WorkspaceError,
} from "../workspaces/workspace-service.js";
import { createRuntimeProvider, type RuntimeProvider } from "./provider-adapter.js";
import {
  containsDetectedSecret,
  redactProviderMessages,
  scanAndRedactSecrets,
} from "./secret-scanner.js";

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
const MAX_LISTED_FILES = 200;
const MAX_SEARCH_MATCHES = 60;
const MAX_PENDING_PROPOSALS = 24;
const MAX_PENDING_PROPOSAL_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 120_000;

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
    name: "search_code",
    description: "Search literal text in workspace files.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_create_file",
    description: "Propose creating a file; it is not applied until user approval.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_edit_file",
    description: "Propose editing a file; it is not applied until user approval.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_delete_file",
    description: "Propose deleting a file; it is not applied until user approval.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

type Event = { id: string; type: string; data: unknown };
type ProviderFactory = (providerId: string, modelId: string, key: string) => RuntimeProvider;
type ActiveRun = { controller: AbortController; userId: string };
type SessionMessage = { role: "user" | "assistant"; content: string; createdAt: string };
type AgentSessionRow = {
  id: string;
  workspaceId: string;
  providerId: string;
  modelId: string;
  status: "active" | "complete" | "cancelled" | "error";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  messages: SessionMessage[];
};
type ToolCall = { id: string; name: string; args: Record<string, unknown>; argumentBytes: number };
type RuntimeOptions = { requestTimeoutMs?: number; overallTimeoutMs?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactText(value: string, secret: string): string {
  return secret ? value.split(secret).join("[REDACTED]") : value;
}

function redactValue(value: unknown, secret: string, depth = 0): unknown {
  if (depth >= 12) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret, depth + 1));
  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    output[redactText(key, secret)] = redactValue(child, secret, depth + 1);
  }
  return output;
}

function abortError(signal: AbortSignal): AgentError {
  if (signal.reason === "timeout") return new AgentError("provider_timeout", 504);
  if (signal.reason === "expired") return new AgentError("session_expired", 410);
  return new AgentError("cancelled", 499);
}

export interface ProviderErrorDiagnostics {
  httpStatus?: number;
  providerErrorCode?: string;
  providerErrorType?: string;
  sanitizedMessage?: string;
  retryAfterSeconds?: number;
  requestId?: string;
}

export function extractProviderErrorDetails(error: unknown): ProviderErrorDiagnostics {
  let current: unknown = error;
  const details: ProviderErrorDiagnostics = {};

  for (let depth = 0; depth < 5 && isRecord(current); depth++) {
    // HTTP status
    if (details.httpStatus === undefined) {
      for (const candidate of [current.statusCode, current.status]) {
        if (typeof candidate === "number" && Number.isInteger(candidate)) {
          details.httpStatus = candidate;
          break;
        }
      }
    }

    // Provider error code/type
    if (details.providerErrorCode === undefined && typeof current.code === "string") {
      details.providerErrorCode = current.code;
    }
    if (details.providerErrorType === undefined && typeof current.type === "string") {
      details.providerErrorType = current.type;
    }

    // Sanitized message (first 500 chars, no secrets)
    if (details.sanitizedMessage === undefined && typeof current.message === "string") {
      const msg = current.message.slice(0, 500);
      // Redact common secret patterns
      details.sanitizedMessage = msg
        .replace(/sk-[a-zA-Z0-9]{20,}/g, "[REDACTED_API_KEY]")
        .replace(/gh[psu]_[a-zA-Z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
        .replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/g, "Bearer [REDACTED]")
        .replace(/Authorization:\s*[^\s]+/g, "Authorization: [REDACTED]");
    }

    // Retry-After header
    if (details.retryAfterSeconds === undefined) {
      const retryAfter = current.retryAfter ?? current["retry-after"] ?? current["Retry-After"];
      if (typeof retryAfter === "string") {
        const parsed = parseInt(retryAfter, 10);
        if (!Number.isNaN(parsed)) details.retryAfterSeconds = parsed;
      } else if (typeof retryAfter === "number") {
        details.retryAfterSeconds = retryAfter;
      }
    }

    // Request ID (common headers)
    if (details.requestId === undefined) {
      const reqId = current.requestId ?? current["x-request-id"] ?? current["X-Request-ID"] ?? current["request-id"];
      if (typeof reqId === "string" && reqId.length > 0 && reqId.length < 128) {
        details.requestId = reqId;
      }
    }

    const response = current.response;
    if (isRecord(response)) {
      if (details.httpStatus === undefined && typeof response.status === "number") {
        details.httpStatus = response.status;
      }
      if (details.requestId === undefined) {
        const headers = response.headers as Record<string, string | string[] | undefined> | undefined;
        const reqId = headers?.["x-request-id"] ?? headers?.["X-Request-ID"] ?? headers?.["request-id"];
        if (typeof reqId === "string" && reqId.length > 0 && reqId.length < 128) {
          details.requestId = reqId;
        }
      }
      if (details.retryAfterSeconds === undefined) {
        const headers = response.headers as Record<string, string | string[] | undefined> | undefined;
        const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
        if (typeof retryAfter === "string") {
          const parsed = parseInt(retryAfter, 10);
          if (!Number.isNaN(parsed)) details.retryAfterSeconds = parsed;
        } else if (typeof retryAfter === "number") {
          details.retryAfterSeconds = retryAfter;
        }
      }
    }

    current = current.cause;
  }

  return details;
}

export function providerStatus(error: unknown): number | undefined {
  const details = extractProviderErrorDetails(error);
  return details.httpStatus;
}

function isProviderTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth++) {
    if (
      current.name === "TimeoutError" ||
      current.code === "ETIMEDOUT" ||
      current.code === "ESOCKETTIMEDOUT" ||
      current.code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export function providerError(error: unknown): AgentError {
  const details = extractProviderErrorDetails(error);
  const status = details.httpStatus;

  // Timeout detection (check before status)
  if (isProviderTimeout(error)) {
    return new AgentError("provider_timeout", 504, {
      httpStatus: status,
      providerErrorCode: details.providerErrorCode,
      providerErrorType: details.providerErrorType,
      sanitizedMessage: details.sanitizedMessage,
      retryAfterSeconds: details.retryAfterSeconds,
      requestId: details.requestId,
    });
  }

  // Map HTTP status to specific error codes
  let code: string;
  let statusCode: number;

  if (status !== undefined) {
    if (status === 400) {
      code = "provider_bad_request";
      statusCode = 400;
    } else if (status === 401 || status === 403) {
      code = "provider_auth_error";
      statusCode = 401;
    } else if (status === 413) {
      code = "provider_payload_too_large";
      statusCode = 413;
    } else if (status === 429) {
      code = "provider_rate_limited";
      statusCode = 429;
    } else if (status >= 500 && status < 600) {
      code = "provider_unavailable";
      statusCode = 503;
    } else if (status >= 400 && status < 500) {
      code = "provider_bad_request";
      statusCode = status;
    } else {
      code = "provider_error";
      statusCode = 502;
    }
  } else if (isNetworkError(error)) {
    // Network/connection errors without HTTP status
    code = "provider_connection_error";
    statusCode = 502;
  } else {
    code = "provider_error";
    statusCode = 502;
  }

  return new AgentError(code, statusCode, {
    httpStatus: status,
    providerErrorCode: details.providerErrorCode,
    providerErrorType: details.providerErrorType,
    sanitizedMessage: details.sanitizedMessage,
    retryAfterSeconds: details.retryAfterSeconds,
    requestId: details.requestId,
  });
}

export function isNetworkError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && isRecord(current); depth++) {
    const code = current.code;
    if (typeof code === "string") {
      if (
        code === "ECONNREFUSED" ||
        code === "ENOTFOUND" ||
        code === "ETIMEDOUT" ||
        code === "ESOCKETTIMEDOUT" ||
        code === "ENETUNREACH" ||
        code === "EAI_AGAIN" ||
        code === "UND_ERR_CONNECT_TIMEOUT" ||
        code === "UND_ERR_SOCKET_TIMEOUT"
      ) {
        return true;
      }
    }
    const name = current.name;
    if (typeof name === "string" && (name === "FetchError" || name === "NetworkError" || name === "TypeError")) {
      const message = current.message;
      if (typeof message === "string" &&
        (message.includes("fetch failed") || message.includes("network") || message.includes("connection"))) {
        return true;
      }
    }
    current = current.cause;
  }
  return false;
}

function parseToolCall(value: unknown, secret: string): ToolCall {
  if (!isRecord(value) || !isRecord(value.function)) {
    throw new AgentError("invalid_provider_response", 502);
  }
  const fn = value.function;
  if (
    typeof fn.name !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(fn.name) ||
    (fn.arguments !== undefined && typeof fn.arguments !== "string" && !isRecord(fn.arguments))
  ) {
    throw new AgentError("invalid_provider_response", 502);
  }

  let args: unknown = fn.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      throw new AgentError("invalid_provider_response", 502);
    }
  }
  if (!isRecord(args) || (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null)) {
    throw new AgentError("invalid_provider_response", 502);
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(args);
  } catch {
    throw new AgentError("invalid_provider_response", 502);
  }
  if (Buffer.byteLength(encoded) > MAX_TOOL_ARGUMENT_BYTES) {
    throw new AgentError("invalid_tool_arguments", 400);
  }

  const id = value.call_id ?? fn.id;
  if (id !== undefined && (typeof id !== "string" || !id || id.length > 256)) {
    throw new AgentError("invalid_provider_response", 502);
  }
  const safeId = typeof id === "string" ? redactText(id, secret) : "";
  return {
    id: safeId || randomUUID(),
    name: fn.name,
    args,
    argumentBytes: Buffer.byteLength(encoded),
  };
}

function truncateUtf8(value: string, limit: number): string {
  return new TextDecoder().decode(Buffer.from(value, "utf8").subarray(0, limit));
}

export class AgentRuntime {
  private readonly active = new Map<string, ActiveRun>();
  private readonly eventHistory = new Map<string, Event[]>();
  private readonly requestTimeoutMs: number;
  private readonly overallTimeoutMs: number;

  constructor(
    private readonly db: Database.Database,
    private readonly workspace: WorkspaceService,
    private readonly encryptionKey: string,
    private readonly providerFactory: ProviderFactory = createRuntimeProvider,
    options: RuntimeOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
    this.cleanupExpired();
  }

  private cleanupExpired(): void {
    const now = new Date().toISOString();
    const expired = this.db
      .prepare("SELECT id FROM agent_sessions WHERE expires_at<=?")
      .all(now) as Array<{ id: string }>;
    for (const { id } of expired) {
      this.active.get(id)?.controller.abort("expired");
      this.eventHistory.delete(id);
    }
    this.db.prepare("DELETE FROM agent_sessions WHERE expires_at<=?").run(now);
    this.workspace.cleanupExpired();
  }

  private resolveConfiguration(userId: string) {
    try {
      return resolveUserAiConfiguration(this.db, userId, this.encryptionKey);
    } catch {
      throw new AgentError("credential_unavailable", 503);
    }
  }

  create(userId: string, workspaceId: string) {
    this.cleanupExpired();
    const info = this.workspace.getInfo(workspaceId, userId);
    const setting = this.resolveConfiguration(userId);
    if (!setting) throw new AgentError("provider_not_configured", 400);
    if (!setting.apiKey) throw new AgentError("credential_missing", 400);

    const id = randomUUID();
    const now = new Date();
    const expires = new Date(
      Math.min(Date.parse(info.expiresAt), now.getTime() + SESSION_TTL_MS),
    ).toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_sessions
          (id,user_id,workspace_id,provider_id,model_id,status,created_at,updated_at,expires_at)
         VALUES(?,?,?,?,?,'active',?,?,?)`,
      )
      .run(
        id,
        userId,
        workspaceId,
        setting.providerId,
        setting.modelId,
        now.toISOString(),
        now.toISOString(),
        expires,
      );
    return {
      id,
      workspaceId,
      providerId: setting.providerId,
      modelId: setting.modelId,
      status: "active",
      expiresAt: expires,
    };
  }

  list(userId: string) {
    this.cleanupExpired();
    return this.db
      .prepare(
        `SELECT id,workspace_id AS workspaceId,provider_id AS providerId,model_id AS modelId,
          status,created_at AS createdAt,updated_at AS updatedAt,expires_at AS expiresAt
         FROM agent_sessions WHERE user_id=? AND expires_at>? ORDER BY updated_at DESC`,
      )
      .all(userId, new Date().toISOString());
  }

  get(id: string, userId: string): AgentSessionRow {
    this.cleanupExpired();
    const row = this.db
      .prepare(
        `SELECT id,workspace_id AS workspaceId,provider_id AS providerId,model_id AS modelId,
          status,created_at AS createdAt,updated_at AS updatedAt,expires_at AS expiresAt
         FROM agent_sessions WHERE id=? AND user_id=? AND expires_at>?`,
      )
      .get(id, userId, new Date().toISOString()) as Omit<AgentSessionRow, "messages"> | undefined;
    if (!row) throw new AgentError("session_not_found", 404);
    try {
      this.workspace.getInfo(row.workspaceId, userId);
    } catch {
      throw new AgentError("session_not_found", 404);
    }
    const storedMessages = this.db
      .prepare(
        `SELECT role,content,created_at AS createdAt FROM agent_messages
         WHERE session_id=? ORDER BY created_at,id`,
      )
      .all(id) as SessionMessage[];
    const configuredCredential = this.resolveConfiguration(userId)?.apiKey ?? "";
    const messages = storedMessages.map((message) => ({
      ...message,
      content: redactText(
        scanAndRedactSecrets(message.content).content,
        configuredCredential,
      ),
    }));
    return { ...row, messages };
  }

  close(): void {
    for (const active of this.active.values()) active.controller.abort("shutdown");
    this.active.clear();
    this.cleanupExpired();
  }

  cancel(id: string, userId: string): void {
    const session = this.get(id, userId);
    if (session.status !== "active") throw new AgentError("session_not_active", 409);
    this.active.get(id)?.controller.abort("cancelled");
    this.db
      .prepare("UPDATE agent_sessions SET status='cancelled',updated_at=? WHERE id=? AND user_id=?")
      .run(new Date().toISOString(), id, userId);
    this.emit(id, "cancelled", {});
  }

  events(id: string, userId: string): Event[] {
    this.get(id, userId);
    return (this.eventHistory.get(id) ?? []).slice(-100);
  }

  private emit(id: string, type: string, data: unknown): void {
    const history = this.eventHistory.get(id) ?? [];
    history.push({ id: randomUUID(), type, data });
    if (history.length > 100) history.shift();
    this.eventHistory.set(id, history);
  }

  private assertSessionRetained(id: string, userId: string): void {
    const row = this.db
      .prepare("SELECT 1 FROM agent_sessions WHERE id=? AND user_id=?")
      .get(id, userId);
    if (!row) {
      this.eventHistory.delete(id);
      throw new AgentError("session_not_found", 404);
    }
  }

  async runOneShotForTesting(id: string, userId: string, task: unknown) {
    if (process.env.NODE_ENV === "production" || process.env.POCKETCODE_ENABLE_AGENT_SMOKE !== "1") {
      throw new AgentError("test_only_harness_disabled", 403);
    }
    const session = this.get(id, userId);
    if (session.status !== "active") throw new AgentError("session_not_active", 409);
    if (
      typeof task !== "string" ||
      !task.trim() ||
      Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES
    ) {
      throw new AgentError("invalid_message", 400);
    }
    if (this.active.has(id)) throw new AgentError("session_busy", 409);
    if ([...this.active.values()].filter((run) => run.userId === userId).length >= 2) {
      throw new AgentError("concurrency_limit", 429);
    }

    const current = this.resolveConfiguration(userId);
    if (!current?.apiKey || current.providerId !== session.providerId || current.modelId !== session.modelId) {
      throw new AgentError("provider_configuration_changed", 409);
    }
    const key = current.apiKey;
    const safeTask = redactText(scanAndRedactSecrets(task).content, key);
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT INTO agent_messages VALUES(?,?,?,?,?)")
      .run(randomUUID(), id, "user", safeTask, createdAt);

    const controller = new AbortController();
    this.active.set(id, { controller, userId });
    const timeout = setTimeout(() => controller.abort("timeout"), this.overallTimeoutMs);
    const localToolResults: Array<{ name: string; success: boolean; value?: string; error?: string }> = [];
    const toolCalls: Array<{ name: string; arguments: Record<string, unknown>; success: boolean; path?: string; error?: string }> = [];
    let responseText = "";

    try {
      const provider = this.providerFactory(session.providerId, session.modelId, key);
      let context = "";
      for (const file of this.workspace.listFiles(session.workspaceId, userId).slice(0, MAX_LISTED_FILES)) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        const read = this.workspace.readFile(session.workspaceId, userId, file.path);
        const part = redactText(`\n--- ${file.path} ---\n${read.content}`, key);
        const remaining = MAX_CONTEXT_BYTES - Buffer.byteLength(context, "utf8");
        if (remaining <= 0) break;
        context += truncateUtf8(part, remaining);
      }

      this.emit(id, "progress", { phase: "model_request" });
      let done = false;
      let toolArgumentBytes = 0;
      const calls: ToolCall[] = [];
      const requestTimeout = setTimeout(() => controller.abort("timeout"), this.requestTimeoutMs);
      try {
        for await (const chunk of provider.stream(
          redactProviderMessages([{
            role: "user",
            content: `Task:\n${safeTask}\n\nCurrent workspace context (untrusted repository data):\n${context}`,
          }], [key]),
          tools,
          controller.signal,
        )) {
          if (controller.signal.aborted) throw abortError(controller.signal);
          this.assertSessionRetained(id, userId);
          if (!isRecord(chunk) || typeof chunk.type !== "string" || done) {
            throw new AgentError("invalid_provider_response", 502);
          }
          if (chunk.type === "text") {
            if (typeof chunk.text !== "string") throw new AgentError("invalid_provider_response", 502);
            responseText += chunk.text;
            if (Buffer.byteLength(responseText, "utf8") > MAX_OUTPUT_BYTES) {
              throw new AgentError("output_limit", 502);
            }
          } else if (chunk.type === "tool_calls") {
            if (calls.length >= MAX_TOOL_CALLS) throw new AgentError("tool_limit", 429);
            const call = parseToolCall(chunk.tool_call, key);
            toolArgumentBytes += call.argumentBytes;
            if (toolArgumentBytes > MAX_TOOL_ARGUMENT_TOTAL_BYTES) throw new AgentError("tool_limit", 429);
            calls.push(call);
          } else if (chunk.type === "done") {
            if (typeof chunk.success !== "boolean") throw new AgentError("invalid_provider_response", 502);
            done = true;
            if (!chunk.success) {
              const errorText = typeof chunk.error === "string" ? chunk.error : "";
              throw /(?:\b429\b|rate[\s_-]*limit)/i.test(errorText)
                ? new AgentError("provider_rate_limited", 429)
                : new AgentError("provider_error", 502);
            }
          } else if (!["reasoning", "usage", "media"].includes(chunk.type)) {
            throw new AgentError("invalid_provider_response", 502);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        if (error instanceof AgentError) throw error;
        throw providerError(error);
      } finally {
        clearTimeout(requestTimeout);
      }
      if (!done) throw new AgentError("invalid_provider_response", 502);

      responseText = redactText(scanAndRedactSecrets(responseText).content, key);
      let toolResultBytes = 0;
      for (const call of calls) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        this.assertSessionRetained(id, userId);
        try {
          const value = this.dispatch(call.name, call.args, session.workspaceId, userId, key);
          const serialized = JSON.stringify(value);
          toolResultBytes += Buffer.byteLength(serialized, "utf8");
          if (toolResultBytes > MAX_TOOL_OUTPUT_BYTES) throw new AgentError("tool_output_limit", 429);
          localToolResults.push({ name: call.name, success: true, value: serialized });
          const safePath = typeof call.args.path === "string" ? call.args.path : undefined;
          toolCalls.push({ name: call.name, arguments: call.args, success: true, ...(safePath ? { path: safePath } : {}) });
          this.emit(id, "tool", { name: call.name, success: true });
        } catch (error) {
          const code = error instanceof AgentError
            ? error.code
            : error instanceof WorkspaceError
              ? error.code
              : "tool_error";
          localToolResults.push({ name: call.name, success: false, error: code });
          toolCalls.push({ name: call.name, arguments: call.args, success: false, error: code });
          this.emit(id, "tool", { name: call.name, error: code });
        }
      }

      if (controller.signal.aborted) throw abortError(controller.signal);
      this.assertSessionRetained(id, userId);
      const saved = new Date().toISOString();
      this.db.prepare("INSERT INTO agent_messages VALUES(?,?,?,?,?)")
        .run(randomUUID(), id, "assistant", responseText, saved);
      this.db.prepare("UPDATE agent_sessions SET status='complete',updated_at=? WHERE id=? AND user_id=?")
        .run(saved, id, userId);
      this.emit(id, "complete", { message: responseText });
      return {
        message: responseText,
        toolCalls,
        proposals: redactValue(
          this.workspace.changes(session.workspaceId, userId)
            .filter((change: { status: string }) => change.status === "pending"),
          key,
        ),
      };
    } catch (error) {
      const safeError = error instanceof AgentError
        ? error
        : error instanceof WorkspaceError
          ? new AgentError("workspace_unavailable", 503)
          : providerError(error);
      this.db.prepare("UPDATE agent_sessions SET status='error',updated_at=? WHERE id=? AND user_id=?")
        .run(new Date().toISOString(), id, userId);
      this.emit(id, "error", { error: safeError.code });
      throw safeError;
    } finally {
      clearTimeout(timeout);
      localToolResults.length = 0;
      this.active.delete(id);
    }
  }

  async message(id: string, userId: string, task: unknown) {
    const session = this.get(id, userId);
    if (session.status !== "active") throw new AgentError("session_not_active", 409);
    if (
      typeof task !== "string" ||
      !task.trim() ||
      Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES
    ) {
      throw new AgentError("invalid_message", 400);
    }
    if (this.active.has(id)) throw new AgentError("session_busy", 409);
    if ([...this.active.values()].filter((run) => run.userId === userId).length >= 2) {
      throw new AgentError("concurrency_limit", 429);
    }

    const conversationCount = (
      this.db.prepare("SELECT count(*) AS n FROM agent_messages WHERE session_id=?").get(id) as {
        n: number;
      }
    ).n;
    if (conversationCount >= MAX_MESSAGES) throw new AgentError("message_limit", 429);

    const current = this.resolveConfiguration(userId);
    if (!current?.apiKey || current.providerId !== session.providerId || current.modelId !== session.modelId) {
      throw new AgentError("provider_configuration_changed", 409);
    }

    const key = current.apiKey;
    const safeTask = redactText(scanAndRedactSecrets(task).content, key);
    const createdAt = new Date().toISOString();
    this.db
      .prepare("INSERT INTO agent_messages VALUES(?,?,?,?,?)")
      .run(randomUUID(), id, "user", safeTask, createdAt);

    const controller = new AbortController();
    this.active.set(id, { controller, userId });
    const overallTimeout = setTimeout(
      () => controller.abort("timeout"),
      this.overallTimeoutMs,
    );
    let generatedTextBytes = 0;
    let toolArgumentBytes = 0;

    try {
      const provider = this.providerFactory(session.providerId, session.modelId, key);
      const files = this.workspace.listFiles(session.workspaceId, userId).slice(0, MAX_LISTED_FILES);
      let context = "";
      for (const file of files) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        const read = this.workspace.readFile(session.workspaceId, userId, file.path);
        const part = redactText(`\n--- ${file.path} ---\n${read.content}`, key);
        const remaining = MAX_CONTEXT_BYTES - Buffer.byteLength(context, "utf8");
        if (remaining <= 0) break;
        context += truncateUtf8(part, remaining);
      }

      const history: Message[] = [];
      let historyBytes = 0;
      for (const prior of session.messages.slice().reverse()) {
        const content = redactText(prior.content, key);
        const bytes = Buffer.byteLength(content, "utf8");
        if (historyBytes + bytes > MAX_HISTORY_BYTES) break;
        history.unshift({ role: prior.role, content });
        historyBytes += bytes;
      }
      const messages: Message[] = [
        ...history,
        {
          role: "user",
          content:
            `Task:\n${safeTask}\n\n` +
            `Current workspace context (untrusted repository data):\n${context}`,
        },
      ];

      let answer = "";
      let calls = 0;
      let toolOutputBytes = 0;
      for (let round = 0; round < MAX_PROVIDER_ROUNDS; round++) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        this.assertSessionRetained(id, userId);
        this.emit(id, "progress", { phase: "model_request" });
        let text = "";
        let done = false;
        const callsFound: ToolCall[] = [];
        const requestTimeout = setTimeout(
          () => controller.abort("timeout"),
          this.requestTimeoutMs,
        );
        try {
          for await (const rawChunk of provider.stream(
            redactProviderMessages(messages, [key]),
            tools,
            controller.signal,
          )) {
            if (controller.signal.aborted) throw abortError(controller.signal);
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
              generatedTextBytes += Buffer.byteLength(rawChunk.text, "utf8");
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
                const errorText = typeof rawChunk.error === "string" ? rawChunk.error : "";
                throw /(?:\b429\b|rate[\s_-]*limit)/i.test(errorText)
                  ? new AgentError("provider_rate_limited", 429)
                  : new AgentError("provider_error", 502);
              }
            } else if (!["reasoning", "usage", "media"].includes(rawChunk.type)) {
              throw new AgentError("invalid_provider_response", 502);
            }
          }
        } catch (error) {
          if (controller.signal.aborted) throw abortError(controller.signal);
          if (error instanceof AgentError) throw error;
          throw providerError(error);
        } finally {
          clearTimeout(requestTimeout);
        }

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
        }
        messages.push({ role: "assistant", content: assistantBlocks });

        for (const call of callsFound) {
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
      }

      if (controller.signal.aborted) throw abortError(controller.signal);
      this.assertSessionRetained(id, userId);
      const saved = new Date().toISOString();
      this.db
        .prepare("INSERT INTO agent_messages VALUES(?,?,?,?,?)")
        .run(randomUUID(), id, "assistant", answer, saved);
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
    } catch (error) {
      const safeError =
        error instanceof AgentError
          ? error
          : error instanceof WorkspaceError
            ? new AgentError("workspace_unavailable", 503)
            : providerError(error);
      if (safeError.code !== "session_expired") {
        this.db
          .prepare("UPDATE agent_sessions SET status=?,updated_at=? WHERE id=?")
          .run(
            safeError.code === "cancelled" ? "cancelled" : "error",
            new Date().toISOString(),
            id,
          );
        this.emit(id, "error", { error: safeError.code });
      }
      throw safeError;
    } finally {
      clearTimeout(overallTimeout);
      this.active.delete(id);
    }
  }

  private dispatch(
    name: string,
    args: Record<string, unknown>,
    workspaceId: string,
    userId: string,
    configuredCredential: string,
  ): unknown {
    const pathArg = (): string => {
      if (typeof args.path !== "string") throw new AgentError("invalid_tool_arguments", 400);
      if (containsDetectedSecret(args.path) || args.path.includes(configuredCredential)) {
        throw new AgentError("sensitive_tool_argument", 400);
      }
      try {
        return validateWorkspacePath(args.path);
      } catch {
        throw new AgentError("invalid_tool_arguments", 400);
      }
    };

    if (name === "list_files") {
      if (Object.keys(args).length) throw new AgentError("invalid_tool_arguments", 400);
      return this.workspace.listFiles(workspaceId, userId).slice(0, MAX_LISTED_FILES);
    }
    if (name === "read_file") {
      if (Object.keys(args).length !== 1) throw new AgentError("invalid_tool_arguments", 400);
      const result = this.workspace.readFile(workspaceId, userId, pathArg());
      return {
        path: result.path,
        content: truncateUtf8(result.content, MAX_OUTPUT_BYTES),
      };
    }
    if (name === "search_code") {
      if (
        Object.keys(args).length !== 1 ||
        typeof args.query !== "string" ||
        !args.query ||
        args.query.length > 200
      ) {
        throw new AgentError("invalid_tool_arguments", 400);
      }
      const query = args.query.toLowerCase();
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const file of this.workspace.listFiles(workspaceId, userId).slice(0, MAX_LISTED_FILES)) {
        const content = this.workspace.readFile(workspaceId, userId, file.path).content;
        for (const [index, line] of content.split("\n").entries()) {
          if (!line.toLowerCase().includes(query)) continue;
          matches.push({ path: file.path, line: index + 1, text: line.slice(0, 300) });
          if (matches.length >= MAX_SEARCH_MATCHES) return matches;
        }
      }
      return matches;
    }
    if (name === "propose_create_file" || name === "propose_edit_file") {
      if (
        Object.keys(args).length !== 2 ||
        typeof args.content !== "string"
      ) {
        throw new AgentError("invalid_tool_arguments", 400);
      }
      if (
        containsDetectedSecret(args.content) ||
        args.content.includes(configuredCredential)
      ) {
        throw new AgentError("sensitive_proposal_rejected", 400);
      }
      this.enforceProposalLimits(workspaceId, userId, args.content);
      const proposal = this.workspace.propose(
        workspaceId,
        userId,
        name === "propose_create_file" ? "create_file" : "edit_file",
        pathArg(),
        args.content,
      );
      return {
        id: proposal.id,
        operation: proposal.operation,
        path: proposal.path,
        status: proposal.status,
      };
    }
    if (name === "propose_delete_file") {
      if (Object.keys(args).length !== 1) throw new AgentError("invalid_tool_arguments", 400);
      this.enforceProposalLimits(workspaceId, userId);
      const proposal = this.workspace.propose(
        workspaceId,
        userId,
        "delete_file",
        pathArg(),
      );
      return {
        id: proposal.id,
        operation: proposal.operation,
        path: proposal.path,
        status: proposal.status,
      };
    }
    throw new AgentError("tool_not_allowed", 400);
  }

  private enforceProposalLimits(
    workspaceId: string,
    userId: string,
    content?: string,
  ): void {
    const pending = this.workspace
      .changes(workspaceId, userId)
      .filter((change: { status: string }) => change.status === "pending");
    const pendingBytes = pending.reduce(
      (total: number, change: { proposed: string | null }) =>
        total + (change.proposed ? Buffer.byteLength(change.proposed, "utf8") : 0),
      0,
    );
    if (
      pending.length >= MAX_PENDING_PROPOSALS ||
      pendingBytes + (content ? Buffer.byteLength(content, "utf8") : 0) >
        MAX_PENDING_PROPOSAL_BYTES
    ) {
      throw new AgentError("proposal_limit", 429);
    }
  }
}

export interface ProviderErrorDiagnostics {
  httpStatus?: number;
  providerErrorCode?: string;
  providerErrorType?: string;
  sanitizedMessage?: string;
  retryAfterSeconds?: number;
  requestId?: string;
}

export class AgentError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 400,
    readonly diagnostics?: ProviderErrorDiagnostics,
  ) {
    super(code);
    this.name = "AgentError";
  }
}
