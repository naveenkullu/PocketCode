import { describe, it, expect, vi } from "vitest";
import { extractProviderErrorDetails, isNetworkError, providerError, ProviderErrorDiagnostics, AgentError } from "../src/agents/agent-runtime.js";

describe("Provider Error Diagnostics", () => {
  describe("extractProviderErrorDetails", () => {
    it("extracts HTTP status from error.statusCode", () => {
      const error = { statusCode: 429 };
      const details = extractProviderErrorDetails(error);
      expect(details.httpStatus).toBe(429);
    });

    it("extracts HTTP status from error.status", () => {
      const error = { status: 500 };
      const details = extractProviderErrorDetails(error);
      expect(details.httpStatus).toBe(500);
    });

    it("extracts HTTP status from error.response.status", () => {
      const error = { response: { status: 413 } };
      const details = extractProviderErrorDetails(error);
      expect(details.httpStatus).toBe(413);
    });

    it("extracts provider error code", () => {
      const error = { code: "TOKEN_LIMIT_EXCEEDED" };
      const details = extractProviderErrorDetails(error);
      expect(details.providerErrorCode).toBe("TOKEN_LIMIT_EXCEEDED");
    });

    it("extracts provider error type", () => {
      const error = { type: "RateLimitError" };
      const details = extractProviderErrorDetails(error);
      expect(details.providerErrorType).toBe("RateLimitError");
    });

    it("sanitizes message and redacts API keys", () => {
      const error = { message: "Invalid API key: sk-abcdefghijklmnopqrstuvwxyz123456" };
      const details = extractProviderErrorDetails(error);
      expect(details.sanitizedMessage).toContain("[REDACTED_API_KEY]");
      expect(details.sanitizedMessage).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    });

    it("sanitizes message and redacts GitHub tokens", () => {
      const error = { message: "Token ghp_abcdefghijklmnopqrstuvwxyz123456 invalid" };
      const details = extractProviderErrorDetails(error);
      expect(details.sanitizedMessage).toContain("[REDACTED_GITHUB_TOKEN]");
      expect(details.sanitizedMessage).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    });

    it("sanitizes Bearer tokens", () => {
      const error = { message: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" };
      const details = extractProviderErrorDetails(error);
      expect(details.sanitizedMessage).toContain("Bearer [REDACTED]");
      expect(details.sanitizedMessage).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    });

    it("sanitizes Authorization header", () => {
      const error = { message: 'Authorization: Basic dXNlcjpwYXNz' };
      const details = extractProviderErrorDetails(error);
      expect(details.sanitizedMessage).toContain("Authorization: [REDACTED]");
    });
  });
});