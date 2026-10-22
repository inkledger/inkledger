import { describe, expect, it } from "vitest";
import { normalizeError, ProviderError } from "./core/errors";
import { isRefusal } from "./trpc";

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
  });
});
