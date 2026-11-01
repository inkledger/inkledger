import { describe, expect, it } from "vitest";
import { hashActivationToken, newActivationToken } from "./lease";

describe("activation token adapter", () => {
  it("uses 256-bit random tokens and persists only a full SHA-256 hash", () => {
    const first = newActivationToken();
    const second = newActivationToken();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashActivationToken(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashActivationToken(first)).not.toBe(first);
    expect(hashActivationToken(first)).toBe(hashActivationToken(first));
  });
});
