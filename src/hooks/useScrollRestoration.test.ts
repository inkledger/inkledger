import { describe, expect, it, vi } from "vitest";

describe("remembering the scroll of history entries", () => {
  it("writes the tab's storage once when leaving, not on every scrolled frame", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem });
    const { scrollMemory } = await import("./useScrollRestoration");
    for (let y = 0; y < 50; y++) scrollMemory.remember("entry", { main: y, win: 0, els: {} });
    expect(setItem).not.toHaveBeenCalled();
    scrollMemory.flush();
    scrollMemory.flush();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(setItem.mock.calls[0][1] as string)).toEqual({ entry: { main: 49, win: 0, els: {} } });
    vi.unstubAllGlobals();
  });
});
