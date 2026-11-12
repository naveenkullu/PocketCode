# PocketCode Custom Agent Runtime — Phase 1

**Status:** Implemented. Provider and runtime tests use mocks; no live AI request has been verified.

## Architecture

PocketCode owns the agent loop in `src/agents/agent-runtime.ts`. It resolves the authenticated user's selected provider/model and decrypts that user's credential through the existing BYOK service. `src/agents/provider-adapter.ts` constructs an `@cline/llms` handler from the installed SDK and sends the conversation plus the static PocketCode tool descriptions. The SDK streams provider output; it does not execute tools.

The runtime has no direct filesystem, process, shell, GitHub-write, or arbitrary-network tool. Every tool call is validated and dispatched on the backend. Workspace reads and structured proposals go through `WorkspaceService`; only that service's existing owner-authorized approval flow mutates the isolated workspace.

## Provider support

The installed `@cline/llms` **0.2.0** registry and the existing BYOK implementation verify these providers:

| PocketCode selection | SDK provider ID |
|---|---|
| `gemini` | `gemini` |
| `openai` | `openai-compatible` |
| `anthropic` | `anthropic` |
| `groq` | `groq` |
| `openrouter` | `openrouter` |

The chosen model ID is the user's configured bounded string. PocketCode does not advertise or invent a model catalog. Credentials are decrypted only for backend execution, passed to the selected provider handler, and never included in the frontend response. PocketCode does not fall back to environment credentials. Provider errors are sanitized; HTTP 429-class errors are surfaced as a safe rate-limit code. No provider request has been made as part of this milestone.

## Tool allowlist

| Tool | Capability |
|---|---|
| `list_files` | List a bounded set of workspace paths |
| `read_file` | Read a validated workspace text file |
| `search_code` | Search literal text in bounded workspace files |
| `propose_create_file` | Create a structured pending proposal |
| `propose_edit_file` | Create a structured pending proposal |
| `propose_delete_file` | Create a structured pending proposal |

Tool arguments are checked again server-side, even when the provider API accepts a schema. Unknown tools, malformed arguments, traversal, and workspace ownership failures do not reach filesystem mutation. A shared secret scanner redacts recognized credentials from every message immediately before provider invocation; the installed SDK adapter repeats the scan as a final boundary. This covers initial context, file/search tool results, tool arguments/results, and prior conversation history. Secret-bearing write proposals are rejected rather than silently altered. Tool progress events expose only tool names and safe status codes, not file contents or arguments.

## Run and session limits

- Session lifetime: at most 24 hours and never beyond workspace expiry.
- One active run per session; at most two active runs per user in this process.
- Up to 20 persisted user/assistant messages per session.
- At most 12 tool calls and 13 provider rounds per message.
- Provider request timeout: 30 seconds; overall run timeout: 120 seconds.
- Task: 8,000 UTF-8 bytes; recent conversation history: 16,000 bytes.
- Repository context: 48,000 bytes; model text output: 12,000 bytes.
- Generated text across provider rounds: 24,000 bytes; tool arguments per call: at most one workspace-file limit plus 16,384 bytes; total tool arguments: 1 MiB.
- Tool output passed back to the model: 32,000 bytes per message.
- At most 24 pending workspace proposals totaling 2 MiB.

Provider chunks, arguments, and tool outputs are validated and bounded. Cancellation aborts the provider handler when supported by the installed SDK and marks the session cancelled. Tool loops, timeout, malformed responses, provider failures, and rate limits return safe codes.

## API and persistence

Authenticated routes are registered by `src/agents/agent-routes.ts`:

- `POST /api/agent/sessions`
- `GET /api/agent/sessions`
- `GET /api/agent/sessions/:sessionId`
- `POST /api/agent/sessions/:sessionId/messages`
- `POST /api/agent/sessions/:sessionId/cancel`
- `GET /api/agent/sessions/:sessionId/events`

Mutations require the existing session-bound CSRF validation. SQLite migration `007_agent_sessions` stores owner, workspace, provider/model selection, expiry, status, and bounded text transcript. Progress events are a bounded in-memory history and can be retrieved through the events route; they are not durable and are not an SSE stream.

Migration `008_clear_legacy_agent_history` removes pre-hardening agent sessions and transcripts because arbitrary historical credentials cannot be reliably discovered after the fact. Replacing or removing a user's BYOK credential also invalidates all of that user's sessions and transcript rows. No credential fingerprints are retained; a separately managed, versioned fingerprint key and rotation policy would be required before safely introducing them.

Proposals are reviewed and applied through the existing workspace routes. The agent message endpoint may return pending proposals, but never applies them. Approval is explicit, owner-checked, and version-checked by `WorkspaceService`.

## Deployment constraints

Workspace storage and per-session active-run/event state are process-local. This implementation is for one backend process on private, non-shared storage only. Do not horizontally scale it: multiple instances would not share cancellation, active-run limits, or event history, and local directories are not durable. Multi-instance deployment requires isolated workers or equivalent storage, cross-instance ownership/leases, cancellation coordination, and independent cleanup.
