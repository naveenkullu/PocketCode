import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { createSession } from "../src/auth/session-service.js";
import { openDatabase } from "../src/storage/database.js";
import { createServer, type GitHubAppConfig, type ServerConfig } from "../src/server/index.js";

const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const githubApp: GitHubAppConfig = {
  clientId: "Iv1.test", clientSecret: "client-secret", slug: "test-app", appId: "12345",
  privateKey: appKey, callbackUrl: "http://localhost:3000/auth/github/callback",
  tokenEncryptionKey: "0123456789abcdef".repeat(4),
};
const config: ServerConfig = { port: 3000, host: "127.0.0.1", publicBaseUrl: "http://localhost:3000", githubApp };

function setup(
  fetchImpl: typeof fetch = async () => { throw new Error("unexpected GitHub request"); },
  serverConfig: ServerConfig = config,
) {
  const database = openDatabase(":memory:");
  database.prepare("INSERT INTO users (id, github_user_id, github_username) VALUES (?, ?, ?)").run("user-a", "11", "alice");
  database.prepare("INSERT INTO users (id, github_user_id, github_username) VALUES (?, ?, ?)").run("user-b", "22", "bob");
  const session = createSession(database, "user-a");
  const associate = (id: string, userId: string, selection: "all" | "selected" = "selected", status = "active") => {
    database.prepare(`INSERT INTO github_installations
      (id, user_id, installation_id, account_id, account_login, account_type, repository_selection, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`record-${id}`, userId, id, "11", `owner-${id}`, "User", selection, status);
  };
  return { app: createServer({ config: serverConfig, database, fetchImpl }), database, session, associate };
}

function repository(id: number, name: string, permissions = { pull: true, push: false }) {
  return { id, name, full_name: `owner/${name}`, owner: { login: "owner" }, private: true,
    default_branch: "main", html_url: `https://github.com/owner/${name}`, permissions };
}

function mockedGitHub(repositoriesByInstallation: Record<string, unknown[]>, options: { installationStatus?: number; tokenStatus?: number; listStatus?: number } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes("/app/installations/") && url.endsWith("/access_tokens")) {
      if (options.tokenStatus) return Response.json({ message: "sensitive failure body" }, { status: options.tokenStatus });
      const id = url.match(/installations\/(\d+)\/access_tokens/)?.[1] ?? "unknown";
      return Response.json({ token: `ghs-secret-installation-token-${id}`, expires_at: new Date(Date.now() + 60_000).toISOString() });
    }
    if (url.includes("/app/installations/")) {
      if (options.installationStatus) return Response.json({}, { status: options.installationStatus });
      const id = url.split("/").at(-1)!;
      return Response.json({ id: Number(id), app_id: 12345, account: { id: 11, login: `owner-${id}`, type: "User" }, repository_selection: "selected", suspended_at: null });
    }
    if (url.includes("/installation/repositories")) {
      if (options.listStatus) return Response.json({ message: "sensitive failure body" }, { status: options.listStatus });
      const query = new URL(url).searchParams;
      const page = Number(query.get("page"));
      const auth = (init?.headers as Record<string, string>).Authorization;
      const installId = auth?.match(/ghs-secret-installation-token-(\d+)/)?.[1] ?? "unknown";
      return Response.json({ repositories: repositoriesByInstallation[installId]?.[page - 1] ?? [] });
    }
    throw new Error("unexpected URL");
  };
  return { fetchImpl, calls };
}

describe("GitHub repository listing API", () => {
  it("requires a valid PocketCode session", async () => {
    const { app } = setup();
    try {
      assert.equal((await app.inject({ method: "GET", url: "/api/github/repositories" })).statusCode, 401);
    } finally { await app.close(); }
  });

  it("reports when the authenticated user has no active installation association", async () => {
    const { app, session } = setup();
    try {
      const response = await app.inject({ method: "GET", url: "/api/github/repositories", headers: { cookie: `pocketcode_session=${session.token}` } });
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { error: "github_installation_required" });
    } finally { await app.close(); }
  });

  it("reports missing GitHub App configuration without exposing configuration values", async () => {
    const incompleteConfig: ServerConfig = {
      ...config,
      githubApp: {
        clientId: githubApp.clientId,
        clientSecret: githubApp.clientSecret,
        callbackUrl: githubApp.callbackUrl,
        tokenEncryptionKey: githubApp.tokenEncryptionKey,
      },
    };
    const { app, session } = setup(undefined, incompleteConfig);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/github/repositories",
        headers: { cookie: `pocketcode_session=${session.token}` },
      });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: "github_app_configuration_missing" });
      assert.doesNotMatch(response.body, /client-secret|BEGIN PRIVATE KEY|0123456789/);
    } finally { await app.close(); }
  });

  it("lists repositories from all/selected and multiple owned installations with pagination and deduplication", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => repository(index + 1, `repo-${index + 1}`));
    const secondPage = [repository(101, "repo-101"), repository(1, "repo-1", { pull: true, push: true })];
    const mock = mockedGitHub({ 501: [firstPage, secondPage], 502: [[repository(102, "repo-102", { pull: true, push: true })]] });
    const { app, session, associate } = setup(mock.fetchImpl);
    associate("501", "user-a", "all");
    associate("502", "user-a", "selected");
    associate("503", "user-b", "all");
    try {
      const response = await app.inject({ method: "GET", url: "/api/github/repositories", headers: { cookie: `pocketcode_session=${session.token}` } });
      assert.equal(response.statusCode, 200);
      const body = response.json() as { repositories: Array<Record<string, unknown>> };
      assert.equal(body.repositories.length, 102);
      assert.deepEqual(body.repositories.find((item) => item.id === "1")?.permissions, { read: true, write: true });
      assert.equal(body.repositories.find((item) => item.id === "1")?.installationId, "501");
      assert.deepEqual(body.repositories.find((item) => item.id === "2"), {
        id: "2", name: "repo-2", fullName: "owner/repo-2", ownerLogin: "owner", private: true,
        defaultBranch: "main", htmlUrl: "https://github.com/owner/repo-2", installationId: "501",
        permissions: { read: true, write: false },
      });
      assert.equal(mock.calls.some((call) => call.url.includes("page=2")), true);
      assert.equal(mock.calls.some((call) => call.url.includes("/installations/503")), false);
      assert.equal(JSON.stringify(body).includes("ghs-secret"), false);
      const tokenCalls = mock.calls.filter((call) => call.url.endsWith("/access_tokens"));
      assert.equal(tokenCalls.length, 2);
      assert.match(String(tokenCalls[0].init?.body), /"metadata":"read"/);
      assert.match(String(tokenCalls[0].init?.body), /"contents":"read"/);
      assert.equal(mock.calls.some((call) => call.url.includes("/installation/repositories") && (call.init?.headers as Record<string, string>).Authorization === "Bearer ghs-secret-installation-token-501"), true);
    } finally { await app.close(); }
  });

  it("does not return inactive, removed, or other users' installations", async () => {
    const mock = mockedGitHub({ 601: [[repository(1, "ok")]] });
    const { app, session, associate } = setup(mock.fetchImpl);
    associate("601", "user-a"); associate("602", "user-a", "all", "suspended"); associate("603", "user-b");
    try {
      const response = await app.inject({ method: "GET", url: "/api/github/repositories?installation_id=603", headers: { cookie: `pocketcode_session=${session.token}` } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().repositories.map((item: { id: string }) => item.id), ["1"]);
      assert.equal(mock.calls.some((call) => call.url.includes("/installations/602") || call.url.includes("/installations/603")), false);
    } finally { await app.close(); }
  });

  it("returns safe errors for invalid tokens, rate limits, removed installations, and malformed responses", async () => {
    const cases = [
      { options: { tokenStatus: 401 }, status: 503, error: "github_repositories_unavailable" },
      { options: { listStatus: 429 }, status: 429, error: "github_rate_limited" },
      { options: { listStatus: 403 }, status: 403, error: "github_insufficient_permissions" },
      { options: { installationStatus: 404 }, status: 409, error: "github_installation_unavailable" },
    ];
    for (const testCase of cases) {
      const mock = mockedGitHub({}, testCase.options);
      const { app, session, associate } = setup(mock.fetchImpl); associate("701", "user-a");
      try {
        const response = await app.inject({ method: "GET", url: "/api/github/repositories", headers: { cookie: `pocketcode_session=${session.token}` } });
        assert.equal(response.statusCode, testCase.status);
        assert.deepEqual(response.json(), { error: testCase.error });
        assert.doesNotMatch(response.body, /sensitive failure body|ghs-secret|BEGIN PRIVATE KEY|eyJ/);
      } finally { await app.close(); }
    }
    const malformed: typeof fetch = async () => Response.json({ repositories: [{ id: "bad" }] });
    const { app, session, associate } = setup(malformed); associate("702", "user-a");
    try {
      const response = await app.inject({ method: "GET", url: "/api/github/repositories", headers: { cookie: `pocketcode_session=${session.token}` } });
      assert.equal(response.statusCode, 502);
      assert.deepEqual(response.json(), { error: "github_invalid_response" });
    } finally { await app.close(); }
  });

  it("classifies insufficient GitHub App permissions at token and repository listing stages", async () => {
    for (const mockOptions of [
      { installationStatus: 403 },
      { tokenStatus: 403 },
      { listStatus: 403 },
    ]) {
      const mock = mockedGitHub({}, mockOptions);
      const { app, session, associate } = setup(mock.fetchImpl);
      associate("704", "user-a");
      try {
        const response = await app.inject({
          method: "GET",
          url: "/api/github/repositories",
          headers: { cookie: `pocketcode_session=${session.token}` },
        });
        assert.equal(response.statusCode, 403);
        assert.deepEqual(response.json(), { error: "github_insufficient_permissions" });
        assert.doesNotMatch(response.body, /sensitive failure body|ghs-secret|BEGIN PRIVATE KEY|eyJ/);
      } finally { await app.close(); }
    }
  });

  it("returns safe errors on upstream timeouts", async () => {
    const mock = mockedGitHub({});
    const timeoutFetch: typeof fetch = async (input, init) => {
      if (String(input).includes("/installation/repositories")) throw new Error("timed out with secret token");
      return mock.fetchImpl(input, init);
    };
    const { app, session, associate } = setup(timeoutFetch); associate("703", "user-a");
    try {
      const response = await app.inject({ method: "GET", url: "/api/github/repositories", headers: { cookie: `pocketcode_session=${session.token}` } });
      assert.equal(response.statusCode, 503);
      assert.doesNotMatch(response.body, /secret token|ghs-secret/);
    } finally { await app.close(); }
  });
});