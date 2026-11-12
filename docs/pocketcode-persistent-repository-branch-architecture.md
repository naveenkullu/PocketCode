# PocketCode Persistent Repository Branch Architecture

**Status:** Architecture audit only. No source code, database, GitHub permissions, credentials, branches, commits, or deployments were changed.

This document records the current implementation and proposes a safe design for durable repository workspaces and GitHub publishing. "Current" statements are based on the checked-in source and tests; "Proposed" statements are not implemented.

## Executive summary

PocketCode currently browses repositories and creates a short-lived workspace snapshot from a client-supplied branch ref. In the web UI, the first message creates that workspace from the repository's default branch. Proposed file changes require explicit approval, but approval only changes the temporary workspace files. No GitHub branch is created or written, no PR is created, and no Vercel project or deployment is managed.

The durable unit should be a repository connection owned by an authenticated PocketCode GitHub user, not a coding conversation or workspace. Its record should pin the GitHub repository ID, owner, default/base branch, PocketCode feature branch, and observed commit state. New conversations should load the saved feature branch, while publishing should append only approved changes and use a non-force ref update. GitHub operations must be recoverable and idempotent.

**Multi-user recommendation:** Do not give multiple PocketCode users one implicitly shared feature branch. Scope a connection to `(PocketCode user, GitHub repository ID)` and give each user a separately named persistent branch and PR. If collaborative shared work is later needed, make it an explicit, opt-in team-owned connection with authorization and concurrency controls. Branch naming is not a security boundary: server-side owner checks must enforce which connection a workspace may publish to.

## 1. Repository confirmation flow

### Current

- GitHub App installations are associated with an authenticated PocketCode user and the repository list is fetched through that user's active installations.
- Repository rows expose GitHub repository ID, full name, default branch, and read/write permission indicators.
- The UI allows choosing a repository in the sidebar. It does not show a dedicated "confirm repository and create PocketCode branch" step.
- On the first chat message for that UI workspace, the client posts the repository ID and default branch to `POST /api/workspaces`. The server validates repository accessibility and loads a snapshot; it does not create a branch.
- The source of this flow is [App.tsx](../frontend/src/App.tsx), [github-installation-service.ts](../src/auth/github-installation-service.ts), [workspace-routes.ts](../src/workspaces/workspace-routes.ts), and [workspace-service.ts](../src/workspaces/workspace-service.ts).

### Proposed

1. Require an authenticated user to select a repository and explicitly confirm the repository identity, owner, and current default branch before any branch-creating operation.
2. Resolve and verify the repository from GitHub on the server at confirmation time; do not trust a client-supplied owner/name/default branch.
3. If an owned connection already exists, show its saved feature branch and lifecycle state and reuse it. Do not silently switch branches if the default branch was renamed or changed.
4. If none exists, explain the new branch name and ask for confirmation before creating it. A retry of the same confirmation must resolve to the same connection and branch.
5. Store GitHub's immutable numeric repository ID as the identity. Treat owner/name as display/routing metadata that may change after a rename.

## 2. Persistent repository-to-branch database model

### Current

- SQLite migrations create users, GitHub installations, temporary `workspaces`, workspace snapshots/files/proposals, and agent sessions/messages.
- A workspace row records `user_id`, `session_id`, `repository_id`, arbitrary `branch_ref`, and `source_commit_sha`; it expires after 24 hours.
- There is no durable repository-connection or branch-association table. Workspace creation stores a client-provided `branch_ref`; it is not constrained to the repository's default branch or to a PocketCode branch.
- Migrations are registered in [schema.ts](../src/storage/schema.ts). Workspace persistence is defined in [006_workspaces.ts](../src/storage/migrations/006_workspaces.ts), and agent sessions in [007_agent_sessions.ts](../src/storage/migrations/007_agent_sessions.ts). The default SQLite file is `data/pocketcode.sqlite` (see [database.ts](../src/storage/database.ts)).
- The server shutdown hook calls workspace cleanup, which deletes workspace records and files; this makes current workspaces unsuitable as durable branch associations. See [server/index.ts](../src/server/index.ts) and [workspace-service.ts](../src/workspaces/workspace-service.ts).

### Proposed

Add a migration for a durable `repository_connections` (or equivalent) table, separate from ephemeral workspaces. Suggested fields:

| Field | Purpose |
|---|---|
| `id` | Stable internal connection identifier |
| `user_id` | PocketCode owner; foreign key to `users` |
| `repository_id` | Immutable GitHub repository ID, stored as text to avoid integer-size assumptions |
| `installation_id` | Installation used for access, revalidated on use |
| `owner_login`, `repository_name` | Refreshable display/API-routing metadata |
| `base_branch_ref`, `base_branch_head_sha` | Original/default target branch and the last observed base tip |
| `feature_branch_ref`, `feature_branch_head_sha` | Saved PocketCode branch and the last verified tip |
| `status` | For example `provisioning`, `active`, `branch_missing`, `conflict`, `merged`, `access_lost`, `recovery_required`, `archived` |
| `version` | Optimistic concurrency/version field |
| `pull_request_number`, `pull_request_state`, `pull_request_url` | Durable PR association and status cache |
| `created_at`, `updated_at` | Audit timestamps |

Use a unique constraint on `(user_id, repository_id)` and indexes for owner/status lookups. Ensure `(repository_id, feature_branch_ref)` cannot be claimed by two PocketCode connections. Do not use a foreign key to the temporary workspace as the connection's source of truth.

The unique repository key is scoped to the authenticated PocketCode user. Keep branch and PR identity stable across repository renames. Retain the original base branch value for the connection; if it changes on GitHub, record the new observed default separately and require a user-confirmed migration rather than rewriting the target silently.

## 3. First-time branch creation

### Current

No branch-creation operation exists. The GitHub App installation-token request explicitly asks for `metadata: read` and `contents: read` only in [github-app-auth.ts](../src/auth/github-app-auth.ts).

### Proposed

After explicit confirmation, run a recoverable provisioning operation:

1. Re-resolve the repository and verify the authenticated user's installation still has access.
2. Fetch and store the verified repository identity, default branch name, and default branch tip SHA.
3. Generate a namespaced branch ref, for example `pocketcode/user-<stable-github-user-id>/<repo-slug>`. Keep the actual created ref in the database; never recompute it after a rename.
4. Create the feature ref from the verified default branch SHA using GitHub's ref API. Before creation, check for an existing ref. If it exists, reuse it only when the saved connection proves it belongs to this user/repository; otherwise stop for explicit conflict resolution.
5. Persist the association and resulting head SHA as one logical workflow. Use a `provisioning` state plus an operation/idempotency record so a crash between GitHub and SQLite can be reconciled.
6. If branch creation returns an ambiguous network failure, inspect the remote ref and reconcile; do not create an alternate branch or overwrite an existing one.

The default branch is read-only to PocketCode. The service must reject it as a publish target even if a caller bypasses UI validation.

## 4. Branch reuse across future sessions

### Current

- The frontend stores selected repository, workspace ID, and agent-session ID only in React state. Selecting another repository clears the state.
- A new chat workspace is initialized from the selected repository's default branch.
- Agent sessions are persisted in SQLite, but the client does not restore a saved repository connection/workspace-to-branch association after refresh or a new conversation.
- Workspaces expire after 24 hours and are also removed during server shutdown cleanup. See [App.tsx](../frontend/src/App.tsx), [workspace-service.ts](../src/workspaces/workspace-service.ts), and [agent-runtime-architecture.md](./agent-runtime-architecture.md).

### Proposed

- On every new session, resolve the connection by `(authenticated user, immutable repository ID)`. Never accept the persistent feature branch solely from request input.
- Verify the remote repository ID and saved feature ref before loading any files.
- Load the saved feature branch's current tree and head SHA. This includes earlier PocketCode-published work and preserves commits already on that branch.
- Continue to treat sessions and workspaces as disposable execution contexts; a session ID must not determine a branch name.
- If the branch is missing, merged, inaccessible, or owned by a different connection, stop and present recovery choices. Do not fall back to the default branch or recreate the branch automatically.

## 5. Workspace synchronization with the persistent branch

### Current

- `loadRepositorySnapshot` fetches one branch's head/tree/blob data, with limits for file count, file size, total size, text-only files, and secret-like filenames.
- The snapshot is copied to per-workspace `original` and `current` directories, while snapshot contents/hashes and source commit SHA are stored in SQLite.
- `POST /api/workspaces` accepts `repositoryId` and `branchRef`, resolves accessible repository access, and loads that ref. It does not verify a saved branch association.
- The current UI browses the remote repository until an ephemeral workspace is created, after which it browses workspace files. It does not synchronize remote changes back into an active workspace.

### Proposed

- Build a workspace from the saved feature branch head, not the current default branch.
- Record both the loaded branch head SHA and the latest observed base-branch SHA. Keep the two concepts distinct: feature-branch changes are the work-in-progress; base-branch movement is an upstream divergence that needs detection and handling.
- Before publishing, compare the remote feature tip with the workspace's recorded base SHA. If it changed, fetch/reconcile and stop on conflicting paths or unexpected commits.
- Represent workspace changes as a diff against the loaded snapshot. Preserve the full tree and prior published commits; do not replace the remote branch tree with a stale local snapshot.
- Keep snapshot size limits, path validation, secret-file exclusion, user ownership checks, and workspace isolation. Store enough durable metadata to recover a pending publish after ephemeral files expire.

## 6. Approved changes publishing

### Current

- The agent can create file create/edit/delete proposals. They are stored as `pending`.
- The owner can approve/reject proposals. Approval checks workspace version and original file content, then applies the change to the workspace's `current` files and increments the workspace version.
- Rejected proposals do not change workspace files. Approval does not contact GitHub.
- The workspace test explicitly asserts there are no Git write requests (`tests/workspaces.test.ts`).
- Relevant existing routes are `POST /api/workspaces/:workspaceId/changes` and `POST /api/workspaces/:workspaceId/changes/:changeId/{approve|reject}` in [workspace-routes.ts](../src/workspaces/workspace-routes.ts).

### Proposed

Preserve the approval boundary: only approved proposal contents may enter a Git commit. Approval in the workspace must not itself imply publication.

Recommended explicit publish workflow:

1. Create a publish operation with a client idempotency key and a stable operation ID. Snapshot the set of approved proposal IDs, their exact contents/hashes, and the expected feature head SHA.
2. Persist an intent/status such as `prepared` before remote writes. Revalidate proposal ownership/status, workspace version, repository connection, and feature ref on the server.
3. Fetch the feature branch tip. Require it to equal the expected SHA, or perform a safe fast-forward/reconciliation; never force-update or blindly replace a newer tree.
4. Build a Git tree from the branch's current tree plus only the approved file deltas. Create a commit with the feature head as parent and update only the saved feature ref with `force: false`.
5. Persist the resulting commit SHA and mark proposals/operation published. Repeated requests with the same idempotency key return the existing operation result.
6. If the process crashes or the API times out, reconcile the branch, parent SHA, operation marker, and tree fingerprint before retrying. Do not blindly create another commit or treat an unknown outcome as failure.

GitHub and SQLite cannot be committed atomically together. Model publication as a durable saga with explicit `prepared`, `remote_applied`, `complete`, `conflict`, and `recovery_required` states. A non-fast-forward race or failed compare must be visible to the user; no unrelated commits may be overwritten.

## 7. Multiple-user ownership and isolation

### Current

- Workspaces, workspace changes, agent sessions, and GitHub installation records are user-scoped and routes check ownership.
- GitHub installations are stored with one owning PocketCode user, and installation lookup is scoped to that user.
- There is no persistent branch association or write API. Existing read-only GitHub branch access does not model shared-branch ownership.

### Proposed

- Make a separate persistent connection/feature branch per authenticated PocketCode GitHub user and repository. Each user gets an independent feature branch and PR; never let a connection lookup by repository ID alone return another user's branch.
- Use the repository's numeric GitHub ID and PocketCode user ID in uniqueness and authorization checks. Avoid relying on mutable repo names or branch slugs for authorization.
- The server must derive repository, branch, and installation from the owned connection when creating workspaces and publishing. Reject request bodies that try to substitute another saved branch.
- A repository may be accessible to multiple users; GitHub access to the repository does not make one user's PocketCode state eligible for another user's workspace.
- If later supporting shared team work, create a separately modeled team-owned connection with explicit membership, role checks, audit history, and serialized/optimistic publishing. Do not infer a shared workspace from matching repository IDs.
- Branch naming alone cannot prevent a human or external automation with repository write access from changing another branch. Validate ownership and head SHA on every operation and document GitHub repository-level access implications.

## 8. Conflict detection and recovery

### Current

- Proposal approval detects stale workspace versions and changed original file content.
- There is no remote branch head comparison during a workspace session, no Git push conflict handling, and no merge/conflict recovery flow.
- Existing snapshot capture records a commit SHA, but no persistent connection stores or compares a branch tip between sessions.

### Proposed

| Condition | Required behavior |
|---|---|
| Feature branch already exists during first setup | Reuse only if a matching owned DB association proves it is this connection; otherwise stop and offer a distinct safe branch name or cancellation. |
| Feature branch deleted | Mark `branch_missing`, retain connection/commit/PR history, and offer inspect, explicitly reconnect to an existing ref, or create a new cycle branch after confirmation. Never silently recreate it. |
| Branch head moved externally | Fetch and compare expected SHA. Preserve unrelated commits; stop and offer refresh/rebase/merge or manual resolution. Never force-push. |
| Base/default branch advanced or renamed | Record new base state and report divergence. Keep the saved original PR base until explicit user confirmation to change it. |
| Concurrent PocketCode publishers | Use optimistic head SHA checks and non-force ref updates; one wins, the other enters conflict/retry-after-refresh. |
| PR merged | Mark connection `merged`; stop publishing to it and present a confirmed next-cycle action. |
| Publish request times out/crashes | Reconcile the remote ref and durable publish intent before retry. Surface unresolved/ambiguous state rather than retrying blindly. |
| Installation access revoked or repository transferred | Mark access unavailable; preserve local metadata and pending operation evidence, and require reconnection/verification before writes. |
| Proposal changed after approval or workspace stale | Require a new review/approval; never silently publish updated contents under an old approval. |

Store base and feature SHAs at each significant workflow transition. Keep audit records for branch creation, publish operation, resulting commits, PR state changes, and recovery decisions.

## 9. Vercel preview integration

### Current

No Vercel integration, project association, Deploy for Preview UI/API, deployment status polling, or preview URL storage was found.

### Proposed

- Make preview deployment a user-triggered action, available only after approved changes have been successfully published to the saved feature branch. Do not deploy on proposal approval, push, PR update, webhook, or page load.
- Connect/authorize the user's Vercel account separately and persist an encrypted credential/reference according to the product's credential policy.
- Before deployment, verify the selected existing Vercel project belongs to the authenticated Vercel account/team and is connected to the same GitHub repository ID (not just a similarly named repo). Re-verify on project changes and before deploying.
- Pin the preview to the saved feature branch and resulting published commit SHA. Do not target production or alter project configuration implicitly.
- Persist deployment ID, connection ID, commit SHA, requested time, status, and preview URL. Poll or consume verified Vercel events to update status, and expose failed/cancelled/ready outcomes.
- If Vercel is not connected or the project's Git repository does not match, disable the action with an explicit remediation path. Never silently switch projects or deploy from the default branch.

## 10. Persistent Pull Request lifecycle

### Current

No pull-request routes, branch write operations, PR storage, or merge controls were found.

### Proposed

- Create one PR per persistent user/repository feature branch, using the saved base branch as the target. Store PR number, URL, base/head refs, state, and last checked time on the durable connection.
- Create the PR only on an explicit user action ("Create Pull Request"), after confirming the feature branch contains published changes. If a PR already exists for the connection, return/update that PR instead of creating duplicates.
- Subsequent published approved changes update the same feature branch; GitHub then updates the same open PR. Reconcile and save its state rather than creating another PR.
- If the branch has an existing open PR on GitHub but no saved PR association (for example after recovery), search by exact head/base and verify repository/owner before associating it.
- Never merge automatically. Show current checks/review status and link the user to GitHub for manual review and merge.
- If GitHub reports a closed but unmerged PR, require explicit next steps; do not silently reopen, recreate, or reset the feature branch.

## 11. Post-merge workflow

### Current

No PR merge detection or next-cycle setup exists.

### Proposed

- Detect merge from a verified GitHub PR response/webhook and reconcile periodically when the connection is revisited. Confirm repository, PR number, expected head branch, saved base branch, merged state, and merge commit.
- Mark the connection `merged` and make it read-only for further publishing. Do not reset the branch or publish commits to the default branch.
- Offer a safe next-cycle setup with the merged history and new base tip visible. Require confirmation before creating a new branch and connection/cycle record, for example `pocketcode/user-<id>/<repo>-cycle-2`.
- Preserve the old connection, branch ref, PR, commit SHAs, and audit history. If GitHub automatically deletes the head branch, record that state; do not treat absence as permission to recreate it.

## 12. Required GitHub App permissions

### Current permissions

Installation tokens are currently requested with **Metadata: read** and **Contents: read**. This supports repository listing and snapshot reads only. Repository listing may report user-level push permissions, but that does not make the installation token write-capable.

### Proposed least privilege

| Permission | Access | Use |
|---|---|---|
| Metadata | Read | Verify repository identity, installation access, and metadata |
| Contents | Read and write | Read branch/tree/blob data, create commits/refs, and update the PocketCode feature ref |
| Pull requests | Read and write | Find/create/update/inspect PocketCode PRs and detect merged/closed state |
| Checks | Read (optional) | Display relevant check-run results in PocketCode; not needed to create branches/commits/PRs |
| Commit statuses | Read (optional) | Only if legacy commit statuses are also displayed |

Do not request administration, workflow, deployment, or default-branch write privileges for the described workflow. Vercel access is separate from GitHub App permissions. Confirm exact endpoint-specific permissions in GitHub's current permission matrix before implementation. Installation-token minting must request only permissions that the App has been granted.

## 13. API endpoints, database migrations, and tests

### Current API surface relevant to this audit

| Route | Current purpose |
|---|---|
| `GET /api/github/repositories` | List accessible repositories and permissions |
| `GET /api/github/repositories/:repositoryId/tree` | Browse a branch tree; ref defaults to GitHub's default branch |
| `GET /api/github/repositories/:repositoryId/file` | Read a file from a repository ref |
| `POST /api/workspaces` | Load a bounded snapshot for caller-supplied repository ID/ref |
| `GET /api/workspaces...` | List/read an owned temporary workspace |
| `POST /api/workspaces/:workspaceId/changes` | Create a pending file proposal |
| `POST /api/workspaces/:workspaceId/changes/:changeId/approve` | Apply an approved change to local workspace only |
| `POST /api/workspaces/:workspaceId/changes/:changeId/reject` | Reject a pending proposal |
| `/api/agent/sessions...` | Create/use persisted agent session bound to a workspace |

Routes are registered in [server/index.ts](../src/server/index.ts), [github-installation-service.ts](../src/auth/github-installation-service.ts), [github-repository-explorer.ts](../src/auth/github-repository-explorer.ts), [workspace-routes.ts](../src/workspaces/workspace-routes.ts), and [agent-routes.ts](../src/agents/agent-routes.ts).

### Proposed API shape

Names are illustrative; keep all mutations authenticated, owner-scoped, CSRF-protected, validated server-side, and idempotent where they perform remote writes.

| Proposed route | Responsibility |
|---|---|
| `POST /api/repository-connections` | Confirm repository and idempotently provision first feature branch |
| `GET /api/repository-connections` / `GET /api/repository-connections/:id` | List and inspect the authenticated user's saved connections/status |
| `POST /api/repository-connections/:id/refresh` | Re-verify repo/ref/head/base/PR state and report divergence |
| `POST /api/repository-connections/:id/workspaces` | Create a workspace from the server-resolved persistent feature branch |
| `POST /api/workspaces/:id/publishes` | Publish an exact set of already-approved proposals with idempotency key |
| `GET /api/workspaces/:id/publishes/:operationId` | Inspect/recover publish operation state |
| `POST /api/repository-connections/:id/pull-request` | Explicitly create or reconcile the one saved PR |
| `GET /api/repository-connections/:id/pull-request` | Refresh current PR state; never merge |
| `POST /api/repository-connections/:id/previews` | Explicitly deploy the published feature commit to a verified Vercel preview project |
| `GET /api/repository-connections/:id/previews/:deploymentId` | Track deployment status and preview URL |
| `POST /api/repository-connections/:id/next-cycle` | Explicitly provision a new branch after merge/deletion recovery |

Do not let workspace-create or publish requests choose arbitrary repository/branch refs. Derive these from the owned durable connection. Keep preview deployment and PR creation as separate explicit actions.

### Proposed migrations

1. Add durable repository-connection/cycle state, user/repository uniqueness, branch ownership uniqueness, base/head SHAs, lifecycle fields, PR metadata, timestamps, and indexes.
2. Add durable publish operations and per-proposal publication association/idempotency keys, including status and recovery metadata.
3. Add Vercel account/project association and deployment records with encrypted credential/reference handling as appropriate.
4. Add audit/event records if not handled by an existing durable audit service.
5. Do not attempt to infer new connection ownership from old workspace rows without verified user confirmation. Existing sessions/workspaces are not a safe source for persistent-branch associations.

### Proposed tests

- Migration tests: constraints, indexes, upgrades from the current schema, cascade behavior, and preservation of existing user/auth data.
- Confirmation/provisioning tests: explicit confirmation; repository ID/default branch revalidation; same-user idempotency; branch already exists; timeout after remote create; wrong repository/owner; no default-branch ref writes.
- Isolation tests: same repository selected by two users yields distinct connections/branches; cross-user connection/workspace/publish access returns not found/forbidden; branch name collision never associates silently.
- Workspace tests: each new workspace loads the saved feature ref and includes earlier published content; it records exact head/base SHAs; default branch is never used as a write target.
- Proposal/publish tests: pending/rejected proposals are excluded; only approved contents are committed; retries create no duplicate commit; interrupted writes reconcile; unrelated remote commits are preserved; concurrent update and non-fast-forward errors enter recoverable conflict.
- Branch lifecycle tests: deleted branch, moved branch, base rename/advance, closed PR, merged PR, installation revocation, and confirmed next-cycle behavior never silently recreate/reset/write default branch.
- PR tests: exactly one matching PR per connection; later updates retain it; reopened/unmerged states are reconciled; merge action is absent.
- Vercel tests: explicit click/action only; project belongs to connected account and exact GitHub repository ID; deployment is pinned to feature branch/commit; status/URL persistence; no production/default-branch deployment.
- Route/UI tests: authorization, CSRF, useful conflict/recovery messages, no credentials or private paths in responses/logs, and deployment/PR actions remain explicit.
- Use mocked GitHub/Vercel APIs for deterministic unit/integration tests; keep any live-provider test separately gated and opt-in.

Existing relevant tests include [workspaces.test.ts](../tests/workspaces.test.ts), [github-repositories.test.ts](../tests/github-repositories.test.ts), [github-repository-explorer.test.ts](../tests/github-repository-explorer.test.ts), [agents.test.ts](../tests/agents.test.ts), and [server.test.ts](../tests/server.test.ts). No branch-writing, PR, or Vercel tests currently exist.

## 14. Phased implementation plan

1. **Persistence and ownership foundation** - Add migrations and repository-connection APIs; define per-user isolation, immutable repository identity, lifecycle states, and explicit confirmation UX. No publishing in this phase.
2. **Safe branch provisioning and reuse** - Add idempotent first-time branch creation with recovery; change new workspaces to load the saved feature branch; verify repository/ref ownership; add branch deletion/merge/moved-head handling.
3. **Approved-change publishing** - Add durable publish intents, idempotency/recovery, approved-delta Git commits, non-force branch-ref updates, and conflict UX. Keep default branch writes impossible by construction and test.
4. **Persistent PR lifecycle** - Add explicit create/reconcile for one PR per connection, continued updates to that PR, and merged-state detection. Do not add auto-merge.
5. **Explicit Vercel preview** - Add Vercel connection/project verification, user-triggered preview deployment pinned to the published feature commit, and durable status/URL tracking.
6. **Post-merge next cycle and operational hardening** - Add explicit new-cycle setup, audit/metrics/recovery tooling, access revocation handling, concurrency/load tests, permission review, and deployment documentation.

Each phase should be separately reviewed and tested. Keep migrations additive and preserve existing data. The implementation must not enable branch or deployment writes until ownership, idempotency, default-branch exclusion, and recovery tests pass.
