import { describe, expect, it } from "vitest";
import { eventsOf, onAppEvent } from "./appEvents";

describe("what a confirmed mutation tells the modules (WP-17)", () => {
  const heard = (path: string, input: unknown, output: unknown) => {
    const got: unknown[] = [];
    const off = onAppEvent((event, detail) => got.push([event, detail]));
    eventsOf(path, input, output);
    off();
    return got;
  };
  it("a log is a log (never of 0 s); an edit or a delete says how the time moved; a stop its seconds", () => {
    expect(heard("worklogs.create", {}, { issueKey: "APP-1", connectionId: 2, timeSpentSeconds: 1800 })).toEqual([["worklog-logged", { seconds: 1800, ref: { connectionId: 2, key: "APP-1" } }]]);
    expect(heard("worklogs.create", {}, { issueKey: "APP-1", connectionId: 2, timeSpentSeconds: 0 })).toEqual([]);
    expect(heard("worklogs.update", {}, { issueKey: "APP-1", connectionId: 2, timeSpentSeconds: 2400, previousSeconds: 1800 })).toEqual([["worklog-changed", { seconds: 600, ref: { connectionId: 2, key: "APP-1" } }]]);
    expect(heard("worklogs.delete", { id: 7 }, { ok: true, seconds: 2400, issueKey: "APP-1", connectionId: 2 })).toEqual([["worklog-changed", { seconds: -2400, ref: { connectionId: 2, key: "APP-1" } }]]);
    expect(heard("timers.stop", { issueKey: "APP-1", connectionId: 2 }, { found: true, seconds: 900 })).toEqual([["timer-stopped", { issueKey: "APP-1", seconds: 900, ref: { connectionId: 2, key: "APP-1" } }]]);
    expect(heard("timers.stop", { issueKey: "APP-1" }, { found: false, seconds: 0 })).toEqual([]);
    expect(heard("issues.watch", {}, { ok: true })).toEqual([]);
  });
});
