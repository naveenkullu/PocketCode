import assert from "node:assert/strict";
import { describe, it } from "node:test";
import viteConfig from "../frontend/vite.config.ts";

describe("Vite API proxy routes", () => {
  const rewrite = viteConfig.server?.proxy && typeof viteConfig.server.proxy === "object"
    ? viteConfig.server.proxy["/api"]?.rewrite
    : undefined;

  it("preserves backend BYOK route prefixes while retaining existing API rewrites", () => {
    assert.equal(typeof rewrite, "function");
    assert.equal(rewrite!("/api/ai/providers"), "/api/ai/providers");
    assert.equal(rewrite!("/api/ai/configuration"), "/api/ai/configuration");
    assert.equal(rewrite!("/api/ai/credentials/groq"), "/api/ai/credentials/groq");
    assert.equal(rewrite!("/api/auth/me"), "/auth/me");
    assert.equal(rewrite!("/api/health"), "/health");
  });
});
