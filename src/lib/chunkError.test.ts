import { describe, expect, it } from "vitest";
import { isChunkLoadError } from "./chunkError";

describe("a page's code that never arrived", () => {
  it("is told apart from a render error, in every browser's words", () => {
    for (const m of [
      "Failed to fetch dynamically imported module: https://x/assets/Reports-abc.js",
      "error loading dynamically imported module: https://x/assets/Reports-abc.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/Reports-abc.css",
    ])
      expect(isChunkLoadError(new TypeError(m)), m).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true);
    expect(isChunkLoadError(new TypeError("hosts.map is not a function"))).toBe(false);
    expect(isChunkLoadError("boom")).toBe(false);
  });
});
