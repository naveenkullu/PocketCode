import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { GitHubAppConfig } from "../server/index.js";
import { createGitHubInstallationToken, GitHubAppApiError } from "../auth/github-app-auth.js";
import { resolveAccessibleRepository, type RepoTarget } from "../auth/github-repository-explorer.js";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const SHA_PATTERN = /^[a-f\d]{40,64}$/i;
const BRANCH_FORBIDDEN = /[\x00-\x20\x7f ~^:?*[\]\\]/;

type ConnectionStatus = "provisioning" | "active" | "branch_missing" | "access_lost" | "branch_collision" | "recovery_required";

interface ConnectionRow {
  id: string;
  user_id: string;
  repository_id: string;
  installation_id: string;
  owner_login: string;
  repository_name: string;
  default_branch: string;
  base_commit_sha: string;
  feature_branch: string;
  head_commit_sha: string | null;
  status: ConnectionStatus;
  created_at: string;
  updated_at: string;
}

export interface RepositoryBranchConnection {
  id: string;
  repositoryId: string;
  owner: string;
  repositoryName: string;
  defaultBranch: string;
  baseCommitSha: string;
  featureBranch: string;
  headCommitSha: string | null;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
}

export class RepositoryBranchError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
  }
}

interface GitHubResponse {
  response: Response;
  status: number;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRepositoryId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

export function isSafeBranchRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 255 && !ref.startsWith("-") &&
    !BRANCH_FORBIDDEN.test(ref) && !ref.includes("..") && !ref.includes("@{") &&
    !ref.endsWith("/") && !ref.endsWith(".") &&
    ref.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." &&
      !part.startsWith(".") && !part.endsWith(".lock"));
}

function connection(row: ConnectionRow): RepositoryBranchConnection {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    owner: row.owner_login,
    repositoryName: row.repository_name,
    defaultBranch: row.default_branch,
    baseCommitSha: row.base_commit_sha,
    featureBranch: row.feature_branch,
    headCommitSha: row.head_commit_sha,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function apiError(response: Response): RepositoryBranchError {
  if (response.status === 429 || response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    return new RepositoryBranchError("github_rate_limited", 429);
  }
  if (response.status === 404 || response.status === 401) return new RepositoryBranchError("github_resource_not_found", 404);
  if (response.status === 403) return new RepositoryBranchError("github_permission_denied", 403);
  return new RepositoryBranchError("github_unavailable", 503);
}

export class RepositoryBranchService {
  private readonly inFlight = new Map<string, Promise<RepositoryBranchConnection>>();

  constructor(private readonly database: Database.Database, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request(target: RepoTarget, url: string, method = "GET", body?: unknown, token = target.token): Promise<GitHubResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new RepositoryBranchError("github_unavailable", 503);
    }
    let parsed: unknown = null;
    try { parsed = await response.json(); } catch { /* GitHub may return an empty response. */ }
    return { response, status: response.status, body: parsed };
  }

  private async getJson(target: RepoTarget, url: string): Promise<Record<string, unknown>> {
    const result = await this.request(target, url);
    if (result.status !== 200) throw apiError(result.response);
    if (!isRecord(result.body)) throw new RepositoryBranchError("github_invalid_response", 503);
    return result.body;
  }

  private find(userId: string, repositoryId: string): ConnectionRow | undefined {
    return this.database.prepare("SELECT * FROM repository_branches WHERE user_id = ? AND repository_id = ?")
      .get(userId, repositoryId) as ConnectionRow | undefined;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private setStatus(row: ConnectionRow, status: ConnectionStatus): void {
    this.database.prepare("UPDATE repository_branches SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.now(), row.id);
  }

  private async resolveOwnedRepository(
    userId: string,
    repositoryId: string,
    config: GitHubAppConfig,
    installationId?: string,
  ): Promise<RepoTarget> {
    const target = await resolveAccessibleRepository(userId, repositoryId, config, this.database, this.fetchImpl, installationId);
    if (!target) throw new RepositoryBranchError("repository_access_unavailable", 403);
    return target;
  }

  private async repositoryMetadata(target: RepoTarget, expectedRepositoryId: string): Promise<{ owner: string; name: string; defaultBranch: string }> {
    const metadata = await this.getJson(target, `${API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`);
    if (!validRepositoryId(String(metadata.id)) || String(metadata.id) !== expectedRepositoryId ||
        typeof metadata.owner !== "object" || metadata.owner === null ||
        !isRecord(metadata.owner) || typeof metadata.owner.login !== "string" ||
        typeof metadata.name !== "string" || typeof metadata.default_branch !== "string" ||
        !isSafeBranchRef(metadata.default_branch)) {
      throw new RepositoryBranchError("repository_identity_mismatch", 409);
    }
    return { owner: metadata.owner.login, name: metadata.name, defaultBranch: metadata.default_branch };
  }

  private async branchSha(target: RepoTarget, ref: string): Promise<string> {
    if (!isSafeBranchRef(ref)) throw new RepositoryBranchError("invalid_branch_ref", 400);
    const body = await this.getJson(target,
      `${API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/branches/${encodeURIComponent(ref)}`);
    if (!isRecord(body.commit) || typeof body.commit.sha !== "string" || !SHA_PATTERN.test(body.commit.sha)) {
      throw new RepositoryBranchError("github_invalid_response", 503);
    }
    return body.commit.sha;
  }

  private async branchExists(target: RepoTarget, ref: string): Promise<{ sha: string } | null> {
    try {
      return { sha: await this.branchSha(target, ref) };
    } catch (error) {
      if (error instanceof RepositoryBranchError && error.code === "github_resource_not_found") return null;
      throw error;
    }
  }

  private async verifyConnection(row: ConnectionRow, config: GitHubAppConfig): Promise<{ connection: RepositoryBranchConnection; target: RepoTarget | null }> {
    if (row.status === "branch_missing" || row.status === "branch_collision" ||
        row.status === "provisioning" ||
        row.status === "recovery_required" && row.head_commit_sha !== row.base_commit_sha) {
      return { connection: connection(row), target: null };
    }

    let target: RepoTarget;
    try {
      target = await this.resolveOwnedRepository(row.user_id, row.repository_id, config, row.installation_id);
      // Refresh token to ensure it reflects latest permissions (avoid stale cached token)
      try {
        const refreshedToken = await createGitHubInstallationToken(target.installationId, config, this.fetchImpl);
        target = { ...target, token: refreshedToken };
        console.debug('Refreshed GitHub installation token for verification');
      } catch (e) {
        // If refreshing fails, fallback to original token; verification may still succeed or will error appropriately.
        console.debug('Failed to refresh token, using existing token');
      }
    } catch (error) {
      if (error instanceof RepositoryBranchError && error.code === "repository_access_unavailable") {
        this.setStatus(row, "access_lost");
        return { connection: connection({ ...row, status: "access_lost", updated_at: this.now() }), target: null };
      }
      throw error;
    }
    if (target.installationId !== row.installation_id) {
      this.setStatus(row, "access_lost");
      return { connection: connection({ ...row, status: "access_lost", updated_at: this.now() }), target: null };
    }

    let metadata: { owner: string; name: string; defaultBranch: string };
    try {
      metadata = await this.repositoryMetadata(target, row.repository_id);
    } catch (error) {
      if (error instanceof RepositoryBranchError && error.code === "github_resource_not_found") {
        this.setStatus(row, "access_lost");
        return { connection: connection({ ...row, status: "access_lost", updated_at: this.now() }), target: null };
      }
      throw error;
    }
    if (row.feature_branch === row.default_branch) {
      this.setStatus(row, "recovery_required");
      return { connection: connection({ ...row, status: "recovery_required", updated_at: this.now() }), target: null };
    }
    const existing = await this.branchExists(target, row.feature_branch);
    if (!existing) {
      this.setStatus(row, "branch_missing");
      return { connection: connection({ ...row, status: "branch_missing", updated_at: this.now() }), target: null };
    }
    if (row.status === "recovery_required" && existing.sha !== row.head_commit_sha) {
      return { connection: connection(row), target: null };
    }
    const updatedAt = this.now();
    this.database.prepare(`UPDATE repository_branches SET owner_login = ?, repository_name = ?, head_commit_sha = ?,
      status = 'active', updated_at = ? WHERE id = ?`)
      .run(metadata.owner, metadata.name, existing.sha, updatedAt, row.id);
    return {
      connection: connection({
        ...row, owner_login: metadata.owner, repository_name: metadata.name, head_commit_sha: existing.sha,
        status: "active", updated_at: updatedAt,
      }),
      target,
    };
  }

  async get(userId: string, repositoryId: string, config: GitHubAppConfig): Promise<RepositoryBranchConnection | null> {
    if (!validRepositoryId(repositoryId)) throw new RepositoryBranchError("invalid_repository_id", 400);
    const row = this.find(userId, repositoryId);
    if (!row) return null;
    return (await this.verifyConnection(row, config)).connection;
  }

  async getForWorkspace(
    userId: string, repositoryId: string, config: GitHubAppConfig,
  ): Promise<{ connection: RepositoryBranchConnection; target: RepoTarget }> {
    if (!validRepositoryId(repositoryId)) throw new RepositoryBranchError("invalid_repository_id", 400);
    const row = this.find(userId, repositoryId);
    if (!row) throw new RepositoryBranchError("connection_not_found", 409);
    const verified = await this.verifyConnection(row, config);
    if (verified.connection.status !== "active" || !verified.target) {
      throw new RepositoryBranchError(verified.connection.status === "branch_missing" ? "feature_branch_missing" :
        verified.connection.status === "access_lost" ? "repository_access_unavailable" : "branch_recovery_required", 409);
    }
    return { connection: verified.connection, target: verified.target };
  }

  async provision(
    userId: string, repositoryId: string, config: GitHubAppConfig, confirmed: boolean,
  ): Promise<RepositoryBranchConnection> {
    if (!confirmed) throw new RepositoryBranchError("repository_confirmation_required", 400);
    if (!validRepositoryId(repositoryId)) throw new RepositoryBranchError("invalid_repository_id", 400);
    const key = `${userId}:${repositoryId}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const operation = this.provisionOnce(userId, repositoryId, config);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  private async provisionOnce(userId: string, repositoryId: string, config: GitHubAppConfig): Promise<RepositoryBranchConnection> {
    const saved = this.find(userId, repositoryId);
    if (saved) {
      if (saved.status === "active" || saved.status === "access_lost" ||
          saved.status === "recovery_required" && saved.head_commit_sha === saved.base_commit_sha) {
        return (await this.verifyConnection(saved, config)).connection;
      }
      return connection(saved);
    }

    const githubUserId = this.database.prepare("SELECT github_user_id FROM users WHERE id = ?")
      .get(userId) as { github_user_id: string | null } | undefined;
    if (!githubUserId?.github_user_id || !/^\d+$/.test(githubUserId.github_user_id)) {
      throw new RepositoryBranchError("github_identity_unavailable", 403);
    }

    const target = await this.resolveOwnedRepository(userId, repositoryId, config);
    const metadata = await this.repositoryMetadata(target, repositoryId);
    const baseCommitSha = await this.branchSha(target, metadata.defaultBranch);
    const slug = metadata.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "repository";
    const featureBranch = `pocketcode/user-${githubUserId.github_user_id}/${slug}`;
    if (!isSafeBranchRef(featureBranch) || featureBranch === metadata.defaultBranch) {
      throw new RepositoryBranchError("invalid_branch_ref", 400);
    }
    if (await this.branchExists(target, featureBranch)) {
      throw new RepositoryBranchError("branch_name_collision", 409);
    }

    const createdAt = this.now();
    const insert = this.database.prepare(`INSERT INTO repository_branches
      (id,user_id,repository_id,installation_id,owner_login,repository_name,default_branch,base_commit_sha,
       feature_branch,head_commit_sha,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,NULL,'provisioning',?,?) ON CONFLICT(user_id,repository_id) DO NOTHING`);
    const result = insert.run(randomUUID(), userId, repositoryId, target.installationId, metadata.owner, metadata.name,
      metadata.defaultBranch, baseCommitSha, featureBranch, createdAt, createdAt);
    if (result.changes !== 1) {
      const concurrent = this.find(userId, repositoryId);
      if (concurrent) return connection(concurrent);
      throw new RepositoryBranchError("branch_setup_in_progress", 409);
    }
    const reserved = this.find(userId, repositoryId)!;

    let writeToken: string;
    try {
      writeToken = await createGitHubInstallationToken(target.installationId, config, this.fetchImpl, { contents: "write" });
    } catch (error) {
      this.database.prepare("DELETE FROM repository_branches WHERE id = ? AND status = 'provisioning'").run(reserved.id);
      if (error instanceof GitHubAppApiError && error.code === "rate_limited") {
        throw new RepositoryBranchError("github_rate_limited", 429);
      }
      if (error instanceof GitHubAppApiError && error.code === "permission_denied") {
        throw new RepositoryBranchError("github_permission_denied", 403);
      }
      throw new RepositoryBranchError("github_unavailable", 503);
    }

    let resultCreate: GitHubResponse;
    try {
      resultCreate = await this.request(target,
        `${API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/git/refs`,
        "POST", { ref: `refs/heads/${featureBranch}`, sha: baseCommitSha }, writeToken);
    } catch (error) {
      this.setStatus(reserved, "recovery_required");
      throw error;
    }
    if (resultCreate.status === 409 || resultCreate.status === 422) {
      this.setStatus(reserved, "branch_collision");
      throw new RepositoryBranchError("branch_name_collision", 409);
    }
    if (resultCreate.status !== 201) {
      const classified = apiError(resultCreate.response);
      const code = resultCreate.status === 404 ? "repository_access_unavailable" : classified.code;
      if ([401, 403, 404, 429].includes(resultCreate.status)) {
        this.database.prepare("DELETE FROM repository_branches WHERE id = ? AND status = 'provisioning'").run(reserved.id);
      } else {
        this.setStatus(reserved, "recovery_required");
      }
      throw new RepositoryBranchError(code, classified.statusCode);
    }
    if (!isRecord(resultCreate.body) || resultCreate.body.ref !== `refs/heads/${featureBranch}` ||
        !isRecord(resultCreate.body.object) || resultCreate.body.object.sha !== baseCommitSha) {
      this.setStatus(reserved, "recovery_required");
      throw new RepositoryBranchError("branch_recovery_required", 503);
    }

    const updatedAt = this.now();
    try {
      const activated = this.database.prepare(`UPDATE repository_branches SET head_commit_sha = ?, status = 'active', updated_at = ?
        WHERE id = ? AND status = 'provisioning'`).run(baseCommitSha, updatedAt, reserved.id);
      if (activated.changes !== 1) throw new Error("branch_activation_conflict");
    } catch {
      try {
        this.database.prepare(`UPDATE repository_branches SET head_commit_sha = ?, status = 'recovery_required', updated_at = ?
          WHERE id = ? AND status = 'provisioning'`).run(baseCommitSha, this.now(), reserved.id);
      } catch { /* The durable provisioning reservation still blocks unsafe retries. */ }
      throw new RepositoryBranchError("branch_persistence_failed", 503);
    }
    const active = this.find(userId, repositoryId);
    if (!active || active.status !== "active") {
      throw new RepositoryBranchError("branch_persistence_failed", 503);
    }
    return connection(active);
  }
}
