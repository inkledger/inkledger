import { describe, expect, it, vi } from "vitest";
import { normalizeError, ProviderError } from "./core/errors";
import { certainRefusal, isRefusal, providerTrpcError } from "./trpc";

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

  it("a refusal with no words of the tracker's own reads as its kind, in the user's words", () => {
    const busy = providerTrpcError(new ProviderError("rateLimit", "GitHub answered 429", { status: 429 }));
    expect(busy.code).toBe("TOO_MANY_REQUESTS");
    expect(busy.message).not.toMatch(/answered/);
    expect(providerTrpcError(new ProviderError("invalid", "Linear: answered 400", { status: 400 })).message).not.toMatch(/answered/);
    expect(providerTrpcError(new ProviderError("notFound", "answered 404", { status: 404 })).message).not.toMatch(/answered/);
    // The tracker's own words stay as they are.
    expect(providerTrpcError(new ProviderError("invalid", "GitLab: title is too long", { status: 400 })).message).toBe("GitLab: title is too long");
  });
});

describe("a timeout is no answer, not a cancel", () => {
  it("a deadline that aborts the call's signal (AbortSignal.timeout) is a timeout; the caller's own abort is a cancel", async () => {
    const deadline = AbortSignal.timeout(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(deadline.aborted).toBe(true);
    // fetch rejects with the signal's reason, and the adapter's own wrapping may hide its name.
    expect(normalizeError(deadline.reason, deadline).kind).toBe("timeout");
    expect(normalizeError(new Error("This operation was aborted"), deadline).kind).toBe("timeout");
    const c = new AbortController();
    c.abort();
    expect(normalizeError(c.signal.reason, c.signal).kind).toBe("cancelled");
    expect(normalizeError(new Error("aborted"), c.signal).kind).toBe("cancelled");
  });
});

describe("certainRefusal: what a write may drop", () => {
  it("only the service's own no, or one before the call left", () => {
    expect(certainRefusal(new ProviderError("invalid", "GitLab: is invalid"))).toBe(true);
    expect(certainRefusal(normalizeError(Object.assign(new Error("no"), { status: 400 })))).toBe(true);
    expect(certainRefusal(normalizeError(Object.assign(new Error("ro"), { providerKind: "readOnly" })))).toBe(true);
  });

  it("never what may have landed: no answer, a cancel, an odd answer, a fault of ours, a server error", () => {
    expect(certainRefusal(normalizeError(new DOMException("t", "TimeoutError")))).toBe(false);
    expect(certainRefusal(new ProviderError("cancelled", "Cancelled"))).toBe(false);
    expect(certainRefusal(new ProviderError("incompatible", "odd"))).toBe(false);
    expect(certainRefusal(normalizeError(new TypeError("Cannot read properties of undefined (reading 'id')")))).toBe(false);
    expect(certainRefusal(normalizeError(Object.assign(new Error("Bad Gateway"), { status: 502 })))).toBe(false);
    expect(certainRefusal(new Error("disk full"))).toBe(false);
  });
});
