import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/quickStart", () => ({ quickStart: { pick: () => undefined } }));
// The store read as a component would, without rendering one.
vi.mock("react", () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));

const { timerLog, useTimerLogQueue } = await import("./timerLog");

/** The queue as the app reads it. */
function useQueued() {
  return useTimerLogQueue().map(q => `${q.connectionId ?? "-"}:${q.issueKey}:${q.seconds}`);
}

describe("timerLog", () => {
  it("a newer stop of the same timer replaces its request", () => {
    timerLog.clear();
    timerLog.push({ issueKey: "DEMO-1", connectionId: 1, seconds: 60 });
    timerLog.push({ issueKey: "DEMO-1", connectionId: 1, seconds: 120 });
    expect(useQueued()).toEqual(["1:DEMO-1:120"]);
  });

  it("the same key's timer on another tracker is another timer: both are asked about", () => {
    timerLog.clear();
    timerLog.push({ issueKey: "DEMO-1", connectionId: 1, seconds: 60 });
    timerLog.push({ issueKey: "DEMO-1", connectionId: 2, seconds: 90 });
    expect(useQueued()).toEqual(["1:DEMO-1:60", "2:DEMO-1:90"]);
  });

  it("a hole or away time never drops a timer's request", () => {
    timerLog.clear();
    timerLog.push({ issueKey: "DEMO-1", connectionId: 1, seconds: 60 });
    timerLog.push({ issueKey: "DEMO-1", connectionId: 1, seconds: 300, fromTimer: false });
    expect(useQueued()).toEqual(["1:DEMO-1:60", "1:DEMO-1:300"]);
  });
});
