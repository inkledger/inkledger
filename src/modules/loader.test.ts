import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleListEntry } from "@contracts/modules";
import { loadModules } from "./loader";

const entry = { id: "demo", entryUrl: "/modules/demo/entry.js", integrity: "sha384-x", status: { state: "active" } } as unknown as ModuleListEntry;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loading a module's code", () => {
  it("tries again on the next load after a failed fetch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi.fn(() => Promise.reject(new Error("offline")));
    vi.stubGlobal("fetch", fetch);
    expect(await loadModules([entry])).toEqual([]);
    expect(await loadModules([entry])).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
