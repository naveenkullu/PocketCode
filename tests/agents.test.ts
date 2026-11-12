import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { createSession } from "../src/auth/session-service.js";
import { encryptToken } from "../src/auth/token-encryption.js";
import { openDatabase } from "../src/storage/database.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";
import { AgentRuntime, AgentError } from "../src/agents/agent-runtime.js";
import { createRuntimeProvider, createSingleRequestFetch } from "../src/agents/provider-adapter.js";
import { createServer } from "../src/server/index.js";
import type { RuntimeProvider } from "../src/agents/provider-adapter.js";
import { up as clearLegacyAgentHistory } from "../src/storage/migrations/008_clear_legacy_agent_history.js";

const KEY = "0123456789abcdef".repeat(4);
const API_KEY = "secret-user-key-never-return-this";
const TOOL_NAMES = [
  "list_files",
  "read_file",
  "search_code",
  "propose_create_file",
  "propose_edit_file",
  "propose_delete_file",
];
type ProviderFactory = (providerId: string, modelId: string, key: string) => RuntimeProvider;

function fixture(factory?: ProviderFactory, runtimeOptions?: { requestTimeoutMs?: number; overallTimeoutMs?: number }) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "pocketcode-agent-"));
  const db = openDatabase(":memory:");
  for (const id of ["u1", "u2"]) {
    db.prepare("INSERT INTO users(id,github_username) VALUES(?,?)").run(id, id);
  }
  const s1 = createSession(db, "u1");
  const s2 = createSession(db, "u2");
  const sessionId = (userId: string) =>
    (db.prepare("SELECT id FROM sessions WHERE user_id=?").get(userId) as { id: string }).id;
  const ws = new WorkspaceService(db, { rootDirectory: path.join(temp, "ws") });
  const w1 = ws.create("u1", sessionId("u1"), "123", "main", "sha", [
    { path: "src/a.ts", content: "hello world\n" },
  ]);
  const w2 = ws.create("u2", sessionId("u2"), "456", "main", "sha", [
    { path: "src/b.ts", content: "other user's file\n" },
  ]);
  db.prepare(
    "INSERT INTO user_ai_provider_settings(user_id,provider_id,model_id) VALUES('u1','openai-compatible','test-model')",
  ).run();
  db.prepare(
    "INSERT INTO user_ai_provider_credentials(user_id,provider_id,encrypted_api_key) VALUES('u1','openai-compatible',?)",
  ).run(encryptToken(API_KEY, KEY));
  const runtime = new AgentRuntime(db, ws, KEY, factory, runtimeOptions);
  return { temp, db, s1, s2, ws, w1, w2, runtime, sessionId };
}

function sessionHeaders(f: ReturnType<typeof fixture>, token: string, userId: string) {
  const sid = f.sessionId(userId);
  return {
    cookie: `pocketcode_session=${token}`,
    origin: "http://localhost:3000",
    "x-csrf-token": createHmac("sha256", Buffer.from(KEY, "hex"))
      .update(`pocketcode-csrf:${sid}`)
      .digest("base64url"),
  };
}

function toolCall(name: string, args: unknown, id = name) {
  return {
    type: "tool_calls",
    id: "response",
    tool_call: { call_id: id, function: { name, arguments: args } },
  } as const;
}

function done() {
  return { type: "done", id: "response", success: true } as const;
}

function cleanup(f: ReturnType<typeof fixture>) {
  f.runtime.close();
  f.db.close();
  rmSync(f.temp, { recursive: true, force: true });
}

async function cleanupWithServer(f: ReturnType<typeof fixture>, app: ReturnType<typeof createServer>) {
  f.runtime.close();
  await app.close();
  rmSync(f.temp, { recursive: true, force: true });
}

function createTestServer(f: ReturnType<typeof fixture>) {
  return createServer({
    config: {
      port: 3000,
      host: "127.0.0.1",
      publicBaseUrl: "http://localhost:3000",
      githubApp: { tokenEncryptionKey: KEY },
    },
    database: f.db,
    workspaceRoot: path.join(f.temp, "server-ws"),
  });
}

describe("custom agent runtime", () => {
  it("resolves the selected provider/model and decrypts only the authenticated user's key", async () => {
    const received: Array<[string, string, string]> = [];
    const f = fixture((providerId, modelId, key) => {
      received.push([providerId, modelId, key]);
      return {
        async *stream() {
          yield { type: "text", id: "r", text: "ok" } as const;
          yield done();
        },
      };
    });
    try {
      const session = f.runtime.create("u1", f.w1.id);
      assert.equal(session.providerId, "openai-compatible");
      assert.equal(session.modelId, "test-model");
      await f.runtime.message(session.id, "u1", "hello");
      assert.deepEqual(received, [["openai-compatible", "test-model", API_KEY]]);
      assert.throws(() => f.runtime.create("u2", f.w1.id));
      await assert.rejects(
        f.runtime.message(session.id, "u2", "hello"),
        (error: AgentError) => error.code === "session_not_found",
      );

      f.db
        .prepare("INSERT INTO user_ai_provider_settings(user_id,provider_id,model_id) VALUES('u2','gemini','u2-model')")
        .run();
      f.db
        .prepare(
          "INSERT INTO user_ai_provider_credentials(user_id,provider_id,encrypted_api_key) VALUES('u2','gemini',?)",
        )
        .run(encryptToken("u2-only-key", KEY));
      const other = f.runtime.create("u2", f.w2.id);
      await f.runtime.message(other.id, "u2", "hello");
      assert.deepEqual(received[1], ["gemini", "u2-model", "u2-only-key"]);
      assert.throws(() => f.runtime.get(session.id, "u2"), (error: AgentError) => error.code === "session_not_found");
    } finally {
      cleanup(f);
    }
  });

  it("constructs installed handlers for each configured provider without sending a request", () => {
    for (const providerId of ["gemini", "openai-compatible", "anthropic", "groq", "openrouter"]) {
      assert.equal(
        typeof createRuntimeProvider(providerId, "configured-model", "mock-key").stream,
        "function",
      );
    }
    assert.throws(() => createRuntimeProvider("unsupported", "model", "mock-key"));
    assert.throws(() => createRuntimeProvider("gemini", "", "mock-key"));
  });

  it("runs a one-shot tool response once and keeps two-file proposals unapplied until decisions", async () => {
    let streamCalls = 0;
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    const f = fixture(() => ({
      async *stream(messages, passedTools) {
        streamCalls++;
        assert.equal(messages.length, 1);
        assert.deepEqual(passedTools.map((tool) => tool.name), TOOL_NAMES);
        yield { type: "text", id: "response", text: "I inspected both source files." } as const;
        yield toolCall("list_files", {});
        yield toolCall("read_file", { path: "src/a.ts" });
        yield toolCall("read_file", { path: "src/b.ts" });
        yield toolCall("propose_edit_file", { path: "src/a.ts", content: "export const a = 'updated';\n" });
        yield toolCall("propose_edit_file", { path: "src/b.ts", content: "export const b = 'updated';\n" });
        yield done();
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/a.ts", content: "hello world\n" },
        { path: "src/b.ts", content: "other user's file\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      const result = await f.runtime.runOneShotForTesting(
        session.id,
        "u1",
        "Inspect both files and propose coordinated edits to both files. Do not apply changes.",
      );
      assert.equal(streamCalls, 1);
      assert.deepEqual(result.toolCalls.map(({ name }) => name), [
        "list_files", "read_file", "read_file", "propose_edit_file", "propose_edit_file",
      ]);
      assert.ok(result.toolCalls.every(({ success }) => success));
      assert.equal(result.proposals.length, 2);
      assert.deepEqual(f.ws.readFile(workspace.id, "u1", "src/a.ts").content, "hello world\n");
      assert.deepEqual(f.ws.readFile(workspace.id, "u1", "src/b.ts").content, "other user's file\n");

      const byPath = new Map(result.proposals.map((proposal: { path: string; id: string }) => [proposal.path, proposal.id]));
      assert.equal(f.ws.decide(workspace.id, "u1", byPath.get("src/b.ts")!, "reject").status, "rejected");
      assert.deepEqual(f.ws.readFile(workspace.id, "u1", "src/a.ts").content, "hello world\n");
      assert.deepEqual(f.ws.readFile(workspace.id, "u1", "src/b.ts").content, "other user's file\n");
      assert.equal(f.ws.decide(workspace.id, "u1", byPath.get("src/a.ts")!, "approve").status, "approved");
      assert.deepEqual(f.ws.readFile(workspace.id, "u1", "src/a.ts").content, "export const a = 'updated';\n");
      assert.deepEqual(f.ws.readFile(workspace.id, "u1", "src/b.ts").content, "other user's file\n");

      const persisted = f.db.prepare("SELECT role,content FROM agent_messages WHERE session_id=?").all(session.id) as Array<{ role: string; content: string }>;
      const eventPayload = JSON.stringify(f.runtime.events(session.id, "u1"));
      assert.deepEqual(persisted.map(({ role }) => role), ["user", "assistant"]);
      assert.ok(persisted.every(({ content }) => !content.includes(API_KEY)));
      assert.equal(eventPayload.includes(API_KEY), false);
      assert.equal(f.runtime.get(session.id, "u1").status, "complete");
      assert.deepEqual(f.runtime.events(session.id, "u1").filter((event) => event.type === "tool").length, 5);
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("one-shot: list_files followed by read_file for both known files", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    const f = fixture(() => ({
      async *stream(_messages, _tools) {
        yield { type: "text", id: "response", text: "Listing and reading files." } as const;
        yield toolCall("list_files", {});
        yield toolCall("read_file", { path: "src/format.ts" });
        yield toolCall("read_file", { path: "src/summary.ts" });
        yield done();
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/format.ts", content: "export function formatName(name: string) {\n  return name.trim();\n}\n" },
        { path: "src/summary.ts", content: "import { formatName } from './format';\n\nexport function summary(name: string) {\n  return `Hello ${formatName(name)}`;\n}\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      const result = await f.runtime.runOneShotForTesting(
        session.id,
        "u1",
        "Call list_files, then read_file for src/format.ts and src/summary.ts. Do not propose edits.",
      );
      assert.deepEqual(result.toolCalls.map(({ name }) => name), ["list_files", "read_file", "read_file"]);
      assert.ok(result.toolCalls.every(({ success }) => success));
      assert.equal(result.toolCalls.find((tc) => tc.name === "read_file" && tc.arguments.path === "src/format.ts")?.success, true);
      assert.equal(result.toolCalls.find((tc) => tc.name === "read_file" && tc.arguments.path === "src/summary.ts")?.success, true);
      assert.equal(result.proposals.length, 0);
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("one-shot: missing read_file after list_files is reported", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    const f = fixture(() => ({
      async *stream(_messages, _tools) {
        yield { type: "text", id: "response", text: "Only listing files." } as const;
        yield toolCall("list_files", {});
        yield done();
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/format.ts", content: "export function formatName(name: string) {\n  return name.trim();\n}\n" },
        { path: "src/summary.ts", content: "import { formatName } from './format';\n\nexport function summary(name: string) {\n  return `Hello ${formatName(name)}`;\n}\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      const result = await f.runtime.runOneShotForTesting(
        session.id,
        "u1",
        "Call list_files, then read_file for src/format.ts and src/summary.ts. Do not propose edits.",
      );
      assert.deepEqual(result.toolCalls.map(({ name }) => name), ["list_files"]);
      assert.ok(result.toolCalls.every(({ success }) => success));
      assert.equal(result.proposals.length, 0);
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("one-shot: multiple proposal tool calls are recorded", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    const f = fixture(() => ({
      async *stream(_messages, _tools) {
        yield { type: "text", id: "response", text: "Proposing multiple edits." } as const;
        yield toolCall("list_files", {});
        yield toolCall("read_file", { path: "src/a.ts" });
        yield toolCall("read_file", { path: "src/b.ts" });
        yield toolCall("propose_edit_file", { path: "src/a.ts", content: "export const a = 'updated a';\\n" });
        yield toolCall("propose_edit_file", { path: "src/b.ts", content: "export const b = 'updated b';\\n" });
        yield toolCall("propose_create_file", { path: "src/c.ts", content: "export const c = 'new';\\n" });
        yield toolCall("propose_delete_file", { path: "src/d.ts" });
        yield done();
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/a.ts", content: "hello a\n" },
        { path: "src/b.ts", content: "hello b\n" },
        { path: "src/d.ts", content: "to delete\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      const result = await f.runtime.runOneShotForTesting(
        session.id,
        "u1",
        "List, read both files, then propose edit, create, and delete.",
      );
      const proposalOps = result.proposals.map((p) => p.operation).sort();
      assert.deepEqual(proposalOps, ["create_file", "delete_file", "edit_file", "edit_file"]);
      assert.equal(result.proposals.length, 4);
      assert.ok(result.toolCalls.every(({ success }) => success));
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("one-shot: rejected and approved proposals leave correct workspace state", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    const f = fixture(() => ({
      async *stream(_messages, _tools) {
        yield { type: "text", id: "response", text: "Proposing edits to both files." } as const;
        yield toolCall("list_files", {});
        yield toolCall("read_file", { path: "src/a.ts" });
        yield toolCall("read_file", { path: "src/b.ts" });
        yield toolCall("propose_edit_file", { path: "src/a.ts", content: "export const a = 'approved';\\n" });
        yield toolCall("propose_edit_file", { path: "src/b.ts", content: "export const b = 'rejected';\\n" });
        yield done();
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/a.ts", content: "original a\n" },
        { path: "src/b.ts", content: "original b\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      const result = await f.runtime.runOneShotForTesting(
        session.id,
        "u1",
        "Propose edits to both files.",
      );
      assert.equal(result.proposals.length, 2);
      const byPath = new Map(result.proposals.map((p) => [p.path, p.id]));
      assert.equal(f.ws.decide(workspace.id, "u1", byPath.get("src/b.ts")!, "reject").status, "rejected");
      assert.deepEqual(f.ws.readFile(workspace.id, "u1", "src/b.ts").content, "original b\n");
      assert.deepEqual(f.ws.readFile(workspace.id, "u1", "src/a.ts").content, "original a\n");
      assert.equal(f.ws.decide(workspace.id, "u1", byPath.get("src/a.ts")!, "approve").status, "approved");
      assert.deepEqual(f.ws.readFile(workspace.id, "u1", "src/a.ts").content, "export const a = 'approved';\\n");
      assert.deepEqual(f.ws.readFile(workspace.id, "u1", "src/b.ts").content, "original b\n");
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("one-shot: cleanup after provider failure leaves no orphaned resources", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    const f = fixture(() => ({
      async *stream() {
        throw new Error("provider unavailable");
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/a.ts", content: "hello\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      await assert.rejects(
        f.runtime.runOneShotForTesting(session.id, "u1", "do something"),
        (error: AgentError) => error.code === "provider_error",
      );
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM workspace_changes").get().n, 0);
      assert.equal(f.runtime.get(session.id, "u1").status, "error");
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("one-shot: cleanup after tool execution failure leaves no orphaned resources", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    const f = fixture(() => ({
      async *stream(_messages, _tools) {
        yield { type: "text", id: "response", text: "Will fail tool." } as const;
        yield toolCall("list_files", {});
        yield toolCall("read_file", { path: "nonexistent.ts" });
        yield done();
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/a.ts", content: "hello\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      const result = await f.runtime.runOneShotForTesting(
        session.id,
        "u1",
        "List then read a missing file.",
      );
      const readTool = result.toolCalls.find((tc) => tc.name === "read_file");
      assert.equal(readTool?.success, false);
      assert.equal(readTool?.error, "file_not_found");
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM workspace_changes").get().n, 0);
      assert.equal(f.runtime.get(session.id, "u1").status, "complete");
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("one-shot: model returns only list_files then finishes - documents one-shot limitation", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    const f = fixture(() => ({
      async *stream(_messages, _tools) {
        yield { type: "text", id: "response", text: "I'll list the files first." } as const;
        yield toolCall("list_files", {});
        yield done();
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/format.ts", content: "export function formatName(name: string) {\n  return name.trim();\n}\n" },
        { path: "src/summary.ts", content: "import { formatName } from './format';\n\nexport function summary(name: string) {\n  return `Hello ${formatName(name)}`;\n}\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      const result = await f.runtime.runOneShotForTesting(
        session.id,
        "u1",
        "Call list_files, then read_file for src/format.ts and src/summary.ts. Then propose edits.",
      );
      assert.deepEqual(result.toolCalls.map(({ name }) => name), ["list_files"]);
      assert.equal(result.toolCalls[0].success, true);
      assert.equal(result.proposals.length, 0);
      const missingReads = ["read_file:src/format.ts", "read_file:src/summary.ts"];
      const missingProposals = ["propose_edit_file:src/format.ts", "propose_edit_file:src/summary.ts"];
      assert.ok(missingReads.every((m) => !result.toolCalls.some((tc) => `${tc.name}:${tc.arguments.path}` === m)));
      assert.ok(missingProposals.every((m) => !result.toolCalls.some((tc) => `${tc.name}:${tc.arguments.path}` === m)));
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("one-shot: multiple tool calls in single response are collected", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    const f = fixture(() => ({
      async *stream(_messages, _tools) {
        yield { type: "text", id: "response", text: "Making multiple tool calls." } as const;
        yield toolCall("list_files", {});
        yield toolCall("read_file", { path: "src/a.ts" });
        yield toolCall("read_file", { path: "src/b.ts" });
        yield toolCall("propose_edit_file", { path: "src/a.ts", content: "export const a = 1;\n" });
        yield done();
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/a.ts", content: "hello a\n" },
        { path: "src/b.ts", content: "hello b\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      const result = await f.runtime.runOneShotForTesting(
        session.id,
        "u1",
        "Do multiple tool calls.",
      );
      const toolNames = result.toolCalls.map(({ name }) => name);
      assert.ok(toolNames.includes("list_files"));
      assert.ok(toolNames.filter((n) => n === "read_file").length === 2);
      assert.ok(toolNames.includes("propose_edit_file"));
      assert.equal(result.toolCalls.length, 4);
      assert.ok(result.toolCalls.every(({ success }) => success));
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("multi-turn: multiple provider request cycles with tool results fed back", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    let requestCount = 0;
    const f = fixture(() => ({
      async *stream(_messages, _tools) {
        requestCount++;
        if (requestCount === 1) {
          yield { type: "text", id: "response", text: "Listing files." } as const;
          yield toolCall("list_files", {});
          yield done();
        } else if (requestCount === 2) {
          yield { type: "text", id: "response", text: "Reading both files." } as const;
          yield toolCall("read_file", { path: "src/format.ts" });
          yield toolCall("read_file", { path: "src/summary.ts" });
          yield done();
        } else if (requestCount === 3) {
          yield { type: "text", id: "response", text: "Proposing edits." } as const;
          yield toolCall("propose_edit_file", { path: "src/format.ts", content: "export function formatName(name: string) {\n  return name.trim().replace(/\\s+/g, ' ');\n}\n" });
          yield toolCall("propose_edit_file", { path: "src/summary.ts", content: "import { formatName } from './format';\n\nexport function summary(name: string) {\n  return `Hello ${formatName(name)}`;\n}\n" });
          yield done();
        } else {
          yield { type: "text", id: "response", text: "Done." } as const;
          yield done();
        }
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/format.ts", content: "export function formatName(name: string) {\n  return name.trim();\n}\n" },
        { path: "src/summary.ts", content: "import { formatName } from './format';\n\nexport function summary(name: string) {\n  return `Hello ${formatName(name)}`;\n}\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      const response = await f.runtime.message(
        session.id,
        "u1",
        "List files, read both, then propose edits to normalize whitespace."
      );
      assert.ok(requestCount >= 3 && requestCount <= 4, `expected 3-4 requests, got ${requestCount}`);
      assert.equal(response.proposals.length, 2);
      const toolNames = response.proposals.map((p) => p.operation).sort();
      assert.deepEqual(toolNames, ["edit_file", "edit_file"]);
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("multi-turn: tool results passed back to model in subsequent requests", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    let requestCount = 0;
    const receivedToolResults: Array<{ callId: string; name: string }> = [];
    const f = fixture(() => ({
      async *stream(messages, _tools) {
        requestCount++;
        if (requestCount === 1) {
          yield { type: "text", id: "response", text: "First request." } as const;
          yield toolCall("list_files", {});
          yield done();
        } else if (requestCount === 2) {
          for (const msg of messages) {
            if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block && typeof block === "object" && block.type === "tool_result") {
                  receivedToolResults.push({ callId: block.tool_use_id, name: block.name });
                }
              }
            }
          }
          yield { type: "text", id: "response", text: "Second request with tool result." } as const;
          yield toolCall("read_file", { path: "src/a.ts" });
          yield done();
        } else {
          yield done();
        }
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/a.ts", content: "hello\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      await f.runtime.message(
        session.id,
        "u1",
        "List files then read a file."
      );
      assert.ok(requestCount >= 2 && requestCount <= 3, `expected 2-3 requests, got ${requestCount}`);
      assert.equal(receivedToolResults.length, 1);
      assert.equal(receivedToolResults[0].name, "list_files");
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("multi-turn: preserves correct conversation sequence where assistant tool_use precedes user tool_results", async () => {
    let requestCount = 0;
    const historySequence: Array<Array<{ role: string; type?: string }>> = [];
    const f = fixture(() => ({
      async *stream(messages, _tools) {
        requestCount++;
        historySequence.push(
          messages.map((m: any) => ({
            role: m.role,
            contentTypes: Array.isArray(m.content) ? m.content.map((b: any) => b.type) : [typeof m.content],
          })),
        );
        if (requestCount === 1) {
          yield { type: "text", id: "resp1", text: "Starting inspection." } as const;
          yield toolCall("list_files", {}, "call_1");
          yield toolCall("search_code", { query: "orders" }, "call_2");
          yield done();
        } else if (requestCount === 2) {
          yield { type: "text", id: "resp2", text: "Finished inspection." } as const;
          yield done();
        }
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/orders.ts", content: "export const orders = [];\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      const res = await f.runtime.message(session.id, "u1", "Check orders");
      assert.equal(requestCount, 2);
      assert.equal(res.message, "Finished inspection.");

      // Verify sequence in round 2:
      // index 0: user (initial prompt)
      // index 1: assistant (with tool_use blocks)
      // index 2: user (tool_result for call_1)
      // index 3: user (tool_result for call_2)
      const round2Messages = historySequence[1];
      assert.ok(round2Messages.length >= 4);
      assert.equal(round2Messages[0].role, "user");
      assert.equal(round2Messages[1].role, "assistant");
      assert.ok(round2Messages[1].contentTypes.includes("tool_use"));
      assert.equal(round2Messages[2].role, "user");
      assert.deepEqual(round2Messages[2].contentTypes, ["tool_result"]);
      assert.equal(round2Messages[3].role, "user");
      assert.deepEqual(round2Messages[3].contentTypes, ["tool_result"]);
    } finally {
      cleanup(f);
    }
  });

  it("multi-turn: validates against @cline/llms handler with multiple tool calls and tool failure", async () => {
    const { createHandler } = await import("@cline/llms");
    let fetchCount = 0;
    const mockFetch = async (url: any, init: any) => {
      fetchCount++;
      if (fetchCount === 1) {
        const sse = [
          "data: " + JSON.stringify({
            id: "1",
            choices: [{
              delta: {
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "list_files", arguments: "{}" } },
                  { id: "c2", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "nonexistent.ts" }) } },
                ],
              },
            }],
          }),
          "data: " + JSON.stringify({ id: "1", choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          "data: [DONE]",
        ].join("\n\n") + "\n\n";
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      const sse = [
        "data: " + JSON.stringify({
          id: "2",
          choices: [{ delta: { content: "Inspection completed safely." }, finish_reason: "stop" }],
        }),
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const providerFactory = (providerId: string, modelId: string, apiKey: string) => {
      const handler = createHandler({ providerId, modelId, apiKey, fetch: mockFetch as any });
      return {
        async *stream(messages: any, tools: any, signal: any) {
          for await (const chunk of handler.createMessage("sys", messages, tools)) {
            yield chunk as any;
          }
        },
      };
    };

    const f = fixture(providerFactory as any);
    try {
      f.db.prepare(
        "UPDATE user_ai_provider_settings SET provider_id='groq', model_id='openai/gpt-oss-120b' WHERE user_id='u1'",
      ).run();
      f.db.prepare(
        "UPDATE user_ai_provider_credentials SET provider_id='groq' WHERE user_id='u1'",
      ).run();

      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/orders.ts", content: "export const orders = [];\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      const res = await f.runtime.message(session.id, "u1", "Check files");
      assert.equal(fetchCount, 2);
      assert.equal(res.message, "Inspection completed safely.");
      const events = f.runtime.events(session.id, "u1");
      const toolEvents = events.filter((e) => e.type === "tool");
      assert.equal(toolEvents.length, 2);
      assert.equal((toolEvents[0].data as any).name, "list_files");
      assert.equal((toolEvents[0].data as any).success, true);
      assert.equal((toolEvents[1].data as any).name, "read_file");
      assert.equal((toolEvents[1].data as any).error, "file_not_found");
    } finally {
      cleanup(f);
    }
  });

  it("multi-turn: multiple tool executions across turns", async () => {
    const f = fixture();
    try {
      const providers = [
        ["gemini", "gemini"],
        ["openai-compatible", "openai-compatible"],
        ["anthropic", "anthropic"],
        ["groq", "groq"],
        ["openrouter", "openrouter"],
      ];
      for (const [providerId, sdkProviderId] of providers) {
        f.db.prepare(
          `INSERT INTO user_ai_provider_settings(user_id,provider_id,model_id) VALUES('u1',?,'configured-model')
           ON CONFLICT(user_id) DO UPDATE SET provider_id=excluded.provider_id,model_id=excluded.model_id`,
        ).run(providerId);
        f.db.prepare(
          `INSERT INTO user_ai_provider_credentials(user_id,provider_id,encrypted_api_key) VALUES('u1',?,?)
           ON CONFLICT(user_id,provider_id) DO UPDATE SET encrypted_api_key=excluded.encrypted_api_key`,
        ).run(sdkProviderId, encryptToken(API_KEY, KEY));
        assert.equal(f.runtime.create("u1", f.w1.id).providerId, providerId);
      }
    } finally {
      cleanup(f);
    }
  });

  it("fails closed for missing credentials and does not fall back to environment keys", () => {
    const f = fixture();
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "environment-key-must-not-be-used";
    try {
      f.db.prepare("DELETE FROM user_ai_provider_credentials WHERE user_id='u1'").run();
      assert.throws(
        () => f.runtime.create("u1", f.w1.id),
        (error: AgentError) => error.code === "credential_missing",
      );
      f.db.prepare("DELETE FROM user_ai_provider_settings WHERE user_id='u1'").run();
      assert.throws(
        () => f.runtime.create("u1", f.w1.id),
        (error: AgentError) => error.code === "provider_not_configured",
      );
    } finally {
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldKey;
      cleanup(f);
    }
  });

  it("expires persisted sessions and their retained messages", () => {
    const f = fixture();
    try {
      const session = f.runtime.create("u1", f.w1.id);
      f.db
        .prepare("UPDATE agent_sessions SET expires_at=? WHERE id=?")
        .run(new Date(Date.now() - 1_000).toISOString(), session.id);
      assert.throws(
        () => f.runtime.get(session.id, "u1"),
        (error: AgentError) => error.code === "session_not_found",
      );
      assert.equal(
        (f.db.prepare("SELECT count(*) AS n FROM agent_messages WHERE session_id=?").get(session.id) as { n: number }).n,
        0,
      );
      assert.equal(
        (f.db.prepare("SELECT count(*) AS n FROM agent_sessions WHERE id=?").get(session.id) as { n: number }).n,
        0,
      );
    } finally {
      cleanup(f);
    }
  });

  it("dispatches only the six allowlisted tools and creates proposals without writing files", async () => {
    const f = fixture(() => {
      let round = 0;
      return {
        async *stream(_messages, definitions) {
          assert.deepEqual(definitions.map((definition) => definition.name), TOOL_NAMES);
          if (round++ === 0) {
            yield toolCall("list_files", {});
            yield toolCall("read_file", { path: "src/a.ts" });
            yield toolCall("search_code", { query: "hello" });
            yield toolCall("propose_create_file", { path: "new.txt", content: "new" });
            yield toolCall("propose_edit_file", { path: "src/a.ts", content: "edited" });
            yield toolCall("propose_delete_file", { path: "src/a.ts" });
          } else {
            yield { type: "text", id: "r", text: "Done with proposals." } as const;
          }
          yield done();
        },
      };
    });
    try {
      const session = f.runtime.create("u1", f.w1.id);
      const result = await f.runtime.message(session.id, "u1", "Inspect and propose changes");
      assert.equal(result.message, "Done with proposals.");
      assert.equal(result.proposals.length, 3);
      assert.deepEqual(
        result.proposals.map((proposal: { operation: string }) => proposal.operation).sort(),
        ["create_file", "delete_file", "edit_file"],
      );
      assert.equal(f.ws.readFile(f.w1.id, "u1", "src/a.ts").content, "hello world\n");
      assert.throws(() => f.ws.readFile(f.w1.id, "u1", "new.txt"), (error: Error) => error.message === "file_not_found");
    } finally {
      cleanup(f);
    }
  });

  it("applies proposals only after approval and preserves rejected changes", async () => {
    let action = 0;
    const f = fixture(() => {
      const currentAction = action++;
      let firstRequest = true;
      return {
        async *stream() {
          if (firstRequest) {
            firstRequest = false;
            if (currentAction === 0) {
              yield toolCall("propose_create_file", { path: "new.txt", content: "new" });
            } else if (currentAction === 1) {
              yield toolCall("propose_edit_file", { path: "src/a.ts", content: "edited" });
            } else {
              yield toolCall("propose_delete_file", { path: "src/a.ts" });
            }
          } else {
            yield { type: "text", id: "r", text: "ready" } as const;
          }
          yield done();
        },
      };
    });
    try {
      const session = f.runtime.create("u1", f.w1.id);
      const create = await f.runtime.message(session.id, "u1", "create");
      assert.throws(() => f.ws.readFile(f.w1.id, "u1", "new.txt"));
      f.ws.decide(f.w1.id, "u1", create.proposals[0]!.id, "approve");
      assert.equal(f.ws.readFile(f.w1.id, "u1", "new.txt").content, "new");

      const edit = await f.runtime.message(session.id, "u1", "edit");
      f.ws.decide(f.w1.id, "u1", edit.proposals[0]!.id, "reject");
      assert.equal(f.ws.readFile(f.w1.id, "u1", "src/a.ts").content, "hello world\n");

      const remove = await f.runtime.message(session.id, "u1", "delete");
      f.ws.decide(f.w1.id, "u1", remove.proposals[0]!.id, "approve");
      assert.throws(() => f.ws.readFile(f.w1.id, "u1", "src/a.ts"));
    } finally {
      cleanup(f);
    }
  });

  it("supports multiple messages and bounds persisted conversation history", async () => {
    const received: string[][] = [];
    const f = fixture(() => ({
      async *stream(messages) {
        received.push(messages.map((message) => message.role));
        yield {
          type: "text",
          id: "r",
          text: received.length === 1 ? "first answer" : "second answer",
        } as const;
        yield done();
      },
    }));
    try {
      const session = f.runtime.create("u1", f.w1.id);
      await f.runtime.message(session.id, "u1", "first task");
      await f.runtime.message(session.id, "u1", "second task");
      assert.deepEqual(received[1], ["user", "assistant", "user"]);
      assert.equal(
        (f.db.prepare("SELECT count(*) AS n FROM agent_messages WHERE session_id=?").get(session.id) as { n: number }).n,
        4,
      );
      assert.equal(f.runtime.get(session.id, "u1").messages.length, 4);
    } finally {
      cleanup(f);
    }
  });

  it("rejects malformed arguments, unknown tools, and traversal without proposals", async () => {
    let request = 0;
    const f = fixture(() => ({
      async *stream() {
        if (request++ === 0) yield toolCall("read_file", { path: "../outside" });
        else yield { type: "text", id: "r", text: "stopped" } as const;
        yield done();
      },
    }));
    try {
      const session = f.runtime.create("u1", f.w1.id);
      await f.runtime.message(session.id, "u1", "read");
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM workspace_changes").get().n, 0);
      assert.ok(f.runtime.events(session.id, "u1").some((event) => JSON.stringify(event).includes("invalid_tool_arguments")));
    } finally {
      cleanup(f);
    }

    const invalid = fixture(() => {
      let firstRequest = true;
      return {
        async *stream() {
          if (firstRequest) {
            firstRequest = false;
            yield toolCall("read_file", { path: "src/a.ts", extra: true });
          } else {
            yield { type: "text", id: "r", text: "invalid args rejected" } as const;
          }
          yield done();
        },
      };
    });
    try {
      const session = invalid.runtime.create("u1", invalid.w1.id);
      await invalid.runtime.message(session.id, "u1", "read");
      assert.equal(invalid.db.prepare("SELECT count(*) AS n FROM workspace_changes").get().n, 0);
    } finally {
      cleanup(invalid);
    }
  });

  it("rejects secret-bearing proposals without persistence, exposure, or workspace changes", async () => {
    let responseCount = 0;
    const capturedLogs: string[] = [];
    const originalConsole = {
      debug: console.debug,
      info: console.info,
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    const captureLog = (...args: unknown[]) => {
      capturedLogs.push(args.map(String).join(" "));
    };
    const f = fixture(() => {
      let firstRequest = true;
      return {
        async *stream(messages) {
          responseCount++;
          assert.equal(JSON.stringify(messages).includes(API_KEY), false);
          if (firstRequest) {
            firstRequest = false;
            yield toolCall("propose_create_file", { path: "leak.txt", content: API_KEY });
          } else {
            yield { type: "text", id: "r", text: `Echo: ${API_KEY}` } as const;
          }
          yield done();
        },
      };
    });
    const workspaceBefore = f.ws.listFiles(f.w1.id, "u1").map(({ path: filePath }) => ({
      path: filePath,
      content: f.ws.readFile(f.w1.id, "u1", filePath).content,
    }));
    console.debug = captureLog;
    console.info = captureLog;
    console.log = captureLog;
    console.warn = captureLog;
    console.error = captureLog;
    try {
      const session = f.runtime.create("u1", f.w1.id);
      const result = await f.runtime.message(session.id, "u1", `Task contains ${API_KEY}`);
      assert.deepEqual(result.proposals, []);
      assert.equal(responseCount, 2);
      assert.equal(
        (f.db.prepare("SELECT count(*) AS count FROM workspace_changes").get() as { count: number }).count,
        0,
      );
      const serialized = JSON.stringify({
        result,
        events: f.runtime.events(session.id, "u1"),
        messages: f.runtime.get(session.id, "u1").messages,
      });
      assert.equal(serialized.includes(API_KEY), false);
      assert.equal(capturedLogs.join("\n").includes(API_KEY), false);
      assert.deepEqual(
        f.ws.listFiles(f.w1.id, "u1").map(({ path: filePath }) => ({
          path: filePath,
          content: f.ws.readFile(f.w1.id, "u1", filePath).content,
        })),
        workspaceBefore,
      );
    } finally {
      console.debug = originalConsole.debug;
      console.info = originalConsole.info;
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      cleanup(f);
    }
  });

  it("invalidates legacy history on API-key rotation before GET or provider reuse", async () => {
    let providerInput = "";
    const f = fixture(() => ({
      async *stream(messages) {
        providerInput = JSON.stringify(messages);
        yield { type: "text", id: "r", text: "ok" } as const;
        yield done();
      },
    }));
    const app = createTestServer(f);
    const legacyCredential = "legacy-custom-credential-8842";
    try {
      const session = f.runtime.create("u1", f.w1.id);
      f.db
        .prepare("INSERT INTO agent_messages VALUES(?,?,?,?,?)")
        .run("legacy-history", session.id, "assistant", `Previously seen ${legacyCredential}`, new Date().toISOString());
      assert.match(JSON.stringify(f.runtime.get(session.id, "u1")), new RegExp(legacyCredential));

      const headers = sessionHeaders(f, f.s1.token, "u1");
      const rotated = await app.inject({
        method: "PUT",
        url: "/api/ai/credentials/openai",
        headers,
        payload: { apiKey: "new-provider-key-4629" },
      });
      assert.equal(rotated.statusCode, 200);
      assert.equal(
        (f.db.prepare("SELECT count(*) AS count FROM agent_messages").get() as { count: number }).count,
        0,
      );
      assert.equal(
        (await app.inject({
          method: "GET",
          url: `/api/agent/sessions/${session.id}`,
          headers,
        })).statusCode,
        404,
      );
      assert.throws(() => f.runtime.get(session.id, "u1"), (error: AgentError) => error.code === "session_not_found");

      const fresh = f.runtime.create("u1", f.w1.id);
      await f.runtime.message(fresh.id, "u1", "Continue");
      assert.equal(providerInput.includes(legacyCredential), false);
    } finally {
      await cleanupWithServer(f, app);
    }
  });

  it("invalidates legacy history and session GET access when the API key is removed", async () => {
    const f = fixture();
    const app = createTestServer(f);
    try {
      const session = f.runtime.create("u1", f.w1.id);
      f.db
        .prepare("INSERT INTO agent_messages VALUES(?,?,?,?,?)")
        .run("legacy-history", session.id, "user", "old arbitrary credential", new Date().toISOString());
      const headers = sessionHeaders(f, f.s1.token, "u1");

      const removed = await app.inject({
        method: "DELETE",
        url: "/api/ai/credentials/openai",
        headers,
      });
      assert.equal(removed.statusCode, 200);
      assert.equal(
        (f.db.prepare("SELECT count(*) AS count FROM agent_messages").get() as { count: number }).count,
        0,
      );
      assert.equal(
        (await app.inject({
          method: "GET",
          url: `/api/agent/sessions/${session.id}`,
          headers,
        })).statusCode,
        404,
      );
      assert.equal(
        (f.db.prepare("SELECT count(*) AS count FROM agent_sessions").get() as { count: number }).count,
        0,
      );
    } finally {
      await cleanupWithServer(f, app);
    }
  });

  it("clears pre-hardening session history during the legacy-session migration", () => {
    const f = fixture();
    try {
      const session = f.runtime.create("u1", f.w1.id);
      f.db
        .prepare("INSERT INTO agent_messages VALUES(?,?,?,?,?)")
        .run("legacy-history", session.id, "assistant", "historical plaintext credential", new Date().toISOString());
      clearLegacyAgentHistory(f.db);
      assert.equal(
        (f.db.prepare("SELECT count(*) AS count FROM agent_messages").get() as { count: number }).count,
        0,
      );
      assert.equal(
        (f.db.prepare("SELECT count(*) AS count FROM agent_sessions").get() as { count: number }).count,
        0,
      );
    } finally {
      cleanup(f);
    }
  });

  it("returns safe provider failures and identifies rate limits", async () => {
    const rateLimited = fixture(() => ({
      async *stream() {
        throw Object.assign(new Error(`response contains ${API_KEY}`), { statusCode: 429 });
      },
    }));
    try {
      const session = rateLimited.runtime.create("u1", rateLimited.w1.id);
      await assert.rejects(
        rateLimited.runtime.message(session.id, "u1", "hello"),
        (error: AgentError) => error.code === "provider_rate_limited" && error.statusCode === 429 && !error.message.includes(API_KEY),
      );
      assert.ok(rateLimited.runtime.events(session.id, "u1").every((event) => !JSON.stringify(event).includes(API_KEY)));
    } finally {
      cleanup(rateLimited);
    }

    const failed = fixture(() => ({
      async *stream() {
        throw new Error(`provider response includes ${API_KEY}`);
      },
    }));
    try {
      const session = failed.runtime.create("u1", failed.w1.id);
      await assert.rejects(
        failed.runtime.message(session.id, "u1", "hello"),
        (error: AgentError) => error.code === "provider_error" && !error.message.includes(API_KEY),
      );
    } finally {
      cleanup(failed);
    }
  });

  it("handles malformed provider responses and enforces the tool-call limit", async () => {
    const malformed = fixture(() => ({
      async *stream() {
        yield { type: "text", id: "r", text: 7 } as never;
        yield done();
      },
    }));
    try {
      const session = malformed.runtime.create("u1", malformed.w1.id);
      await assert.rejects(
        malformed.runtime.message(session.id, "u1", "hello"),
        (error: AgentError) => error.code === "invalid_provider_response",
      );
    } finally {
      cleanup(malformed);
    }

    const limited = fixture(() => ({
      async *stream() {
        for (let index = 0; index < 13; index++) yield toolCall("list_files", {}, `tool-${index}`);
        yield done();
      },
    }));
    try {
      const session = limited.runtime.create("u1", limited.w1.id);
      await assert.rejects(
        limited.runtime.message(session.id, "u1", "hello"),
        (error: AgentError) => error.code === "tool_limit",
      );
      assert.equal(limited.db.prepare("SELECT count(*) AS n FROM workspace_changes").get().n, 0);
    } finally {
      cleanup(limited);
    }
  });

  it("supports cancellation and reports provider timeouts without exposing upstream details", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const cancellable = fixture(
      () => ({
        async *stream(_messages, _tools, signal) {
          started();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error(`aborted ${API_KEY}`);
        },
      }),
      { requestTimeoutMs: 1_000 },
    );
    try {
      const session = cancellable.runtime.create("u1", cancellable.w1.id);
      const pending = cancellable.runtime.message(session.id, "u1", "wait");
      await startedPromise;
      cancellable.runtime.cancel(session.id, "u1");
      await assert.rejects(
        pending,
        (error: AgentError) => error.code === "cancelled" && !error.message.includes(API_KEY),
      );
      assert.equal(cancellable.runtime.get(session.id, "u1").status, "cancelled");
    } finally {
      cleanup(cancellable);
    }

    const timedOut = fixture(
      () => ({
        async *stream(_messages, _tools, signal) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error(`timeout ${API_KEY}`);
        },
      }),
      { requestTimeoutMs: 10, overallTimeoutMs: 50 },
    );
    try {
      const session = timedOut.runtime.create("u1", timedOut.w1.id);
      await assert.rejects(
        timedOut.runtime.message(session.id, "u1", "wait"),
        (error: AgentError) => error.code === "provider_timeout" && !error.message.includes(API_KEY),
      );
    } finally {
      cleanup(timedOut);
    }
  });

  it("serves authenticated, owner-scoped session APIs without returning credentials", async () => {
    const f = fixture();
    const app = createServer({
      config: {
        port: 3000,
        host: "127.0.0.1",
        publicBaseUrl: "http://localhost:3000",
        githubApp: { tokenEncryptionKey: KEY },
      },
      database: f.db,
      workspaceRoot: path.join(f.temp, "server-ws"),
    });
    try {
      const headers = sessionHeaders(f, f.s1.token, "u1");
      const created = await app.inject({
        method: "POST",
        url: "/api/agent/sessions",
        headers,
        payload: { workspaceId: f.w1.id },
      });
      assert.equal(created.statusCode, 201, created.body);
      const id = created.json().id;
      assert.doesNotMatch(created.body, /secret-user-key|encrypted_api_key/);
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: `/api/agent/sessions/${id}`,
            headers: { cookie: `pocketcode_session=${f.s2.token}` },
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/agent/sessions", headers })).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: `/api/agent/sessions/${id}/events`, headers })).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/agent/sessions/${id}/cancel`,
            headers,
          })
        ).statusCode,
        204,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/agent/sessions/${id}/messages`,
            headers,
            payload: { message: "no longer active" },
          })
        ).statusCode,
        409,
      );
    } finally {
      await app.close();
      rmSync(f.temp, { recursive: true, force: true });
    }
  });

  it("keeps all agent actions server-side with no shell, arbitrary network, or GitHub-write tools", () => {
    const f = fixture();
    try {
      const session = f.runtime.create("u1", f.w1.id);
      assert.equal(f.runtime.get(session.id, "u1").workspaceId, f.w1.id);
      assert.deepEqual(TOOL_NAMES, [
        "list_files",
        "read_file",
        "search_code",
        "propose_create_file",
        "propose_edit_file",
        "propose_delete_file",
      ]);
      assert.equal(TOOL_NAMES.some((name) => /shell|exec|fetch|github|network/i.test(name)), false);
    } finally {
      cleanup(f);
    }
  });

  it("multi-turn: provider error handling", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    let requestCount = 0;
    const f = fixture(() => ({
      async *stream() {
        requestCount++;
        if (requestCount === 1) {
          yield { type: "text", id: "response", text: "Will error." } as const;
          yield toolCall("list_files", {});
          yield done();
        } else {
          throw new AgentError("provider_unavailable", 503);
        }
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/a.ts", content: "hello\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      await assert.rejects(
        f.runtime.message(session.id, "u1", "Do something"),
        (error: AgentError) => error.code === "provider_unavailable",
      );
      assert.ok(requestCount >= 1 && requestCount <= 2);
      const changes = f.db.prepare("SELECT count(*) AS n FROM workspace_changes").get() as { n: number };
      assert.equal(changes.n, 0);
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("multi-turn: provider request limit enforcement", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    let requestCount = 0;
    const f = fixture(() => ({
      async *stream(_messages, _tools) {
        requestCount++;
        if (requestCount <= 5) {
          yield { type: "text", id: "response", text: `Turn ${requestCount}.` } as const;
          yield toolCall("list_files", {});
          yield done();
        } else {
          yield done();
        }
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/a.ts", content: "hello\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      const response = await f.runtime.message(
        session.id,
        "u1",
        "Keep calling list_files."
      );
      assert.ok(requestCount <= 13);
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("multi-turn: tool execution limit enforcement", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    let toolCallCount = 0;
    const f = fixture(() => ({
      async *stream(_messages, _tools) {
        yield { type: "text", id: "response", text: "Many tools." } as const;
        for (let i = 0; i < 15; i++) {
          yield toolCall("list_files", {});
          toolCallCount++;
        }
        yield done();
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/a.ts", content: "hello\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      await assert.rejects(
        f.runtime.message(session.id, "u1", "Too many tools."),
        (error: AgentError) => error.code === "tool_limit",
      );
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("multi-turn: timeout and cleanup", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    const f = fixture(
      () => ({
        async *stream() {
          yield { type: "text", id: "response", text: "Starting." } as const;
          yield toolCall("list_files", {});
          yield done();
          // Never resolves, will trigger overall timeout
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        },
      }),
      { overallTimeoutMs: 50, requestTimeoutMs: 20 }
    );

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/a.ts", content: "hello\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      await assert.rejects(
        f.runtime.message(session.id, "u1", "Wait forever"),
        (error: AgentError) => error.code === "provider_timeout" || error.code === "cancelled",
      );
      const sessionStatus = f.runtime.get(session.id, "u1").status;
      assert.ok(["error", "cancelled"].includes(sessionStatus));
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });

  it("multi-turn: secret-free logs and events", async () => {
    const oldSmokeFlag = process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
    process.env.POCKETCODE_ENABLE_AGENT_SMOKE = "1";
    const secret = "gsk_test_secret_key_12345";
    const f = fixture(() => ({
      async *stream(_messages, _tools) {
        yield { type: "text", id: "response", text: "Using secret: " + secret } as const;
        yield done();
      },
    }));

    try {
      const workspace = f.ws.create("u1", f.sessionId("u1"), "synthetic", "main", "synthetic", [
        { path: "src/a.ts", content: "hello\n" },
      ]);
      const session = f.runtime.create("u1", workspace.id);
      await f.runtime.message(session.id, "u1", "Test secret");
      const messages = f.db.prepare("SELECT content FROM agent_messages WHERE session_id=?").all(session.id) as Array<{ content: string }>;
      for (const msg of messages) {
        assert.ok(!msg.content.includes(secret));
      }
      const events = f.runtime.events(session.id, "u1");
      for (const event of events) {
        assert.ok(!JSON.stringify(event).includes(secret));
      }
    } finally {
      cleanup(f);
      if (oldSmokeFlag === undefined) delete process.env.POCKETCODE_ENABLE_AGENT_SMOKE;
      else process.env.POCKETCODE_ENABLE_AGENT_SMOKE = oldSmokeFlag;
    }
  });
});
