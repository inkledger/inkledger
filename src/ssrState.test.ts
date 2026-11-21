import { afterEach, describe, expect, it, vi } from "vitest";
import { readSSRState } from "./ssrState";

describe("readSSRState", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a state that doesn't read gives none (the app fetches its data) instead of stopping the start", () => {
    const removed = vi.fn();
    vi.stubGlobal("document", { getElementById: () => ({ textContent: '{"state": broken', remove: removed }) });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readSSRState()).toBeNull();
    expect(removed).toHaveBeenCalled();
  });
});
