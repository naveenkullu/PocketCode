import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createSession } from "../src/auth/session-service.js";
import { encryptToken } from "../src/auth/token-encryption.js";
import { AgentRuntime } from "../src/agents/agent-runtime.js";
import type { RuntimeProvider } from "../src/agents/provider-adapter.js";
import {
  containsDetectedSecret,
  redactProviderMessages,
  scanAndRedactSecrets,
} from "../src/agents/secret-scanner.js";
import { openDatabase } from "../src/storage/database.js";
import { WorkspaceService } from "../src/workspaces/workspace-service.js";

const KEY = "0123456789abcdef".repeat(4);
const BYOK_KEY = "context-test-byok-key-987654321";
const GITHUB_TOKEN = `ghp_${"A".repeat(36)}`;
const AWS_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GOOGLE_KEY = `AIza${"A".repeat(35)}`;
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signedpayload12345678";
const DB_URL = "postgres://service:Password123!@db.example.test:5432/app";
const PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  "-----END PRIVATE KEY-----",
].join("\n");
const TOOL_NAMES = ["list_files", "read_file", "search_code", "propose_create_file", "propose_edit_file", "propose_delete_file"];
type ProviderFactory = (providerId: string, modelId: string, key: string) => RuntimeProvider;

function fixture(
  files: Array<{ path: string; content: string }>,
  factory: ProviderFactory,
) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "pocketcode-context-security-"));
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users(id,github_username) VALUES('u1','security-test')").run();
  const sessionId = createSession(db, "u1");
  const sid = (
    db.prepare("SELECT id FROM sessions WHERE user_id='u1'").get() as { id: string }
  ).id;
  const workspace = new WorkspaceService(db, { rootDirectory: path.join(temp, "workspaces") });
  const created = workspace.create("u1", sid, "123", "main", "sha", files);
  db.prepare(
    "INSERT INTO user_ai_provider_settings(user_id,provider_id,model_id) VALUES('u1','openai-compatible','test-model')",
  ).run();
  db.prepare(
    "INSERT INTO user_ai_provider_credentials(user_id,provider_id,encrypted_api_key) VALUES('u1','openai-compatible',?)",
  ).run(encryptToken(BYOK_KEY, KEY));
  const runtime = new AgentRuntime(db, workspace, KEY, factory);
  return { temp, db, workspace, runtime, workspaceId: created.id, userSession: sessionId };
}

function finish(f: ReturnType<typeof fixture>) {
  f.runtime.close();
  f.db.close();
  rmSync(f.temp, { recursive: true, force: true });
}

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    type: "tool_calls",
    id: "response",
    tool_call: { call_id: name, function: { name, arguments: args } },
  } as const;
}

function complete() {
  return { type: "done", id: "response", success: true } as const;
}

describe("repository context secret scanning", () => {
  it("redacts common provider, cloud, token, credential-assignment, and database patterns", () => {
    const source = [
      `github = "${GITHUB_TOKEN}"`,
      `aws_access_key_id = "${AWS_ACCESS_KEY}"`,
      `aws_secret_access_key = "${"wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"}"`,
      `google_api_key = "${GOOGLE_KEY}"`,
      `authorization: Bearer ${"b".repeat(40)}`,
      `session = "${JWT}"`,
      `DATABASE_URL="${DB_URL}"`,
      `PASSWORD = "correct horse battery staple"`,
      `private_key = "${PRIVATE_KEY}"`,
      `cloud_token = "sk-proj-${"C".repeat(30)}"`,
    ].join("\n");

    const result = scanAndRedactSecrets(source);
    for (const secret of [
      GITHUB_TOKEN,
      AWS_ACCESS_KEY,
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      GOOGLE_KEY,
      "b".repeat(40),
      JWT,
      DB_URL,
      "correct horse battery staple",
      "-----BEGIN PRIVATE KEY-----",
      `sk-proj-${"C".repeat(30)}`,
    ]) {
      assert.equal(result.content.includes(secret), false, `secret unexpectedly present: ${secret.slice(0, 8)}`);
    }
    assert.ok(result.findings.includes("github-token"));
    assert.ok(result.findings.includes("aws-access-key"));
    assert.ok(result.findings.includes("google-api-key"));
    assert.ok(result.findings.includes("private-key"));
    assert.ok(result.findings.includes("database-credential"));
    assert.ok(result.findings.includes("jwt"));
    assert.ok(result.findings.includes("bearer-token"));
    assert.ok(result.findings.includes("credential-assignment"));
  });

  it("keeps ordinary code and documented placeholders unchanged", () => {
    const source = [
      "const client = new Client();",
      "const token = getToken();",
      'const apiKey = "example-test-value";',
      "const apiKey = process.env.LONG_API_KEY;",
      "// password: <your-password-here>",
    ].join("\n");
    const result = scanAndRedactSecrets(source);
    assert.equal(result.content, source);
    assert.deepEqual(result.findings, []);
    assert.equal(containsDetectedSecret(source), false);
  });

  it("redacts all nested provider message strings and object keys without mutating input", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "call",
            name: "propose_edit_file",
            input: { path: "src/ordinary.ts", content: `const token = "${GITHUB_TOKEN}";` },
          },
        ],
      },
    ];
    const redacted = redactProviderMessages(messages);
    assert.equal(JSON.stringify(redacted).includes(GITHUB_TOKEN), false);
    assert.equal(JSON.stringify(messages).includes(GITHUB_TOKEN), true);
    assert.match(JSON.stringify(redacted), /REDACTED:github-token/);
  });

  it("redacts secrets in ordinary source-file context without changing workspace originals", async () => {
    const content = [
      `const github = "${GITHUB_TOKEN}";`,
      `const db = "${DB_URL}";`,
      "export function greeting(name: string) { return `hello ${name}`; }",
    ].join("\n");
    let providerInput = "";
    const f = fixture([{ path: "src/settings.ts", content }], () => ({
      async *stream(messages, tools) {
        assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
        providerInput = JSON.stringify(messages);
        yield { type: "text", id: "r", text: "context reviewed" } as const;
        yield complete();
      },
    }));
    try {
      const session = f.runtime.create("u1", f.workspaceId);
      await f.runtime.message(session.id, "u1", "Review settings");
      assert.equal(providerInput.includes(GITHUB_TOKEN), false);
      assert.equal(providerInput.includes(DB_URL), false);
      assert.match(providerInput, /REDACTED:github-token/);
      assert.match(providerInput, /REDACTED:database-credential/);
      assert.match(providerInput, /hello/);
      assert.equal(f.workspace.readFile(f.workspaceId, "u1", "src/settings.ts").content, content);
      assert.equal(f.workspace.originalSnapshot(f.workspaceId, "u1", "src/settings.ts"), content);
    } finally {
      finish(f);
    }
  });

  it("redacts read_file and search_code tool results before the next provider request", async () => {
    const content = [
      `const githubToken = "${GITHUB_TOKEN}";`,
      `const connection = "${DB_URL}";`,
      `const privateKey = \`${PRIVATE_KEY}\`;`,
    ].join("\n");
    let round = 0;
    let followUp = "";
    const f = fixture([{ path: "src/config.ts", content }], () => ({
      async *stream(messages) {
        if (round++ === 0) {
          yield toolCall("read_file", { path: "src/config.ts" });
          yield toolCall("search_code", { query: "githubToken" });
        } else {
          followUp = JSON.stringify(messages);
          yield { type: "text", id: "r", text: "done" } as const;
        }
        yield complete();
      },
    }));
    try {
      const session = f.runtime.create("u1", f.workspaceId);
      await f.runtime.message(session.id, "u1", "Inspect configuration");
      assert.equal(followUp.includes(GITHUB_TOKEN), false);
      assert.equal(followUp.includes(DB_URL), false);
      assert.equal(followUp.includes("-----BEGIN PRIVATE KEY-----"), false);
      assert.match(followUp, /REDACTED:github-token/);
      assert.match(followUp, /REDACTED:database-credential/);
      assert.match(followUp, /REDACTED:private-key/);
      assert.equal(f.workspace.readFile(f.workspaceId, "u1", "src/config.ts").content, content);
    } finally {
      finish(f);
    }
  });

  it("redacts user and assistant history before later turns and from persisted messages", async () => {
    let turn = 0;
    let secondTurnInput = "";
    const f = fixture([{ path: "src/public.ts", content: "export const ok = true;" }], () => ({
      async *stream(messages) {
        if (turn++ === 0) {
          assert.equal(JSON.stringify(messages).includes(GITHUB_TOKEN), false);
          yield { type: "text", id: "r", text: "Copied value: ghp_" } as const;
          yield { type: "text", id: "r", text: "A".repeat(36) } as const;
        } else {
          secondTurnInput = JSON.stringify(messages);
          yield { type: "text", id: "r", text: "follow-up" } as const;
        }
        yield complete();
      },
    }));
    try {
      const session = f.runtime.create("u1", f.workspaceId);
      await f.runtime.message(session.id, "u1", `Check this token ${GITHUB_TOKEN}`);
      const storedBefore = JSON.stringify(f.runtime.get(session.id, "u1").messages);
      assert.equal(storedBefore.includes(GITHUB_TOKEN), false);
      await f.runtime.message(session.id, "u1", "Follow up");
      assert.equal(secondTurnInput.includes(GITHUB_TOKEN), false);
      assert.match(secondTurnInput, /REDACTED:github-token/);
      assert.equal(
        JSON.stringify(f.runtime.events(session.id, "u1")).includes(GITHUB_TOKEN),
        false,
      );
    } finally {
      finish(f);
    }
  });

  it("redacts pre-existing persisted transcripts from session API reads", () => {
    const f = fixture([{ path: "src/public.ts", content: "export const ok = true;" }], () => ({
      async *stream() {
        yield { type: "text", id: "r", text: "unused" } as const;
        yield complete();
      },
    }));
    try {
      const session = f.runtime.create("u1", f.workspaceId);
      f.db
        .prepare("INSERT INTO agent_messages VALUES(?,?,?,?,?)")
        .run(
          "legacy-user-message",
          session.id,
          "user",
          `old task ${GITHUB_TOKEN} ${BYOK_KEY}`,
          new Date().toISOString(),
        );
      const returned = JSON.stringify(f.runtime.get(session.id, "u1"));
      assert.equal(returned.includes(GITHUB_TOKEN), false);
      assert.equal(returned.includes(BYOK_KEY), false);
      assert.match(returned, /REDACTED:github-token/);
    } finally {
      finish(f);
    }
  });

  it("rejects a secret-bearing model proposal instead of rewriting content or returning it", async () => {
    let round = 0;
    let nextInput = "";
    const f = fixture([{ path: "src/public.ts", content: "export const safe = true;" }], () => ({
      async *stream(messages) {
        if (round++ === 0) {
          yield toolCall("propose_create_file", {
            path: "src/credentials.ts",
            content: `export const token = "${GITHUB_TOKEN}";`,
          });
        } else {
          nextInput = JSON.stringify(messages);
          yield { type: "text", id: "r", text: "The secret-bearing proposal was rejected." } as const;
        }
        yield complete();
      },
    }));
    try {
      const session = f.runtime.create("u1", f.workspaceId);
      const result = await f.runtime.message(session.id, "u1", "Create a credentials file");
      assert.equal(GITHUB_TOKEN && nextInput.includes(GITHUB_TOKEN), false);
      assert.match(nextInput, /REDACTED:github-token/);
      assert.deepEqual(result.proposals, []);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM workspace_changes").get().n, 0);
      assert.equal(f.workspace.readFile(f.workspaceId, "u1", "src/public.ts").content, "export const safe = true;");
      assert.equal(JSON.stringify(f.runtime.events(session.id, "u1")).includes(GITHUB_TOKEN), false);
    } finally {
      finish(f);
    }
  });

  it("rejects exact configured BYOK credential values in model-generated proposals", async () => {
    let round = 0;
    let followUp = "";
    const f = fixture([{ path: "src/public.ts", content: "export const safe = true;" }], () => ({
      async *stream(messages) {
        if (round++ === 0) {
          yield toolCall("propose_create_file", {
            path: "src/provider.ts",
            content: `export const key = "${BYOK_KEY}";`,
          });
        } else {
          followUp = JSON.stringify(messages);
          yield { type: "text", id: "r", text: "Rejected safely." } as const;
        }
        yield complete();
      },
    }));
    try {
      const session = f.runtime.create("u1", f.workspaceId);
      const response = await f.runtime.message(session.id, "u1", "Create a provider file");
      assert.equal(followUp.includes(BYOK_KEY), false);
      assert.equal(JSON.stringify(response).includes(BYOK_KEY), false);
      assert.equal(JSON.stringify(f.runtime.events(session.id, "u1")).includes(BYOK_KEY), false);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM workspace_changes").get().n, 0);
    } finally {
      finish(f);
    }
  });

  it("handles malformed tool arguments and provider errors without reflecting secrets", async () => {
    const f = fixture([{ path: "src/public.ts", content: "export const ok = true;" }], () => ({
      async *stream() {
        throw new Error(`malformed response included ${GITHUB_TOKEN}`);
      },
    }));
    try {
      const session = f.runtime.create("u1", f.workspaceId);
      await assert.rejects(
        f.runtime.message(session.id, "u1", "Inspect"),
        (error: Error) => error.message === "provider_error",
      );
      assert.equal(JSON.stringify(f.runtime.events(session.id, "u1")).includes(GITHUB_TOKEN), false);
      assert.equal(JSON.stringify(f.runtime.get(session.id, "u1")).includes(GITHUB_TOKEN), false);
    } finally {
      finish(f);
    }
  });
});
