import { describe, expect, it } from "vitest";
import {
  defaultWorkSchedule,
  effectiveTargetSeconds,
  effectiveTargetSecondsBetween,
  effectiveWorkSpans,
  EPOCH_DAY,
  type WorkSchedule,
} from "@contracts/workSchedule";
import { plannedDayRange, type PlannedInterval } from "@contracts/planned";

const H = 3600;
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const vacation = (startsAt: Date, endsAt: Date): PlannedInterval => ({ kind: "vacation", startsAt, endsAt });

describe("effective target with planned entries", () => {
  const schedule = defaultWorkSchedule();
  const monday = at(12, 0);

  it("a whole local vacation day has zero target, while work and travel leave it unchanged", () => {
    const range = plannedDayRange("2026-10-12")!;
    expect(effectiveTargetSeconds(monday, schedule, [vacation(range.startsAt, range.endsAt)])).toBe(0);
    expect(effectiveWorkSpans(monday, schedule, [vacation(range.startsAt, range.endsAt)])).toEqual([]);
    expect(effectiveTargetSeconds(monday, schedule, [
      { kind: "work", startsAt: at(12, 9), endsAt: at(12, 18) },
      { kind: "travel", startsAt: at(12, 9), endsAt: at(12, 18) },
    ])).toBe(8 * H);
  });

  it("a partial vacation subtracts only its intersections with work spans, not breaks", () => {
    expect(effectiveWorkSpans(monday, schedule, [vacation(at(12, 10), at(12, 12))])).toEqual([
      { start: at(12, 9), seconds: H },
      { start: at(12, 12), seconds: H },
      { start: at(12, 14), seconds: 4 * H },
    ]);
    expect(effectiveTargetSeconds(monday, schedule, [vacation(at(12, 12, 30), at(12, 15))])).toBe(6.5 * H);
  });

  it("unions overlapping absences before subtracting and never goes below zero", () => {
    const absences = [vacation(at(12, 10), at(12, 12)), vacation(at(12, 11), at(12, 15))];
    expect(effectiveTargetSeconds(monday, schedule, absences)).toBe(4 * H);
    const whole = plannedDayRange("2026-10-12")!;
    expect(effectiveTargetSeconds(monday, schedule, [vacation(whole.startsAt, whole.endsAt), ...absences])).toBe(0);
  });

  it("handles weekends and multi-week or month ranges", () => {
    expect(effectiveTargetSeconds(at(17, 0), schedule, [])).toBe(0);
    const allWeek = schedule.map(() => schedule[0]);
    expect(effectiveTargetSeconds(at(17, 0), allWeek, [vacation(at(17, 0), at(18, 0))])).toBe(0);
    const range = plannedDayRange("2026-10-30", "2026-11-02")!;
    expect(effectiveTargetSecondsBetween(at(26, 0), 7, [{ validFrom: EPOCH_DAY, schedule }], [vacation(range.startsAt, range.endsAt)])).toBe(32 * H);
  });

  it("uses local midnights across DST changes", () => {
    const spring = plannedDayRange("2026-03-29")!;
    const autumn = plannedDayRange("2026-10-25")!;
    expect((spring.endsAt.getTime() - spring.startsAt.getTime()) / 1000).toBe(23 * H);
    expect((autumn.endsAt.getTime() - autumn.startsAt.getTime()) / 1000).toBe(25 * H);
    const allWeek = schedule.map(() => schedule[0]);
    expect(effectiveTargetSeconds(spring.startsAt, allWeek, [vacation(spring.startsAt, spring.endsAt)])).toBe(0);
    expect(effectiveTargetSeconds(autumn.startsAt, allWeek, [vacation(autumn.startsAt, autumn.endsAt)])).toBe(0);
  });

  it("judges every day with its schedule version before subtracting vacation", () => {
    const shortFriday: WorkSchedule = schedule.map((day, i) => i === 4 ? { enabled: true, start: "09:00", end: "15:00", breaks: [] } : day);
    const versions = [
      { validFrom: EPOCH_DAY, schedule },
      { validFrom: "2026-10-14", schedule: shortFriday },
    ];
    const friday = plannedDayRange("2026-10-16")!;
    const absence = vacation(new Date(2026, 9, 16, 10), new Date(2026, 9, 16, 12));
    expect(effectiveTargetSecondsBetween(at(5, 0), 7, versions, [absence])).toBe(40 * H);
    expect(effectiveTargetSecondsBetween(monday, 7, versions, [absence])).toBe(36 * H);
    expect(effectiveTargetSeconds(friday.startsAt, shortFriday, [absence])).toBe(4 * H);
  });
});
