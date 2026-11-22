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
    workSchedule: { list: none, days: none },
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

describe("host hub: screensaver", () => {
  it("replays the current state to a scene mounted after activation", async () => {
    const { createHub } = await import("./host");
    const { screensaver } = await import("@/lib/flag");
    const hub = createHub(new QueryClient(), fakeUtils(() => []) as never);
    const { api, dispose } = hub.apiFor("test", "screensaver");
    const heard: unknown[] = [];
    try {
      screensaver.set(true);
      api.on("screensaver", d => heard.push(d));
      await Promise.resolve();
      expect(heard).toEqual([{ on: true }]);
      dispose();
      await Promise.resolve();
      expect(heard).toEqual([{ on: true }]);
    } finally {
      dispose();
      hub.dispose();
      screensaver.set(false);
    }
  });
});

describe("host hub: storage.update", () => {
  it("writes over what it read; when another tab wrote first, changes again on theirs (nothing lost)", async () => {
    const { createHub } = await import("./host");
    // The server: one key, a revision per write, the conditional write refused when behind.
    let saved: { value: unknown; revision: number } = { value: { closed: ["A"] }, revision: 1 };
    let sneak = true;
    const client = {
      modules: {
        storageGet: { query: async () => ({ ...saved }) },
        storageSetIf: {
          mutate: async ({ value, ifRevision }: { value: unknown; ifRevision: number }) => {
            // Another tab writes between this tab's read and its write, once.
            if (sneak) {
              sneak = false;
              saved = { value: { closed: ["A", "B"] }, revision: 2 };
            }
            if (ifRevision !== saved.revision) return { conflict: true as const, ...saved };
            saved = { value, revision: saved.revision + 1 };
            return { revision: saved.revision };
          },
        },
      },
    };
    const hub = createHub(new QueryClient(), { ...fakeUtils(() => []), client } as never);
    const { api, dispose } = hub.apiFor("test", "dashboard-widget");
    const add = (id: string) => (cur: { closed: string[] } | null) => ({ closed: [...new Set([...(cur?.closed ?? []), id])] });
    const out = await api.storage.update?.("state", add("C"));
    expect(out).toEqual({ closed: ["A", "B", "C"] });
    expect(saved).toEqual({ value: { closed: ["A", "B", "C"] }, revision: 3 });
    dispose();
    hub.dispose();
  });
});


describe("host hub: after a module stops", () => {
  // A listener or subscription added after dispose was never removed (dispose had already emptied what it owns).
  it("listens to nothing added after dispose", async () => {
    const { createHub } = await import("./host");
    const hub = createHub(new QueryClient(), fakeUtils(() => []) as never);
    const { api, dispose } = hub.apiFor("test", "dashboard-widget");
    dispose();
    const heard: unknown[] = [];
    api.on("focus-mode", d => heard.push(d));
    api.timer(v => heard.push(v));
    api.today(v => heard.push(v));
    api.theme(v => heard.push(v));
    hub.emit("focus-mode", { on: true });
    expect(heard).toEqual([]);
    hub.dispose();
  });

  // The final flush starts an update, then the module is disposed: it must still finish, or every later write in its chain hangs.
  it("an update already started finishes and resolves", async () => {
    const { createHub } = await import("./host");
    let answer: (v: { value: unknown; revision: number }) => void = () => {};
    const client = {
      modules: {
        storageGet: { query: () => new Promise<{ value: unknown; revision: number }>(r => (answer = r)) },
        storageSetIf: { mutate: async () => ({ revision: 2 }) },
      },
    };
    const hub = createHub(new QueryClient(), { ...fakeUtils(() => []), client } as never);
    const { api, dispose } = hub.apiFor("test", "dashboard-widget");
    const out = api.storage.update?.("state", (cur: number | null) => (cur ?? 0) + 1);
    dispose();
    answer({ value: 1, revision: 1 });
    const result = await Promise.race([out, new Promise(r => setTimeout(() => r("hung"), 50))]);
    expect(result).toBe(2);
    hub.dispose();
  });
});

describe("host hub: timer-started on the first data", () => {
  // The list arrived after the hub was made: every timer already running was told as just started.
  it("records the timers already running when the list first arrives, telling only later starts", async () => {
    const { createHub } = await import("./host");
    let timers: Timer[] | undefined;
    const qc = new QueryClient();
    const hub = createHub(qc, fakeUtils(() => timers as Timer[]) as never);
    const { api, dispose } = hub.apiFor("test", "dashboard-widget");
    const heard: unknown[] = [];
    api.on("timer-started", d => heard.push(d));
    timers = [{ issueKey: "DEMO-1", connectionId: 1, state: "running" }];
    qc.setQueryData(["tick"], 1);
    await new Promise(r => setTimeout(r, 0));
    expect(heard).toEqual([]);
    timers = [...timers, { issueKey: "DEMO-2", connectionId: 1, state: "running" }];
    qc.setQueryData(["tick"], 2);
    await new Promise(r => setTimeout(r, 0));
    expect(heard).toEqual([{ issueKey: "DEMO-2", ref: { connectionId: 1, key: "DEMO-2" } }]);
    dispose();
    hub.dispose();
  });
});

describe("host hub: cache notifications", () => {
  // Every cache event (a fetch starting, an observer coming) walked all issues again, though they had not changed.
  it("walks the issues only when their list changed, and still tells a move once", async () => {
    const { createHub } = await import("./host");
    let reads = 0;
    let status = "To Do";
    const issue = { connectionId: 1, key: "DEMO-1", category: "new", priority: "Medium", priorityRank: 2, get status() { reads++; return status; } };
    let issues = [issue];
    const qc = new QueryClient();
    const utils = { ...fakeUtils(() => []), issues: { all: { getData: () => issues, prefetch: async () => {}, invalidate: async () => {} } } };
    const hub = createHub(qc, utils as never);
    const { api, dispose } = hub.apiFor("test", "dashboard-widget");
    const moved: unknown[] = [];
    api.on("issue-moved", d => moved.push(d));
    const tick = async (n: number) => {
      qc.setQueryData(["tick"], n);
      await new Promise(r => setTimeout(r, 0));
    };
    const before = reads;
    for (let n = 1; n <= 3; n++) await tick(n);
    expect(reads).toBe(before);
    status = "Done";
    issues = [{ ...issue, status: "Done", category: "done" }];
    await tick(4);
    await tick(5);
    expect(moved).toEqual([{ issueKey: "DEMO-1", from: "To Do", to: "Done", ref: { connectionId: 1, key: "DEMO-1" } }]);
    dispose();
    hub.dispose();
  });
});

describe("host hub: theme", () => {
  it("carries the night's dimming the light set on the page", async () => {
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (k: string) => (k === "--sky-dim" ? " 0.42" : "0 0% 0%") }));
    const { createHub } = await import("./host");
    const hub = createHub(new QueryClient(), fakeUtils(() => []) as never);
    const { api, dispose } = hub.apiFor("test", "dashboard-widget");
    const heard: unknown[] = [];
    api.theme(v => heard.push(v));
    expect(heard[0]).toMatchObject({ skyDim: 0.42 });
    dispose();
    hub.dispose();
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "0 0% 0%" }));
  });
});
