import { describe, it, expect } from "vitest";
import {
  breakSpans,
  defaultWorkSchedule,
  expectedSeconds,
  expectedSecondsBetween,
  firstFreeStart,
  missingSpans,
  openGap,
  scheduleFor,
  workSpans,
  EPOCH_DAY,
  type WorkSchedule,
} from "@contracts/workSchedule";
import { normalizeWorkSchedule, workScheduleSchema } from "@contracts/workScheduleSchema";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m); // Oct 2026
const MON = 12; // 2026-10-12 is a Monday
const H = 3600;

describe("work schedule", () => {
  const sched = defaultWorkSchedule();

  it("defaults: Mon–Fri 9–18 with lunch, weekend off", () => {
    expect(workSpans(at(MON, 0), sched)).toEqual([
      { start: at(MON, 9), seconds: 4 * H },
      { start: at(MON, 14), seconds: 4 * H },
    ]);
    expect(breakSpans(at(MON, 0), sched)).toEqual([{ start: at(MON, 13), seconds: H }]);
    expect(expectedSeconds(at(MON, 0), sched)).toBe(8 * H);
    expect(expectedSeconds(at(MON + 5, 0), sched)).toBe(0); // Saturday
    expect(missingSpans(at(MON + 5, 0), sched, [], at(MON + 6, 0))).toEqual([]);
  });

  it("the open hole is the one reaching now: a timer can start from its start", () => {
    const logged = [{ start: at(MON, 9), seconds: 2 * H }]; // 9–11
    const now = at(MON, 11, 40);
    expect(openGap(missingSpans(at(MON, 0), sched, logged, now), now)).toEqual({ start: at(MON, 11), seconds: 40 * 60 });
    // Covered up to now (a running timer drawn to now), or past the working day: none.
    const upToNow = [...logged, { start: at(MON, 11), seconds: 40 * 60 }];
    expect(openGap(missingSpans(at(MON, 0), sched, upToNow, now), now)).toBeNull();
    expect(openGap(missingSpans(at(MON, 0), sched, logged, at(MON, 19)), at(MON, 19))).toBeNull();
    // During lunch the hole before it is closed.
    expect(openGap(missingSpans(at(MON, 0), sched, logged, at(MON, 13, 20)), at(MON, 13, 20))).toBeNull();
    // Under a minute: nothing to start from.
    const now2 = at(MON, 11);
    expect(openGap(missingSpans(at(MON, 0), sched, logged, new Date(now2.getTime() + 30_000)), new Date(now2.getTime() + 30_000))).toBeNull();
  });

  it("derives the first version from an old daily target", () => {
    const six = defaultWorkSchedule(6 * H);
    expect(six[0]).toMatchObject({ start: "09:00", end: "16:00" });
    expect(expectedSeconds(at(MON, 0), six)).toBe(6 * H);
    const short = defaultWorkSchedule(3 * H);
    expect(short[0]).toEqual({ enabled: true, start: "09:00", end: "12:00", breaks: [] });
  });

  it("keeps a DST day at its wall-clock hours", () => {
    // 2026-10-25: clocks go back at 3:00 in Rome
    expect(expectedSeconds(new Date(2026, 9, 25), sched)).toBe(0); // Sunday
    const allWeek = sched.map(() => sched[0]);
    expect(expectedSeconds(new Date(2026, 9, 25), allWeek)).toBe(8 * H);
  });

  it("finds every hole, even of a few minutes, up to now", () => {
    const logged = [
      { start: at(MON, 9), seconds: 2 * H }, // 9–11
      { start: at(MON, 10, 30), seconds: H }, // overlap, to 11:30
      { start: at(MON, 11, 35), seconds: 25 * 60 }, // 11:35–12:00
      { start: at(MON, 12, 59), seconds: 2 * H }, // into lunch, to 14:59
    ];
    expect(missingSpans(at(MON, 0), sched, logged, at(MON, 16))).toEqual([
      { start: at(MON, 11, 30), seconds: 5 * 60 },
      { start: at(MON, 12), seconds: 59 * 60 },
      { start: at(MON, 14, 59), seconds: 61 * 60 },
    ]);
    expect(firstFreeStart(at(MON, 0), sched, logged, 30 * 60, at(MON, 16))).toEqual(at(MON, 12));
    expect(firstFreeStart(at(MON, 0), sched, logged, 2 * H, at(MON, 16))).toBeNull();
  });

  it("judges each day with the version in force then", () => {
    const friShort: WorkSchedule = sched.map((d, i) =>
      i === 4 ? { enabled: true, start: "09:00", end: "15:00", breaks: [] } : d,
    );
    const versions = [
      { validFrom: EPOCH_DAY, schedule: sched },
      { validFrom: "2026-10-14", schedule: friShort }, // from Wednesday
    ];
    // the week before the change is untouched
    expect(expectedSecondsBetween(at(MON - 7, 0), 7, versions)).toBe(40 * H);
    // the week of the change: Mon–Thu 8h, Fri 6h
    expect(expectedSecondsBetween(at(MON, 0), 7, versions)).toBe(38 * H);
    expect(scheduleFor(at(MON + 1, 0), versions)).toBe(sched);
    expect(scheduleFor(at(MON + 2, 0), versions)).toBe(friShort);
  });

  it("validates hours and breaks", () => {
    const day = (o: object) => {
      const s = defaultWorkSchedule();
      s[0] = { ...s[0], ...o };
      return workScheduleSchema.safeParse(s).success;
    };
    expect(day({})).toBe(true);
    expect(day({ start: "18:00", end: "09:00" })).toBe(false);
    expect(day({ start: "9:00" })).toBe(false);
    expect(day({ breaks: [{ start: "08:00", end: "09:30" }] })).toBe(false);
    expect(day({ breaks: [{ start: "12:00", end: "13:00" }, { start: "12:30", end: "14:00" }] })).toBe(false);
    expect(day({ enabled: false, start: "18:00", end: "09:00" })).toBe(true);
    expect(normalizeWorkSchedule("garbage")).toEqual(defaultWorkSchedule());
  });
});
