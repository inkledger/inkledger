import { describe, expect, it } from "vitest";
import { focusTimer, runningTimers } from "./timerFocus";

const at = (m: number) => new Date(2026, 10, 3, 9, m);
const timer = (key: string, state: "running" | "paused", t: number) => ({
  key,
  state,
  runningSince: state === "running" ? at(t) : null,
  pausedAt: state === "paused" ? at(t) : null,
});

describe("timer focus", () => {
  it("the running ones, newest first; the focus is the one started last", () => {
    const timers = [timer("A", "running", 0), timer("P", "paused", 50), timer("B", "running", 30)];
    expect(runningTimers(timers).map(t => t.key)).toEqual(["B", "A"]);
    expect(focusTimer(timers)?.key).toBe("B");
  });

  it("none running: the one stopped last; none at all: nothing", () => {
    expect(focusTimer([timer("P", "paused", 10), timer("Q", "paused", 40)])?.key).toBe("Q");
    expect(focusTimer([])).toBeUndefined();
  });
});
