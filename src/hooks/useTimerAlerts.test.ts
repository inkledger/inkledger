import { describe, expect, it } from "vitest";
import { dueTimerAlerts } from "./useTimerAlerts";

const timer = (connectionId: number, state: "running" | "paused", elapsedSeconds = 7200) => ({ issueKey: "APP-1", connectionId, state, elapsedSeconds });

describe("forgotten-timer alerts", () => {
  it("alerts once per timer, the same key on two trackers counted apart", () => {
    const alerted = new Set<string>();
    // One paused, one running: the paused one must not reset the running one's alert.
    const list = [timer(1, "running"), timer(2, "paused")];
    expect(dueTimerAlerts(list, alerted, 0, 3600)).toHaveLength(1);
    expect(dueTimerAlerts(list, alerted, 30, 3600)).toHaveLength(0);
  });

  it("both alert when both run", () => {
    const due = dueTimerAlerts([timer(1, "running"), timer(2, "running")], new Set(), 0, 3600);
    expect(due.map(d => d.timer.connectionId)).toEqual([1, 2]);
  });

  it("alerts again after the timer was stopped and restarted", () => {
    const alerted = new Set<string>();
    dueTimerAlerts([timer(1, "running")], alerted, 0, 3600);
    dueTimerAlerts([], alerted, 0, 3600);
    expect(dueTimerAlerts([timer(1, "running")], alerted, 0, 3600)).toHaveLength(1);
  });
});
