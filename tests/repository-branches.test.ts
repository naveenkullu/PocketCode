import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { createSession } from "../src/auth/session-service.js";
import { openDatabase } from "../src/storage/database.js";
import { createServer, type GitHubAppConfig } from "../src/server/index.js";

const KEY = "0123456789abcdef".repeat(4);
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const githubApp: GitHubAppConfig = {
  clientId: "Iv1.test", clientSecret: "client-secret", slug: "test", appId: "12345",
  privateKey, callbackUrl: "http://localhost:3000/auth", tokenEncryptionKey: KEY,
};
const config = { port: 3000, host: "127.0.0.1", publicBaseUrl: "http://localhost:3000", githubApp };

function harness(options: { existingBranch?: string; createStatus?: number } = {}) {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO users (id, github_user_id, github_username) VALUES (?, ?, ?)")
    .run("user-a", "11", "alice");
  database.prepare("INSERT INTO users (id, github_user_id, github_username) VALUES (?, ?, ?)")
    .run("user-b", "22", "bob");
  const sessionA = createSession(database, "user-a");
  const sessionB = createSession(database, "user-b");
  const headers = (token: string) => {
    const sid = database.prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(token === sessionA.token ? "user-a" : "user-b") as { id: string };
    return {
      cookie: `pocketcode_session=${token}`,
      origin: config.publicBaseUrl,
      "x-csrf-token": createHmac("sha256", Buffer.from(KEY, "hex"))
        .update(`pocketcode-csrf:${sid.id}`).digest("base64url"),
    };
  };
  const associate = (userId: string, installationId: string) => {
    database.prepare(`INSERT INTO github_installations
      (id,user_id,installation_id,account_id,account_login,account_type,repository_selection,status)
      VALUES(?,?,?,?,?,'User','all','active')`)
      .run(`record-${installationId}`, userId, installationId, installationId, `owner-${installationId}`);
  };
  associate("user-a", "70");
  associate("user-b", "71");
  const branches = new Map<string, string>([["main", "a".repeat(40)]]);
  if (options.existingBranch) branches.set(options.existingBranch, "b".repeat(40));
  const calls: Array<{ method: string; path: string; body?: string; authorization?: string }> = [];
  let repositoryAccessible = true;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, path: url.pathname, body, authorization });
    if (url.pathname.startsWith("/app/installations/") && url.pathname.endsWith("/access_tokens")) {
      const id = url.pathname.match(/installations\/(\d+)\/access_tokens/)?.[1] ?? "unknown";
      return Response.json({ token: `ghs-test-${id}`, expires_at: new Date(Date.now() + 60_000).toISOString() });
    }
    if (url.pathname.startsWith("/app/installations/")) {
      const id = url.pathname.split("/").at(-1)!;
      return Response.json({
        id: Number(id), app_id: 12345, account: { id: Number(id), login: `owner-${id}`, type: "User" },
        repository_selection: "all", suspended_at: null,
      });
    }
    if (url.pathname === "/installation/repositories") {
      const installId = authorization.match(/ghs-test-(\d+)/)?.[1];
      return Response.json({
        repositories: repositoryAccessible && (installId === "70" || installId === "71")
          ? [{ id: 321, name: "demo", owner: { login: "octo" } }]
          : [],
      });
    }
    if (url.pathname === "/repos/octo/demo" && method === "GET") {
      return Response.json({ id: 321, name: "demo", owner: { login: "octo" }, default_branch: "main" });
    }
    if (url.pathname.startsWith("/repos/octo/demo/branches/") && method === "GET") {
      const ref = decodeURIComponent(url.pathname.slice("/repos/octo/demo/branches/".length));
      const sha = branches.get(ref);
      return sha ? Response.json({ commit: { sha } }) : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (url.pathname === "/repos/octo/demo/git/refs" && method === "POST") {
      if (options.createStatus) return Response.json({ message: "failed" }, { status: options.createStatus });
      const request = JSON.parse(body ?? "{}") as { ref: string; sha: string };
      const ref = request.ref.replace(/^refs\/heads\//, "");
      if (branches.has(ref)) return Response.json({ message: "already exists" }, { status: 422 });
      branches.set(ref, request.sha);
      return Response.json({ ref: request.ref, object: { sha: request.sha } }, { status: 201 });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  const app = createServer({ config, database, fetchImpl });
  const connectionUrl = "/api/repository-connections/321";
  const provision = (headers = headersForA) => app.inject({
    method: "POST", url: "/api/repository-connections", headers,
    payload: { repositoryId: "321", confirmed: true },
  });
  const headersForA = headers(sessionA.token);
  const headersForB = headers(sessionB.token);
  return {
    app, database, sessionA, sessionB, headersForA, headersForB, branches, calls, connectionUrl, provision,
    setRepositoryAccessible(value: boolean) { repositoryAccessible = value; },
  };
}

describe("persistent repository branches", () => {
  it("creates a confirmed per-user branch from the verified default branch SHA", async () => {
    const h = harness();
    try {
      const response = await h.provision();
      assert.equal(response.statusCode, 200, response.body);
      const branch = response.json().connection;
      assert.equal(branch.featureBranch, "pocketcode/user-11/demo");
      assert.equal(branch.defaultBranch, "main");
      assert.equal(branch.baseCommitSha, "a".repeat(40));
      assert.equal(branch.headCommitSha, "a".repeat(40));
      assert.equal(branch.status, "active");
      const creation = h.calls.find((call) => call.method === "POST" && call.path.endsWith("/git/refs"));
      assert.ok(creation);
      assert.deepEqual(JSON.parse(creation.body!), { ref: "refs/heads/pocketcode/user-11/demo", sha: "a".repeat(40) });
      assert.equal(h.branches.get("main"), "a".repeat(40));
      assert.match(creation.authorization ?? "", /^Bearer ghs-test-70$/);
      const tokenRequest = h.calls.find((call) => call.method === "POST" && call.path.endsWith("/access_tokens") && call.body?.includes('"contents":"write"'));
      assert.match(tokenRequest?.body ?? "", /"contents":"write"/);
      assert.doesNotMatch(response.body, /ghs-test/);
    } finally { await h.app.close(); }
  });

  it("reuses the existing connection and branch without creating another ref", async () => {
    const h = harness();
    try {
      const first = await h.provision();
      const second = await h.provision();
      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);
      assert.equal(second.json().connection.id, first.json().connection.id);
      assert.equal(h.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/refs")).length, 1);
      const restored = await h.app.inject({ method: "GET", url: h.connectionUrl, headers: h.headersForA });
      assert.equal(restored.json().connection.featureBranch, "pocketcode/user-11/demo");
    } finally { await h.app.close(); }
  });

  it("isolates branches for different PocketCode users sharing a repository", async () => {
    const h = harness();
    try {
      const first = await h.provision(h.headersForA);
      const second = await h.provision(h.headersForB);
      assert.equal(first.json().connection.featureBranch, "pocketcode/user-11/demo");
      assert.equal(second.json().connection.featureBranch, "pocketcode/user-22/demo");
      assert.notEqual(first.json().connection.id, second.json().connection.id);
    } finally { await h.app.close(); }
  });

  it("enforces one connection for each user and repository", async () => {
    const h = harness();
    try {
      await h.provision();
      const rows = h.database.prepare("SELECT count(*) AS count FROM repository_branches WHERE user_id='user-a' AND repository_id='321'")
        .get() as { count: number };
      assert.equal(rows.count, 1);
      assert.throws(() => h.database.prepare(`INSERT INTO repository_branches
        (id,user_id,repository_id,installation_id,owner_login,repository_name,default_branch,base_commit_sha,
         feature_branch,status,created_at,updated_at)
        VALUES('another','user-a','321','70','octo','demo','main',?,'pocketcode/duplicate','active',?,?)`)
        .run("c".repeat(40), new Date().toISOString(), new Date().toISOString()), /UNIQUE constraint failed/);
    } finally { await h.app.close(); }
  });

  it("never provisions the default branch and rejects an unrelated reserved-name collision", async () => {
    const h = harness({ existingBranch: "pocketcode/user-11/demo" });
    try {
      const response = await h.provision();
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { error: "branch_name_collision" });
      assert.equal(h.calls.some((call) => call.method === "POST" && call.path.endsWith("/git/refs")), false);
      assert.equal(h.database.prepare("SELECT count(*) AS count FROM repository_branches").get()?.count, 0);
    } finally { await h.app.close(); }
  });

  it("marks a deleted feature branch and never silently recreates it", async () => {
    const h = harness();
    try {
      await h.provision();
      h.branches.delete("pocketcode/user-11/demo");
      const checked = await h.app.inject({ method: "GET", url: h.connectionUrl, headers: h.headersForA });
      assert.equal(checked.json().connection.status, "branch_missing");
      const retry = await h.provision();
      assert.equal(retry.json().connection.status, "branch_missing");
      assert.equal(h.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/refs")).length, 1);
    } finally { await h.app.close(); }
  });

  it("marks repository access revocation without switching installations", async () => {
    const h = harness();
    try {
      await h.provision();
      h.setRepositoryAccessible(false);
      const response = await h.app.inject({ method: "GET", url: h.connectionUrl, headers: h.headersForA });
      assert.equal(response.json().connection.status, "access_lost");
      assert.equal(h.calls.some((call) => call.authorization === "Bearer ghs-test-71"), false);
    } finally { await h.app.close(); }
  });

  it("does not switch to a different installation when the saved installation is unavailable", async () => {
    const h = harness();
    try {
      await h.provision();
      h.database.prepare("UPDATE github_installations SET status='deleted' WHERE installation_id='70'").run();
      h.database.prepare(`INSERT INTO github_installations
        (id,user_id,installation_id,account_id,account_login,account_type,repository_selection,status)
        VALUES('record-72','user-a','72','72','owner-72','User','all','active')`).run();
      const before = h.calls.length;
      const response = await h.app.inject({ method: "GET", url: h.connectionUrl, headers: h.headersForA });
      assert.equal(response.json().connection.status, "access_lost");
      assert.equal(h.calls.slice(before).some((call) => call.authorization === "Bearer ghs-test-72"), false);
    } finally { await h.app.close(); }
  });

  it("serializes concurrent provisioning requests into one branch creation", async () => {
    const h = harness();
    try {
      const [first, second] = await Promise.all([h.provision(), h.provision()]);
      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);
      assert.equal(first.json().connection.id, second.json().connection.id);
      assert.equal(h.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/refs")).length, 1);
    } finally { await h.app.close(); }
  });

  it("safely reconciles a verified branch when final DB persistence initially fails", async () => {
    const h = harness();
    try {
      h.database.exec(`CREATE TRIGGER fail_branch_activation BEFORE UPDATE OF status ON repository_branches
        WHEN NEW.status = 'active' AND OLD.head_commit_sha IS NULL BEGIN SELECT RAISE(FAIL, 'simulated database failure'); END;`);
      const first = await h.provision();
      assert.equal(first.statusCode, 503);
      assert.deepEqual(first.json(), { error: "branch_persistence_failed" });
      assert.equal(h.branches.get("pocketcode/user-11/demo"), "a".repeat(40));
      const reserved = h.database.prepare("SELECT status,head_commit_sha FROM repository_branches WHERE user_id='user-a'")
        .get() as { status: string; head_commit_sha: string };
      assert.equal(reserved.status, "recovery_required");
      assert.equal(reserved.head_commit_sha, "a".repeat(40));
      const retry = await h.provision();
      assert.equal(retry.statusCode, 200);
      assert.equal(retry.json().connection.status, "active");
      assert.equal(h.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/refs")).length, 1);
    } finally { await h.app.close(); }
  });

  it("requires authentication and valid CSRF for provisioning", async () => {
    const h = harness();
    try {
      assert.equal((await h.app.inject({ method: "GET", url: h.connectionUrl })).statusCode, 401);
      assert.equal((await h.app.inject({
        method: "POST", url: "/api/repository-connections", payload: { repositoryId: "321", confirmed: true },
      })).statusCode, 401);
      const invalid = await h.app.inject({
        method: "POST", url: "/api/repository-connections",
        headers: { ...h.headersForA, "x-csrf-token": "invalid" },
        payload: { repositoryId: "321", confirmed: true },
      });
      assert.equal(invalid.statusCode, 403);
      assert.equal(h.calls.some((call) => call.method === "POST" && call.path.endsWith("/git/refs")), false);
    } finally { await h.app.close(); }
  });

  it("requires explicit repository confirmation before any branch operation", async () => {
    const h = harness();
    try {
      const response = await h.app.inject({
        method: "POST", url: "/api/repository-connections", headers: h.headersForA,
        payload: { repositoryId: "321", confirmed: false },
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: "repository_confirmation_required" });
      assert.equal(h.calls.some((call) => call.method === "POST" && call.path.endsWith("/git/refs")), false);
    } finally { await h.app.close(); }
  });

  it("does not publish workspace snapshots from an unassociated or caller-selected branch", async () => {
    const h = harness();
    try {
      const unconfirmed = await h.app.inject({
        method: "POST", url: "/api/workspaces", headers: h.headersForA,
        payload: { repositoryId: "321", branchRef: "main" },
      });
      assert.equal(unconfirmed.statusCode, 409);
      assert.deepEqual(unconfirmed.json(), { error: "connection_not_found" });
      await h.provision();
      const wrongBranch = await h.app.inject({
        method: "POST", url: "/api/workspaces", headers: h.headersForA,
        payload: { repositoryId: "321", branchRef: "main" },
      });
      assert.equal(wrongBranch.statusCode, 409);
      assert.deepEqual(wrongBranch.json(), { error: "repository_branch_mismatch" });
    } finally { await h.app.close(); }
  });
});
