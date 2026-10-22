import { describe, expect, it, vi } from "vitest";
import { normalizeError, ProviderError } from "./core/errors";
import { isRefusal, providerTrpcError } from "./trpc";

describe("isRefusal", () => {
  it("a tracker's own no: said on purpose, its HTTP answer, the read-only guard", () => {
    expect(isRefusal(new ProviderError("invalid", "GitLab: is invalid"))).toBe(true);
    const http = Object.assign(new Error("Jira refuses this delete"), { status: 400 });
    expect(isRefusal(normalizeError(http))).toBe(true);
    const guard = Object.assign(new Error("This server is read-only"), { providerKind: "readOnly" });
    expect(isRefusal(normalizeError(guard))).toBe(true);
  });

  it("a fault wrapped on its way is not one: a bug, no answer, an unknown error, a broken contract", () => {
    expect(isRefusal(normalizeError(new TypeError("Cannot read properties of undefined (reading 'x')")))).toBe(false);
    expect(isRefusal(normalizeError(new TypeError("fetch failed")))).toBe(false);
    expect(isRefusal(normalizeError(new Error("something odd")))).toBe(false);
    expect(isRefusal(normalizeError(new DOMException("timed out", "TimeoutError")))).toBe(false);
    expect(isRefusal(new ProviderError("incompatible", "Unexpected answer"))).toBe(false);
    expect(isRefusal(normalizeError(Object.assign(new Error("Bad Gateway"), { status: 502 })))).toBe(false);
    expect(isRefusal(new ProviderError("unavailable", "GitLab answered 503", { status: 503 }))).toBe(false);
  });

  it("answered as such: a refusal in its words, no answer in the user's, any other fault in general words", () => {
    const quiet = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
    try {
      expect(providerTrpcError(new ProviderError("invalid", "GitLab: is invalid"))).toMatchObject({ code: "BAD_REQUEST", message: "GitLab: is invalid" });
      const gateway = providerTrpcError(new ProviderError("unavailable", "GitLab answered 502", { status: 502 }));
      expect(gateway.code).toBe("SERVICE_UNAVAILABLE");
      expect(gateway.message).not.toMatch(/502/);
      const down = providerTrpcError(normalizeError(new TypeError("fetch failed")));
      expect(down.code).toBe("SERVICE_UNAVAILABLE");
      expect(down.message).not.toMatch(/fetch failed/);
      const slow = providerTrpcError(normalizeError(new DOMException("timed out", "TimeoutError")));
      expect(slow.code).toBe("TIMEOUT");
      expect(slow.message).not.toMatch(/No answer in time/);
      const bug = providerTrpcError(normalizeError(new TypeError("Cannot read properties of undefined (reading 'x')")));
      expect(bug.code).toBe("INTERNAL_SERVER_ERROR");
      expect(bug.message).not.toMatch(/Cannot read/);
    } finally {
      quiet.forEach(q => q.mockRestore());
    }
  });
});
