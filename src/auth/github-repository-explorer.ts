import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GitHubAppConfig } from "../server/index.js";
import { createGitHubInstallationToken, fetchVerifiedInstallation, GitHubAppApiError } from "./github-app-auth.js";
import { validateSession } from "./session-service.js";

const API = "https://api.github.com";
const MAX_FILE_BYTES = 1_048_576;
const API_VERSION = "2022-11-28";
export type RepoTarget = { id: string; owner: string; name: string; installationId: string; token: string };

interface Dependencies {
  database: Database.Database;
  fetchImpl?: typeof fetch;
  validateConfiguration: () => GitHubAppConfig;
}

function sessionUser(request: FastifyRequest, database: Database.Database): string | null {
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("pocketcode_session="));
  return validateSession(database, cookie?.slice("pocketcode_session=".length))?.userId ?? null;
}

function validId(value: string): boolean { return /^\d+$/.test(value) && value.length <= 20; }
function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && !/[\\\0\r\n]/.test(value) &&
    value.split("/").every((part) => part !== "." && part !== "..");
}
function safeRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255 &&
    !value.startsWith("-") && !/[\0\r\n\\]/.test(value) && !value.split("/").some((part) => !part || part === "." || part === "..");
}
function apiHeaders(token: string) {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": API_VERSION };
}
function rateLimited(response: Response): boolean {
  return response.status === 429 || response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveRepository(
  userId: string, repositoryId: string, config: GitHubAppConfig, database: Database.Database, fetchImpl: typeof fetch,
  requiredInstallationId?: string,
): Promise<RepoTarget | null> {
  const installations = database.prepare(`SELECT installation_id AS id FROM github_installations
    WHERE user_id = ? AND status = 'active' AND (? IS NULL OR installation_id = ?) ORDER BY installation_id`)
    .all(userId, requiredInstallationId ?? null, requiredInstallationId ?? null) as Array<{ id: string }>;
  for (const installation of installations) {
    let verified;
    try { verified = await fetchVerifiedInstallation(installation.id, config, fetchImpl); }
    catch (error) {
      if (error instanceof GitHubAppApiError && error.code === "rate_limited") throw error;
      continue;
    }
    if (verified.suspended) continue;
    let token: string;
    try { token = await createGitHubInstallationToken(installation.id, config, fetchImpl); }
    catch (error) {
      if (error instanceof GitHubAppApiError && error.code === "rate_limited") throw error;
      continue;
    }
    for (let page = 1; page <= 100; page++) {
      let response: Response;
      try {
        response = await fetchImpl(`${API}/installation/repositories?per_page=100&page=${page}`, {
          headers: apiHeaders(token), signal: AbortSignal.timeout(10_000),
        });
      } catch { throw new GitHubAppApiError("unavailable"); }
      if (rateLimited(response)) throw new GitHubAppApiError("rate_limited");
      if (response.status === 401 || response.status === 404) break;
      if (!response.ok) throw new GitHubAppApiError("unavailable");
      let body: unknown;
      try { body = await response.json(); } catch { throw new GitHubAppApiError("invalid_response"); }
      if (!record(body) || !Array.isArray(body.repositories)) throw new GitHubAppApiError("invalid_response");
      for (const repo of body.repositories) {
        if (!record(repo) || (typeof repo.id !== "number" && typeof repo.id !== "string") ||
            !/^\d+$/.test(String(repo.id)) || typeof repo.name !== "string" || !record(repo.owner) || typeof repo.owner.login !== "string") {
          throw new GitHubAppApiError("invalid_response");
        }
        if (String(repo.id) === repositoryId) return { id: repositoryId, owner: repo.owner.login, name: repo.name, installationId: installation.id, token };
      }
      if (body.repositories.length < 100) break;
      if (page === 100) throw new GitHubAppApiError("unavailable");
    }
  }
  return null;
}

/** Resolves a requested repository through the same authenticated installation path as the explorer. */
/** Resolves a requested repository through the same authenticated installation path as the explorer. */
export async function resolveAccessibleRepository(
  userId: string, repositoryId: string, config: GitHubAppConfig, database: Database.Database, fetchImpl: typeof fetch,
  requiredInstallationId?: string,
): Promise<RepoTarget | null> {
  return resolveRepository(userId, repositoryId, config, database, fetchImpl, requiredInstallationId);
}

async function requestJson(fetchImpl: typeof fetch, url: string, token: string): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try { response = await fetchImpl(url, { headers: apiHeaders(token), signal: AbortSignal.timeout(10_000) }); }
  catch { throw new GitHubAppApiError("unavailable"); }
  if (rateLimited(response)) throw new GitHubAppApiError("rate_limited");
  if (response.status === 404 || response.status === 401 || response.status === 403) throw new GitHubAppApiError("not_found");
  if (!response.ok) throw new GitHubAppApiError("unavailable");
  let body: unknown;
  try { body = await response.json(); } catch { throw new GitHubAppApiError("invalid_response"); }
  return { response, body };
}

export function registerGitHubRepositoryExplorerRoutes(app: FastifyInstance, dependencies: Dependencies): void {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const routes = [
    ["tree", false], ["file", true],
  ] as const;
  for (const [endpoint, isFile] of routes) {
    app.get(`/api/github/repositories/:repositoryId/${endpoint}`, async (request, reply) => {
      const userId = sessionUser(request, dependencies.database);
      if (!userId) return reply.header("Cache-Control", "no-store").status(401).send({ error: "unauthorized" });
      const { repositoryId } = request.params as { repositoryId: string };
      const query = request.query as { path?: unknown; ref?: unknown };
      const path = query.path === undefined ? "" : query.path;
      const ref = query.ref === undefined ? undefined : query.ref;
      if (!validId(repositoryId) || !safePath(path) || ref !== undefined && !safeRef(ref)) {
        return reply.header("Cache-Control", "no-store").status(400).send({ error: "invalid_path_or_ref" });
      }
      let config: GitHubAppConfig;
      try { config = dependencies.validateConfiguration(); }
      catch { return reply.header("Cache-Control", "no-store").status(503).send({ error: "github_repository_unavailable" }); }
      try {
        const target = await resolveRepository(userId, repositoryId, config, dependencies.database, fetchImpl);
        if (!target) return reply.header("Cache-Control", "no-store").status(404).send({ error: "repository_not_found" });
        let body: unknown;
        if (!isFile && !path) {
          const { response, body: repositoryBody } = await requestJson(fetchImpl,
            `${API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`, target.token);
          if (!record(repositoryBody) || typeof repositoryBody.default_branch !== "string") throw new GitHubAppApiError("invalid_response");
          const selectedRef = ref ?? repositoryBody.default_branch;
          const branch = await requestJson(fetchImpl,
            `${API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/branches/${encodeURIComponent(selectedRef)}`, target.token);
          if (!record(branch.body) || !record(branch.body.commit) || !record(branch.body.commit.commit) || !record(branch.body.commit.commit.tree) || typeof branch.body.commit.commit.tree.sha !== "string") {
            throw new GitHubAppApiError("invalid_response");
          }
          const { body: treeBody } = await requestJson(fetchImpl,
            `${API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/git/trees/${encodeURIComponent(branch.body.commit.commit.tree.sha)}`, target.token);
          if (!record(treeBody) || !Array.isArray(treeBody.tree) || typeof treeBody.truncated !== "boolean") throw new GitHubAppApiError("invalid_response");
          const treeItems = [...treeBody.tree];
          if (treeBody.truncated) {
            const directories = treeItems.filter((item) => record(item) && item.type === "tree" && typeof item.path === "string" && typeof item.sha === "string");
            if (directories.length > 100) throw new GitHubAppApiError("unavailable");
            for (const directory of directories as Array<Record<string, unknown>>) {
              const { body: subtree } = await requestJson(fetchImpl,
                `${API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/git/trees/${encodeURIComponent(String(directory.sha))}`, target.token);
              if (!record(subtree) || !Array.isArray(subtree.tree)) throw new GitHubAppApiError("invalid_response");
              for (const entry of subtree.tree) {
                if (!record(entry) || typeof entry.path !== "string") throw new GitHubAppApiError("invalid_response");
              treeItems.push({ ...entry, path: `${directory.path}/${entry.path}`, parentPath: directory.path });
              }
            }
          }
          const prefix = path ? `${path}/` : "";
          const direct = new Map<string, Record<string, unknown>>();
          for (const entry of treeItems) {
            if (!record(entry) || typeof entry.path !== "string" || typeof entry.type !== "string") throw new GitHubAppApiError("invalid_response");
            if (path && entry.parentPath !== path) continue;
            if (!path && entry.parentPath !== undefined) continue;
            if (path && !entry.path.startsWith(prefix)) continue;
            const remainder = path ? entry.path.slice(prefix.length) : entry.path;
            if (!remainder || remainder.includes("/")) continue;
            direct.set(remainder, { ...entry, path: entry.path });
          }
          const entries = [...direct.values()].map((item) => ({
            name: item.path === path ? item.path : String(item.path).split("/").at(-1),
            path: item.path,
            type: item.type === "tree" ? "directory" : item.type === "blob" ? "file" : item.type,
            ...(typeof item.size === "number" ? { size: item.size } : {}),
            ...(typeof item.url === "string" ? { htmlUrl: `https://github.com/${target.owner}/${target.name}/tree/${encodeURIComponent(selectedRef)}/${String(item.path).split("/").map(encodeURIComponent).join("/")}` } : {}),
          }));
          return reply.header("Cache-Control", "no-store").send({ repositoryId, path, ref: selectedRef, entries });
        }
        const encodedPath = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
        const url = new URL(`${API}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/contents${encodedPath}`);
        if (ref !== undefined) url.searchParams.set("ref", ref);
        ({ body } = await requestJson(fetchImpl, url.toString(), target.token));
        if (isFile) {
          if (!record(body) || body.type !== "file" || typeof body.path !== "string" ||
              typeof body.size !== "number" || !Number.isSafeInteger(body.size) || body.size < 0 ||
              body.size > MAX_FILE_BYTES || typeof body.encoding !== "string" || typeof body.content !== "string") {
            return reply.header("Cache-Control", "no-store").status(body && record(body) && typeof body.size === "number" && body.size > MAX_FILE_BYTES ? 413 : 415)
              .send({ error: body && record(body) && typeof body.size === "number" && body.size > MAX_FILE_BYTES ? "file_too_large" : "text_file_unavailable" });
          }
          if (body.encoding !== "base64" || body.content.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content)) {
            return reply.header("Cache-Control", "no-store").status(415).send({ error: "binary_file_unsupported" });
          }
          const bytes = Buffer.from(body.content, "base64");
          if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) return reply.header("Cache-Control", "no-store").status(bytes.length > MAX_FILE_BYTES ? 413 : 415).send({ error: bytes.length > MAX_FILE_BYTES ? "file_too_large" : "binary_file_unsupported" });
          let content: string;
          try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
          catch { return reply.header("Cache-Control", "no-store").status(415).send({ error: "binary_file_unsupported" }); }
          return reply.header("Cache-Control", "no-store").send({ repositoryId, path: body.path, ref: ref ?? null, size: bytes.length, encoding: "utf-8", content });
        }
        if (!Array.isArray(body)) return reply.header("Cache-Control", "no-store").status(404).send({ error: "directory_not_found" });
        const entries = [];
        for (const item of body) {
          if (!record(item) || typeof item.name !== "string" || typeof item.path !== "string" || typeof item.type !== "string") {
            throw new GitHubAppApiError("invalid_response");
          }
          const type = item.type === "dir" ? "directory" : item.type === "file" ? "file" : item.type;
          entries.push({ name: item.name, path: item.path, type,
            ...(typeof item.size === "number" ? { size: item.size } : {}),
            ...(typeof item.html_url === "string" ? { htmlUrl: item.html_url } : {}),
          });
        }
        return reply.header("Cache-Control", "no-store").send({ repositoryId, path, ref: ref ?? null, entries });
      } catch (error) {
        request.log.warn({ code: error instanceof GitHubAppApiError ? error.code : "unavailable" }, "GitHub repository explorer request failed");
        const limited = error instanceof GitHubAppApiError && error.code === "rate_limited";
        const notFound = error instanceof GitHubAppApiError && error.code === "not_found";
        return reply.header("Cache-Control", "no-store").status(limited ? 429 : notFound ? 404 : 503)
          .send({ error: limited ? "github_rate_limited" : notFound ? "repository_or_path_not_found" : "github_repository_unavailable" });
      }
    });
  }
}