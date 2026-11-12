# PocketCode Agent Runtime: Security Boundaries and Limitations

**Status:** Phase 1 runtime implemented. Tests use mocked providers; no live AI provider request has been tested.

## Trust boundaries

### Credentials and provider requests

- BYOK settings and encrypted credentials remain user-scoped. The runtime resolves and decrypts only the authenticated user's selected credential on the backend, immediately before execution.
- The plaintext key is passed only as provider-handler configuration. It is not accepted from tool arguments, added to model messages, or returned by agent APIs.
- Migration `008_clear_legacy_agent_history` removes all existing agent sessions and transcripts once, because pre-hardening arbitrary history cannot be reliably scanned retroactively. Replacing or removing any BYOK credential also atomically removes that user's agent sessions and transcripts. This intentionally ends existing agent sessions to avoid retaining or reusing history associated with old credentials.
- No credential fingerprints are stored. Deriving one from the current `TOKEN_ENCRYPTION_KEY` would couple historical matching to encryption-key rotation, and the application has no separately managed, versioned fingerprint key or retirement policy. A future fingerprint scheme requires independent key lifecycle design before implementation.
- A reusable content scanner redacts recognized secret patterns from all provider-bound messages at the runtime boundary and again in the provider adapter. This includes initial context, `read_file`, `search_code`, tool arguments/results, and multi-turn history. Assistant text and persisted history are scanned before storing or returning; session reads also sanitize legacy transcript content.
- Secret-bearing file creation/edit proposals are rejected with a safe tool error. Proposal content is never silently rewritten; the workspace proposal/approval service stores and applies exact user-approved contents.
- Provider exceptions and stream errors are reduced to safe error codes. PocketCode does not fall back to environment API keys.
- The selected provider must receive the repository/task context to perform inference. Do not send repositories to a provider unless the user has configured and selected that provider.

The workspace snapshot still excludes sensitive-looking filenames (`.env*`, names containing `secret`, `credential`, `private-key`, and `.pem`/`.key`). In addition, the provider boundary scanner recognizes common private-key PEM blocks, database URLs with credentials, bearer tokens, JWTs, GitHub token formats, AWS access-key IDs and labeled secret assignments, Google API keys, common cloud/provider token prefixes, and common password/API-key/access-token assignments. It replaces only the provider-facing representation; stored snapshots, current workspace files, and approved diffs are not changed.

This is conservative pattern matching, not complete secret discovery. It can miss novel, encoded, split, obfuscated, or unrecognized credentials and can redact legitimate code/configuration that resembles a credential. It cannot retroactively identify arbitrary credentials in old transcripts; those transcripts are deleted by the one-time migration and on credential replacement/removal. Do not claim that every secret is detected.

### Provider-bound content paths

1. Initial repository context is assembled from workspace reads and scanned immediately before the provider call.
2. `read_file` and `search_code` return workspace-derived text into tool-result messages; the same boundary scans those results before the next provider call.
3. Model-generated tool arguments are kept exact for backend validation/dispatch, but their message representation is scanned before being sent back to the provider. Secret-bearing write contents or paths are rejected rather than stored as proposals.
4. Tool results, including proposal metadata, are scanned at the same boundary.
5. Prior user/assistant turns are scanned before provider use; newly persisted user tasks and assistant text are scanned, and `GET` session reads sanitize legacy transcript content as well.

### Tools and workspace

The model sees only the six static tool descriptions documented in [agent-runtime-architecture.md](./agent-runtime-architecture.md). PocketCode validates the arguments and checks session/workspace ownership on every dispatch. There is no shell/process, arbitrary URL/fetch, GitHub-write, plugin, MCP, or SDK-managed tool path. Provider API traffic is limited to the configured model handler; the model cannot invoke network access independently.

All file access goes through `WorkspaceService`. Paths are relative and reject traversal, absolute paths, NULs, drive/UNC prefixes, and symlinks. Workspaces are private ephemeral directories; the current snapshot and original are separate. Repository snapshots are limited to 500 files, 256 KiB per file, and 10 MiB total. Binary and excluded secret-named files are not loaded. Agent reads and search results are bounded.

Write tools only call the existing `WorkspaceService.propose` API. A proposal remains pending until the user explicitly approves or rejects it through the workspace change routes. Approval is owner-checked, tied to the stored proposal/base version, and applies only to the isolated workspace. The agent runtime never writes files directly.

### Sessions, events, and resource limits

Sessions are authenticated and user-owned. They reference a workspace and snapshot the selected provider/model; changing that configuration invalidates execution for the existing session. The session lifetime is capped at 24 hours and workspace expiry. Message count, active-run concurrency, task/context/history sizes, model output, tool arguments/results, number of tool calls, pending proposals, and provider duration are bounded. Cancellation and timeout are handled without exposing upstream exception text.

Progress events are limited to safe phase/tool metadata and codes, kept in a bounded in-memory history, and exposed only to the session owner. They are lost on process restart; event history is not durable or streamed over SSE in Phase 1.

## Approval, ownership, and API behavior

Every agent route requires a valid PocketCode session; mutating routes additionally require the session-bound CSRF token and expected origin. Cross-user session/workspace access returns not-found behavior. The API does not expose encrypted or plaintext credentials.

The model is not authoritative: repository contents and model outputs are untrusted. Paths and schemas are validated server-side; unknown tools are rejected. Tool output does not include raw API keys, and progress events intentionally omit model arguments and file contents. Provider rate limits map to a safe rate-limit error; other provider failures are generic. No automatic retry or hidden approval is performed.

## Operational limitations

- **Single process only:** Active-run locks, user concurrency, cancellation controllers, and event history are process-local. Local workspaces do not survive instance replacement. Do not horizontally scale or share the workspace directory across servers.
- **Cleanup:** Database-backed expiry is swept at startup/runtime construction, and workspace cleanup is managed by the existing workspace service. Abrupt host failure can still leave local directories; production cleanup should be independent of a single process.
- **Credential changes end agent sessions:** Replacing or removing a BYOK credential deletes all of that user's agent sessions and transcript rows. This prevents future reads or provider turns from reusing those transcripts. A provider request already sent before the change cannot be recalled; a running agent detects a deleted session at the next response/chunk boundary and stops processing it.
- **No provider live test:** Current tests mock provider streams. The provider integration is wired to installed `@cline/llms` 0.2.0, but live credential validity, provider availability, and model compatibility remain unverified.
- **Secret-scanner limits:** Pattern scanning does not guarantee that all secrets embedded in ordinary source files are excluded; it can also produce false positives. A file with detected values is represented to the model with redaction markers, so an edit based on that context may require careful user review.
- **No repository writes:** PocketCode Phase 1 does not create GitHub commits, branches, or pull requests. Approval changes only the isolated workspace.

Before multi-instance production use, replace local workspace/process state with isolated per-session workers or equivalent durable infrastructure, cross-instance ownership/leases and cancellation, and reliable independent lifecycle cleanup. Review provider/SDK behavior again before any dependency upgrade.
