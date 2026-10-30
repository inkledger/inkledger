import { describe, expect, it } from "vitest";
import { defaultWorkSchedule } from "@contracts/workSchedule";
import { placePendingTimers } from "./pendingTimers";

const day = new Date("2026-10-28T00:00:00+01:00");
const now = new Date("2026-10-28T17:00:00+01:00");
const at = (hhmm: string) => new Date(`2026-10-28T${hhmm}:00+01:00`);
const paused = (issueKey: string, stop: string, seconds: number) => ({
  issueKey,
  connectionId: 1,
  state: "paused",
  pausedAt: at(stop).toISOString(),
  elapsedSeconds: seconds,
});

describe("placePendingTimers: stopped timers on the day's timeline", () => {
  it("ends at its stop when that stretch is free", () => {
    const [b] = placePendingTimers({ day, now, timers: [paused("A-1", "11:00", 3600)], occupied: [], schedule: defaultWorkSchedule() });
    expect(b.start).toEqual(at("10:00"));
    expect(b.seconds).toBe(3600);
  });

  it("never over a worklog logged in between: moved back to free time", () => {
    // Ran 9–10, paused, A-2 logged 10–11, ran again 11–12: two hours tracked, stopped at 12.
    const [b] = placePendingTimers({
      day,
      now,
      timers: [paused("A-1", "12:00", 2 * 3600)],
      occupied: [{ start: at("10:00"), seconds: 3600 }],
      schedule: defaultWorkSchedule(),
    });
    const end = b.start.getTime() + b.seconds * 1000;
    expect(end <= at("10:00").getTime() || b.start.getTime() >= at("11:00").getTime()).toBe(true);
  });

  it("two stopped timers never overlap each other", () => {
    const blocks = placePendingTimers({
      day,
      now,
      timers: [paused("A-1", "11:00", 3600), paused("A-2", "11:00", 1800)],
      occupied: [],
      schedule: defaultWorkSchedule(),
    });
    expect(blocks).toHaveLength(2);
    const [a, b] = blocks.map(x => [x.start.getTime(), x.start.getTime() + x.seconds * 1000]);
    expect(a[1] <= b[0] || b[1] <= a[0]).toBe(true);
  });

  it("only that day's: running timers and ones stopped on another day stay out", () => {
    const blocks = placePendingTimers({
      day,
      now,
      timers: [
        { ...paused("A-1", "11:00", 3600), state: "running", pausedAt: null },
        { ...paused("A-2", "11:00", 3600), pausedAt: "2026-10-27T18:00:00+01:00" },
        paused("A-3", "15:00", 0),
      ],
      occupied: [],
      schedule: defaultWorkSchedule(),
    });
    expect(blocks).toEqual([]);
  });
});
