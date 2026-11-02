import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "./randomId";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUUID", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the browser's own when the page is secure", () => {
    expect(randomUUID()).toMatch(UUID_V4);
  });

  it("still makes a v4 UUID on a plain http page, where crypto.randomUUID is missing", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: <T extends Uint8Array>(a: T) => real.getRandomValues(a) });
    const ids = new Set(Array.from({ length: 50 }, () => randomUUID()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});
