import { describe, it, expect } from "vitest";
import { providerError, AgentError } from "../src/agents/agent-runtime.js";

describe("providerError mapping", () => {
  it("maps 400 to provider_bad_request", () => {
    const error = { statusCode: 400 };
    const agentError = providerError(error);
    expect(agentError.code).toBe("provider_bad_request");
    expect(agentError.statusCode).toBe(400);
    expect(agentError.diagnostics?.httpStatus).toBe(400);
  });

  it("maps 401 to provider_auth_error", () => {
    const error = { statusCode: 401 };
    const agentError = providerError(error);
    expect(agentError.code).toBe("provider_auth_error");
    expect(agentError.statusCode).toBe(401);
  });

  it("maps 403 to provider_auth_error", () => {
    const error = { statusCode: 403 };
    const agentError = providerError(error);
    expect(agentError.code).toBe("provider_auth_error");
    expect(agentError.statusCode).toBe(401);
  });

  it("maps 413 to provider_payload_too_large", () => {
    const error = { statusCode: 413 };
    const agentError = providerError(error);
    expect(agentError.code).toBe("provider_payload_too_large");
    expect(agentError.statusCode).toBe(413);
  });

  it("maps 429 to provider_rate_limited", () => {
    const error = { statusCode: 429 };
    const agentError = providerError(error);
    expect(agentError.code).toBe("provider_rate_limited");
    expect(agentError.statusCode).toBe(429);
  });

  it("maps 500 to provider_unavailable", () => {
    const error = { statusCode: 500 };
    const agentError = providerError(error);
    expect(agentError.code).toBe("provider_unavailable");
    expect(agentError.statusCode).toBe(503);
  });

  it("maps 502 to provider_unavailable", () => {
    const error = { statusCode: 502 };
    const agentError = providerError(error);
    expect(agentError.code).toBe("provider_unavailable");
    expect(agentError.statusCode).toBe(503);
  });

  it("maps 503 to provider_unavailable", () => {
    const error = { statusCode: 503 };
    const agentError = providerError(error);
    expect(agentError.code).toBe("provider_unavailable");
    expect(agentError.statusCode).toBe(503);
  });

  it("maps 404 to provider_bad_request", () => {
    const error = { statusCode: 404 };
    const agentError = providerError(error);
    expect(agentError.code).toBe("provider_bad_request");
    expect(agentError.statusCode).toBe(404);
  });

  it("maps network errors to provider_connection_error", () => {
    const error = { code: "ECONNREFUSED" };
    const agentError = providerError(error);
    expect(agentError.code).toBe("provider_connection_error");
    expect(agentError.statusCode).toBe(502);
  });

  it("maps timeout to provider_timeout", () => {
    const error = { name: "TimeoutError" };
    const agentError = providerError(error);
    expect(agentError.code).toBe("provider_timeout");
    expect(agentError.statusCode).toBe(504);
  });

  it("falls back to provider_error for unknown errors", () => {
    const error = new Error("unknown error");
    const agentError = providerError(error);
    expect(agentError.code).toBe("provider_error");
    expect(agentError.statusCode).toBe(502);
  });

  it("preserves diagnostics in AgentError", () => {
    const error = { statusCode: 429, code: "RATE_LIMIT", type: "RateLimitError", message: "Too many requests", retryAfter: "60", requestId: "req-123" };
    const agentError = providerError(error);
    expect(agentError.diagnostics).toEqual({
      httpStatus: 429,
      providerErrorCode: "RATE_LIMIT",
      providerErrorType: "RateLimitError",
      sanitizedMessage: "Too many requests",
      retryAfterSeconds: 60,
      requestId: "req-123",
    });
  });
});

describe("AgentError with diagnostics", () => {
  it("includes diagnostics in error", () => {
    const error = new AgentError("test_code", 500, { httpStatus: 500, providerErrorCode: "TEST" });
    expect(error.diagnostics).toEqual({ httpStatus: 500, providerErrorCode: "TEST" });
  });

  it("has correct name", () => {
    const error = new AgentError("test_code", 500);
    expect(error.name).toBe("AgentError");
  });
});