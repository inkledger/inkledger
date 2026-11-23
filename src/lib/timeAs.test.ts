import { describe, expect, it } from "vitest";
import { secondsToEnd, settleTimeAs, switchTimeAs } from "./timeAs";

const START = "2026-11-23T10:00";

describe("time as a duration or an end time", () => {
  it("by end, the time is from the start to the end; none until both are there", () => {
    expect(secondsToEnd(START, "2026-11-23T10:30")).toBe(30 * 60);
    expect(secondsToEnd(START, "2026-11-23T09:50")).toBe(-10 * 60);
    expect(secondsToEnd("", "2026-11-23T10:30")).toBeNull();
    expect(secondsToEnd(START, "")).toBeNull();
  });

  it("to an end time: the placed block keeps its start, its end follows its length", () => {
    expect(switchTimeAs("duration", "end", { start: START, placed: true, seconds: 45 * 60 }, 45 * 60)).toEqual({
      mode: "end",
      pending: null,
      pin: { start: START, end: "2026-11-23T10:45" },
    });
  });

  it("to an end time while the start is being placed: it waits, never pins an empty start", () => {
    expect(switchTimeAs("duration", "end", { start: "", placed: false, seconds: 300 }, 300)).toEqual({ mode: "end", pending: 300 });
    expect(switchTimeAs("duration", "end", { start: START, placed: false, seconds: 300 }, 300)).toEqual({ mode: "end", pending: 300 });
  });

  it("placed later: the end is pinned with the length it had when asked", () => {
    expect(settleTimeAs(300, true, { start: START, placed: true, seconds: 3600 })).toEqual({ start: START, end: "2026-11-23T10:05" });
    expect(settleTimeAs(300, true, { start: "", placed: true, seconds: 3600 })).toBeNull();
    expect(settleTimeAs(300, false, { start: START, placed: true, seconds: 3600 })).toBeNull();
    expect(settleTimeAs(null, true, { start: START, placed: true, seconds: 3600 })).toBeNull();
  });

  it("back to a duration: what the end made of it; the same mode changes nothing", () => {
    expect(switchTimeAs("end", "duration", { start: START, placed: true, seconds: 600 }, 600)).toEqual({ mode: "duration", pending: null, duration: 600 });
    expect(switchTimeAs("end", "duration", { start: START, placed: true, seconds: 600 }, null)).toEqual({ mode: "duration", pending: null });
    expect(switchTimeAs("end", "end", { start: START, placed: true, seconds: 600 }, 600)).toBeNull();
  });
});
