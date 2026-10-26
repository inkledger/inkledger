import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

// The hub reads the theme from the page: the little of a DOM it touches.
beforeAll(() => {
  vi.stubGlobal("document", { documentElement: { classList: { contains: () => false } }, querySelector: () => null });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "0 0% 0%" }));
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
});
afterAll(() => vi.unstubAllGlobals());

type Timer = { issueKey: string; connectionId: number | null; state: "running" | "paused" };

/** Only what the hub reads: the timers list, everything else not loaded yet. */
function fakeUtils(timers: () => Timer[]) {
  const none = { getData: () => undefined, prefetch: async () => {}, invalidate: async () => {} };
  return {
    timers: { list: { ...none, getData: timers } },
    issues: { all: none },
    stats: { dashboard: none },
    settings: { get: none },
    workSchedule: { list: none },
  };
}

describe("host hub: timer-started", () => {
  it("tells a timer on the same key in another tracker apart (identity is connection + key)", async () => {
    const { createHub } = await import("./host");
    let timers: Timer[] = [{ issueKey: "DEMO-1", connectionId: 1, state: "running" }];
    const qc = new QueryClient();
    const hub = createHub(qc, fakeUtils(() => timers) as never);
    const { api, dispose } = hub.apiFor("test", "dashboard-widget");
    const heard: unknown[] = [];
    api.on("timer-started", d => heard.push(d));
    // DEMO-1 of tracker 2 starts (tracker 1's stops): a new timer.
    timers = [{ issueKey: "DEMO-1", connectionId: 2, state: "running" }];
    qc.setQueryData(["tick"], 1);
    await new Promise(r => setTimeout(r, 0));
    expect(heard).toEqual([{ issueKey: "DEMO-1", ref: { connectionId: 2, key: "DEMO-1" } }]);
    dispose();
    hub.dispose();
  });
});

describe("host hub: a stopped or failing module never breaks the page", () => {
  it("an async callback that rejects is caught (no unhandled rejection), reads after a stop never answer with made-up data", async () => {
    const { createHub } = await import("./host");
    const qc = new QueryClient();
    const fetched: string[] = [];
    const utils = {
      ...fakeUtils(() => []),
      modules: {
        totals: { fetch: async () => (fetched.push("totals"), { today: 1 }) },
        historyDaily: { fetch: async () => (fetched.push("history"), []) },
        weather: { fetch: async () => (fetched.push("weather"), null) },
        geocode: { fetch: async () => (fetched.push("geocode"), []) },
      },
    };
    const hub = createHub(qc, utils as never);
    const { api, dispose } = hub.apiFor("test", "dashboard-widget");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    api.on("focus-mode", (async () => {
      throw new Error("boom");
    }));
    hub.emit("focus-mode", { on: true });
    await new Promise(r => setTimeout(r, 10));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    dispose();
    let settled = false;
    for (const p of [api.totals(), api.history?.daily() ?? Promise.resolve(), api.weather({ lat: 0, lon: 0 }), api.geocode("x")]) void p.then(() => (settled = true), () => (settled = true));
    await new Promise(r => setTimeout(r, 10));
    expect(fetched).toEqual([]);
    expect(settled).toBe(false);
    hub.dispose();
  });
});
