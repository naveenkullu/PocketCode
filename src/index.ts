/**
 * PocketCode - Phase 2: Interactive Agent Runtime
 */

import "dotenv/config";
import { ClineCore, type CoreSessionEvent } from "@cline/sdk";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createInterface } from "node:readline";

// Configuration from environment
const providerId = process.env.PROVIDER_ID || "cline";
const sdkProviderId = providerId === "google" ? "gemini" : providerId;

const apiKey = (() => {
  switch (providerId) {
    case "google":
      return process.env.GOOGLE_API_KEY;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "xai":
      return process.env.XAI_API_KEY;
    case "groq":
      return process.env.GROQ_API_KEY;
    case "cline":
      return process.env.CLINE_API_KEY;
    default:
      throw new Error(`Unsupported AI provider: ${providerId}`);
  }
})();

const config = {
  providerId: sdkProviderId,
  modelId:
    providerId === "xai"
      ? process.env.XAI_MODEL || "grok-4.7"
      : providerId === "groq"
        ? process.env.GROQ_MODEL || "openai/gpt-oss-120b"
        : process.env.MODEL_ID || "anthropic/claude-sonnet-4.6",
  apiKey,
  workspaceRoot: path.resolve(process.cwd(), "workspace"),
};

function formatDiagnostic(value: unknown): string {
  const serialized =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (key, entry) =>
          /api.?key|secret|token|password/i.test(key) ? "[REDACTED]" : entry,
        );
  const text = serialized ?? String(value);
  return config.apiKey ? text.replaceAll(config.apiKey, "[REDACTED]") : text;
}

function validateConfig(): void {
  if (!config.apiKey) {
    console.error("Error: No API key configured.");
    console.error(
      "Set one of: CLINE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, XAI_API_KEY, GROQ_API_KEY",
    );
    process.exit(1);
  }
  console.log(`Provider: ${config.providerId}`);
  console.log(`Model: ${config.modelId}`);
  console.log(`Workspace: ${config.workspaceRoot}`);
}

async function ensureWorkspace(): Promise<void> {
  await fs.mkdir(config.workspaceRoot, { recursive: true });
  console.log(`Workspace directory: ${config.workspaceRoot}`);
}

async function createClineInstance(): Promise<ClineCore> {
  return await ClineCore.create({
    clientName: "pocketcode",
    backendMode: "local",
  });
}

type AgentResult = NonNullable<Awaited<ReturnType<ClineCore["send"]>>>;

function logAgentResult(result: AgentResult | undefined): void {
  if (!result) {
    console.log("[Session turn completed] No agent result was returned.");
    return;
  }
  console.log(`[Session turn completed] reason=${result.finishReason}`);
  console.log(`Iterations: ${result.iterations}`);
  console.log(`Completion reason: ${result.finishReason}`);
  console.log(`Tool calls recorded: ${result.toolCalls.length}`);
  for (const toolCall of result.toolCalls) {
    console.log(`[Recorded tool call] ${toolCall.name}: ${toolCall.error ? "failed" : "completed"}`);
    console.log(`[Tool input] ${formatDiagnostic(toolCall.input)}`);
    if (toolCall.error) {
      console.error(`[Tool error] ${formatDiagnostic(toolCall.error)}`);
    } else {
      console.log(`[Tool result] ${formatDiagnostic(toolCall.output)}`);
    }
  }
}

function subscribeToSessionEvents(cline: ClineCore): () => void {
  return cline.subscribe((event: CoreSessionEvent) => {
    console.log(`[SDK event] ${event.type}`);
    switch (event.type) {
      case "chunk":
        if (event.payload.stream === "agent") {
          console.log(`[Agent message] ${formatDiagnostic(event.payload.chunk)}`);
        }
        break;
      case "agent_event": {
        const agentEvent = event.payload.event;
        switch (agentEvent.type) {
          case "content_start":
            if (agentEvent.contentType === "tool") {
              console.log(
                `[Tool requested] ${agentEvent.toolName ?? "unknown"} input=${formatDiagnostic(agentEvent.input)}`,
              );
            } else if (agentEvent.contentType === "text" && agentEvent.text) {
              console.log(`[Agent message] ${formatDiagnostic(agentEvent.text)}`);
            }
            break;
          case "content_update":
            console.log(
              `[Tool progress] ${agentEvent.toolName ?? "unknown"} ${formatDiagnostic(agentEvent.update)}`,
            );
            break;
          case "content_end":
            if (agentEvent.contentType === "tool") {
              console.log(
                `[Tool execution result] ${agentEvent.toolName ?? "unknown"}: ${
                  agentEvent.error ? "failed" : "completed"
                }`,
              );
              if (agentEvent.error) {
                console.error(`[Tool error] ${formatDiagnostic(agentEvent.error)}`);
              } else {
                console.log(`[Tool result] ${formatDiagnostic(agentEvent.output)}`);
              }
            } else if (agentEvent.contentType === "text" && agentEvent.text) {
              console.log(`[Agent response] ${formatDiagnostic(agentEvent.text)}`);
            }
            break;
          case "notice":
            console.warn(
              `[Agent notice] ${agentEvent.reason ?? agentEvent.noticeType}: ${formatDiagnostic(agentEvent.message)}`,
            );
            break;
          case "done":
            console.log(
              `[Agent completion] reason=${agentEvent.reason} iterations=${agentEvent.iterations}`,
            );
            console.log(`[Agent final response] ${formatDiagnostic(agentEvent.text)}`);
            break;
          case "error":
            console.error(`[Agent error] ${formatDiagnostic(agentEvent.error.message)}`);
            break;
          case "iteration_start":
          case "iteration_end":
          case "usage":
            console.log(`[Agent event] ${formatDiagnostic(agentEvent)}`);
            break;
        }
        break;
      }
      case "hook":
        console.log(
          `[Session hook] ${event.payload.hookEventName}${
            event.payload.toolName ? ` tool=${event.payload.toolName}` : ""
          }`,
        );
        break;
      case "ended":
        console.log(`[Session ended] reason=${event.payload.reason}`);
        break;
      case "status":
        console.log(`[Session status] ${event.payload.status}`);
        break;
      case "team_progress":
      case "pending_prompts":
      case "pending_prompt_submitted":
      case "session_snapshot":
        break;
    }
  });
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║       PocketCode - Phase 2 Interactive Agent             ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  validateConfig();
  await ensureWorkspace();

  const cline = await createClineInstance();
  console.log("ClineCore instance created successfully");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const isInteractiveTerminal = process.stdin.isTTY === true;
  let unsubscribe: (() => void) | undefined;
  let sessionId: string | undefined;
  try {
    unsubscribe = subscribeToSessionEvents(cline);
    console.log("Enter a prompt to start a session. Type /exit or exit to quit.");
    readline.setPrompt("You: ");
    if (isInteractiveTerminal) {
      readline.prompt();
    }

    for await (const line of readline) {
      const prompt = line.trim();
      if (!prompt) {
        console.log("Empty prompt ignored.");
        if (isInteractiveTerminal) {
          readline.prompt();
        }
        continue;
      }
      if (prompt.toLowerCase() === "/exit" || prompt.toLowerCase() === "exit") {
        break;
      }

      if (sessionId === undefined) {
        console.log("\nStarting agent session...");
        const session = await cline.start({
          prompt,
          interactive: true,
          config: {
            providerId: config.providerId,
            modelId: config.modelId,
            apiKey: config.apiKey,
            systemPrompt: `You are a coding assistant. Only create, read, and edit files within ${config.workspaceRoot}. Use absolute paths under that workspace with the built-in editor and read_files tools. Do not use shell commands.`,
            cwd: config.workspaceRoot,
            workspaceRoot: config.workspaceRoot,
            enableTools: true,
            enableSpawnAgent: false,
            enableAgentTeams: false,
          },
          toolPolicies: {
            read_files: { autoApprove: true },
            search_codebase: { autoApprove: true },
            editor: { autoApprove: true },
            fetch_web_content: { autoApprove: true },
            run_commands: { autoApprove: false },
          },
        });
        sessionId = session.sessionId;
        console.log(`[Session created] sessionId=${sessionId}`);
        logAgentResult(session.result);
      } else {
        console.log(`\n[Session continuation] sessionId=${sessionId}`);
        const result = await cline.send({ sessionId, prompt });
        logAgentResult(result);
      }
      if (isInteractiveTerminal) {
        readline.prompt();
      }
    }
    console.log("\nShutting down interactive session...");
  } finally {
    readline.close();
    try {
      unsubscribe?.();
    } finally {
      console.log("[ClineCore disposal] Disposing instance and active session resources...");
      await cline.dispose();
      console.log("[ClineCore disposal] Complete.");
    }
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
