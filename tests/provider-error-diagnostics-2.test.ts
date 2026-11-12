import { describe, it, expect, vi } from "vitest";
import { extractProviderErrorDetails, isNetworkError, providerError, ProviderErrorDiagnostics, AgentError } from "../src/agents/agent-runtime.js";

describe("Provider Error Diagnostics - extractProviderErrorDetails (more)", () => {
  it("extracts retry-after from error.retryAfter", () => {
    const error = { retryAfter: "60" };
    const details = extractProviderErrorDetails(error);
    expect(details.retryAfterSeconds).toBe(60);
  });

  it("extracts retry-after from error.response.headers", () => {
    const error = { response: { headers: { "retry-after": "120" } } };
    const details = extractProviderErrorDetails(error);
    expect(details.retryAfterSeconds).toBe(120);
  });

  it("extracts request ID from error.requestId", () => {
    const error = { requestId: "req-abc123" };
    const details = extractProviderErrorDetails(error);
    expect(details.requestId).toBe("req-abc123");
  });

  it("extracts request ID from error.response.headers", () => {
    const error = { response: { headers: { "x-request-id": "req-xyz789" } } };
    const details = extractProviderErrorDetails(error);
    expect(details.requestId).toBe("req-xyz789");
  });

  it("traverses error.cause chain", () => {
    const rootCause = { statusCode: 503 };
    const error = { cause: rootCause };
    const details = extractProviderErrorDetails(error);
    expect(details.httpStatus).toBe(503);
  });

  it("handles string error", () => {
    const error = "network error";
    const details = extractProviderErrorDetails(error);
    expect(details.httpStatus).toBeUndefined();
  });

  it("handles null error", () => {
    const error = null;
    const details = extractProviderErrorDetails(error);
    expect(details.httpStatus).toBeUndefined();
  });
});

describe("isNetworkError", () => {
  it("detects ECONNREFUSED", () => {
    const error = { code: "ECONNREFUSED" };
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects ENOTFOUND", () => {
    const error = { code: "ENOTFOUND" };
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects ETIMEDOUT", () => {
    const error = { code: "ETIMEDOUT" };
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects ESOCKETTIMEDOUT", () => {
    const error = { code: "ESOCKETTIMEDOUT" };
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects ENETUNREACH", () => {
    const error = { code: "ENETUNREACH" };
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects EAI_AGAIN", () => {
    const error = { code: "EAI_AGAIN" };
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects UND_ERR_CONNECT_TIMEOUT", () => {
    const error = { code: "UND_ERR_CONNECT_TIMEOUT" };
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects FetchError with network message", () => {
    const error = { name: "FetchError", message: "fetch failed: network error" };
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects NetworkError", () => {
    const error = { name: "NetworkError", message: "connection refused" };
    expect(isNetworkError(error)).toBe(true);
  });

  it("detects TypeError with fetch failed", () => {
    const error = { name: "TypeError", message: "fetch failed" };
    expect(isNetworkError(error)).toBe(true);
  });

  it("returns false for non-network errors", () => {
    const error = { code: "OTHER_ERROR" };
    expect(isNetworkError(error)).toBe(false);
  });
});