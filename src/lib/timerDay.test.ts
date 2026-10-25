import { describe, expect, it } from "vitest";
import { timerOnDay } from "./timerDay";

describe("timerOnDay: the day a timer's time belongs to", () => {
  const now = new Date("2026-10-24T15:00:00+02:00");
  it("running: today's", () => {
    expect(timerOnDay({ state: "running", pausedAt: null }, now, now)).toBe(true);
  });
  it("stopped today: today's", () => {
    expect(timerOnDay({ state: "paused", pausedAt: "2026-10-24T09:00:00+02:00" }, now, now)).toBe(true);
  });
  it("stopped yesterday: yesterday's, never today's", () => {
    expect(timerOnDay({ state: "paused", pausedAt: "2026-10-23T18:00:00+02:00" }, now, now)).toBe(false);
    expect(timerOnDay({ state: "paused", pausedAt: "2026-10-23T18:00:00+02:00" }, new Date("2026-10-23T12:00:00+02:00"), now)).toBe(true);
  });
});
