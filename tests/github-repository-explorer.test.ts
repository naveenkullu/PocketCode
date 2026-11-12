import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { createSession } from "../src/auth/session-service.js";
import { openDatabase } from "../src/storage/database.js";
import { createServer, type GitHubAppConfig } from "../src/server/index.js";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const githubApp: GitHubAppConfig = { clientId: "Iv1.test", clientSecret: "secret-client", slug: "test-app", appId: "12345", privateKey: key,
  callbackUrl: "http://localhost:3000/auth/github/callback", tokenEncryptionKey: "0123456789abcdef".repeat(4) };

function fixture(fetchImpl: typeof fetch) {
  const database = openDatabase(":memory:");
  for (const [id, name] of [["u1", "one"], ["u2", "two"]]) database.prepare("INSERT INTO users (id, github_user_id, github_username) VALUES (?, ?, ?)").run(id, id, name);
  const session = createSession(database, "u1");
  const add = (installationId: string, userId = "u1", status = "active") => database.prepare(`INSERT INTO github_installations
    (id,user_id,installation_id,account_id,account_login,account_type,repository_selection,status) VALUES (?,?,?,?,?,?,?,?)`)
    .run(`record-${installationId}`, userId, installationId, "1", `owner-${installationId}`, "User", "all", status);
  const app = createServer({ config: { port: 3000, host: "127.0.0.1", publicBaseUrl: "http://localhost:3000", githubApp }, database, fetchImpl });
  return { app, database, session, add };
}

const repo = { id: 321, name: "code", owner: { login: "octo" } };
function mock(bodyForContent: (url: URL) => Response, options: { truncated?: boolean; failTree?: boolean; rateLimit?: boolean } = {}) {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); urls.push(url.toString());
    if (url.pathname.match(/\/app\/installations\/\d+$/)) return Response.json({ id: 70, app_id: 12345, account: { id: 1, login: "owner-70", type: "User" }, repository_selection: "all", suspended_at: null });
    if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "ghs-secret-file-token", expires_at: new Date(Date.now() + 60_000).toISOString() });
    if (url.pathname.endsWith("/installation/repositories")) {
      if (options.rateLimit) return Response.json({ message: "private token leaked" }, { status: 429 });
      return Response.json({ repositories: [repo] });
    }
    if (url.pathname === "/repos/octo/code") return Response.json({ default_branch: "main" });
    if (url.pathname.includes("/branches/")) return Response.json({ commit: { commit: { tree: { sha: "main-tree" } } } });
    if (url.pathname.includes("/git/trees/")) {
      if (options.failTree) return Response.json({}, { status: 404 });
      if (url.pathname.endsWith("/git/trees/main-tree")) return Response.json({ truncated: options.truncated ?? false, tree: [{ path: "dir", type: "tree", sha: "tree-sha" }] });
      return Response.json({ truncated: false, tree: [{ path: "nested.txt", type: "blob", sha: "blob-sha", size: 2, url: "https://api.github.com/repos/octo/code/git/blobs/blob-sha" }] });
    }
    if (url.pathname.endsWith("/git/trees/tree-sha")) return Response.json({ truncated: false, tree: [{ path: "nested.txt", type: "blob", sha: "blob-sha", size: 2, url: "https://api.github.com/repos/octo/code/git/blobs/blob-sha" }] });
    if (url.pathname.endsWith("/git/blobs/blob-sha")) return Response.json({ sha: "blob-sha", size: 2, encoding: "base64", content: Buffer.from("hi").toString("base64") });
    if (options.rateLimit) return Response.json({ message: "private token leaked" }, { status: 429 });
    return bodyForContent(url);
  };
  return { fetchImpl, urls };
}

describe("GitHub repository file explorer", () => {
  it("requires a PocketCode session", async () => {
    const { app } = fixture(async () => { throw new Error("unexpected"); });
    try { assert.equal((await app.inject({ method: "GET", url: "/api/github/repositories/321/tree" })).statusCode, 401); }
    finally { await app.close(); }
  });

  it("lists root and nested folders using verified repository ID and selected ref", async () => {
    const calls: string[] = [];
    const mockApi = mock((url) => {
      calls.push(url.toString());
      return Response.json(url.pathname.endsWith("/contents/dir") ? [
        { name: "nested.txt", path: "dir/nested.txt", type: "file", size: 2, html_url: "https://github.com/octo/code/blob/main/dir/nested.txt" },
      ] : [{ name: "dir", path: "dir", type: "dir", html_url: "https://github.com/octo/code/tree/main/dir" }]);
    });
    const { app, session, add } = fixture(mockApi.fetchImpl); add("70");
    try {
      const headers = { cookie: `pocketcode_session=${session.token}` };
      const root = await app.inject({ method: "GET", url: "/api/github/repositories/321/tree?ref=main", headers });
      assert.equal(root.statusCode, 200);
      assert.deepEqual(root.json().entries, [{ name: "dir", path: "dir", type: "directory" }]);
      const nested = await app.inject({ method: "GET", url: "/api/github/repositories/321/tree?path=dir&ref=feature%2Fdemo", headers });
      assert.equal(nested.statusCode, 200);
      assert.equal(nested.json().ref, "feature/demo");
      assert.ok(calls.some((call) => new URL(call).searchParams.get("ref") === "feature/demo"));
      assert.equal(root.headers["cache-control"], "no-store");
    } finally { await app.close(); }
  });

  it("reads UTF-8 text files and rejects traversal, binary, and oversized files", async () => {
    const mockApi = mock((url) => {
      const path = url.pathname.split("/contents/")[1];
      if (path === "large") return Response.json({ type: "file", path, size: 1_048_577, encoding: "base64", content: "" });
      if (path === "binary") return Response.json({ type: "file", path, size: 2, encoding: "base64", content: "AAE=" });
      return Response.json({ type: "file", path: "src/a.ts", size: 5, encoding: "base64", content: Buffer.from("hello").toString("base64") });
    });
    const { app, session, add } = fixture(mockApi.fetchImpl); add("70");
    try {
      const headers = { cookie: `pocketcode_session=${session.token}` };
      const file = await app.inject({ method: "GET", url: "/api/github/repositories/321/file?path=src%2Fa.ts&ref=feature", headers });
      assert.equal(file.statusCode, 200);
      assert.deepEqual(file.json(), { repositoryId: "321", path: "src/a.ts", ref: "feature", size: 5, encoding: "utf-8", content: "hello" });
      assert.equal((await app.inject({ method: "GET", url: "/api/github/repositories/321/tree?path=..%2Fsecret", headers })).statusCode, 400);
      assert.equal((await app.inject({ method: "GET", url: "/api/github/repositories/321/file?path=binary", headers })).statusCode, 415);
      assert.equal((await app.inject({ method: "GET", url: "/api/github/repositories/321/file?path=large", headers })).statusCode, 413);
    } finally { await app.close(); }
  });

  it("uses repository IDs rather than client owner/name and hides cross-user or inaccessible repos", async () => {
    const mockApi = mock(() => Response.json([{ name: "empty", path: "empty", type: "dir" }]));
    const { app, session, add } = fixture(mockApi.fetchImpl); add("70", "u2");
    try {
      const headers = { cookie: `pocketcode_session=${session.token}` };
      const denied = await app.inject({ method: "GET", url: "/api/github/repositories/999/tree?owner=other&repo=private", headers });
      assert.equal(denied.statusCode, 404);
      assert.equal(mockApi.urls.some((url) => url.includes("/repos/")), false);
    } finally { await app.close(); }
  });

  it("handles missing refs, rate limits, timeouts, malformed content, and truncated trees with bounded subtree fallback", async () => {
    const missing = mock((url) => url.pathname.includes("/contents") ? Response.json({ message: "secret" }, { status: 404 }) : Response.json({ truncated: false, tree: [] }));
    const fixtureMissing = fixture(missing.fetchImpl); fixtureMissing.add("70");
    try {
      const response = await fixtureMissing.app.inject({ method: "GET", url: "/api/github/repositories/321/file?path=missing&ref=missing", headers: { cookie: `pocketcode_session=${fixtureMissing.session.token}` } });
      assert.equal(response.statusCode, 404);
    } finally { await fixtureMissing.app.close(); }

    const limited = mock(() => Response.json({}), { rateLimit: true });
    const fixtureLimited = fixture(limited.fetchImpl); fixtureLimited.add("70");
    try {
      const response = await fixtureLimited.app.inject({ method: "GET", url: "/api/github/repositories/321/tree", headers: { cookie: `pocketcode_session=${fixtureLimited.session.token}` } });
      assert.equal(response.statusCode, 429);
      assert.doesNotMatch(response.body, /private token leaked|ghs-secret/);
    } finally { await fixtureLimited.app.close(); }

    const timeout: typeof fetch = async (input) => {
      if (String(input).includes("/git/trees/")) throw new Error("timeout secret");
      return mock(() => Response.json([])).fetchImpl(input);
    };
    const fixtureTimeout = fixture(timeout); fixtureTimeout.add("70");
    try {
      const response = await fixtureTimeout.app.inject({ method: "GET", url: "/api/github/repositories/321/tree", headers: { cookie: `pocketcode_session=${fixtureTimeout.session.token}` } });
      assert.equal(response.statusCode, 503);
      assert.doesNotMatch(response.body, /timeout secret|ghs-secret/);
    } finally { await fixtureTimeout.app.close(); }

    const truncated = mock(() => Response.json({ truncated: true, tree: [] }), { truncated: true });
    const fixtureTree = fixture(truncated.fetchImpl); fixtureTree.add("70");
    try {
      const response = await fixtureTree.app.inject({ method: "GET", url: "/api/github/repositories/321/tree", headers: { cookie: `pocketcode_session=${fixtureTree.session.token}` } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().entries[0].path, "dir");
      assert.ok(truncated.urls.some((url) => url.endsWith("/git/trees/tree-sha")));
      assert.doesNotMatch(response.body, /ghs-secret|eyJ/);
    } finally { await fixtureTree.app.close(); }
  });
});
