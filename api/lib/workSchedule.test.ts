import { describe, it, expect } from "vitest";
import {
  breakSpans,
  defaultWorkSchedule,
  expectedSeconds,
  expectedSecondsBetween,
  effectiveTargetSecondsBetween,
  firstFreeStart,
  keepTargetEnd,
  missingSpans,
  sameWorkDay,
  suggestBreakMove,
  workBounds,
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

describe("hours of a single day", () => {
  const versions = [{ validFrom: EPOCH_DAY, schedule: defaultWorkSchedule() }];
  const lateLunch = { enabled: true, start: "09:00", end: "18:00", breaks: [{ start: "15:00", end: "16:00" }] };
  const overrides = { "2026-10-13": lateLunch }; // Tuesday

  it("replaces its weekday's hours on that date only", () => {
    expect(breakSpans(at(MON + 1, 0), scheduleFor(at(MON + 1, 0), versions, overrides))).toEqual([{ start: at(MON + 1, 15), seconds: H }]);
    // The same weekday a week later, and the day before, keep the weekly hours.
    expect(breakSpans(at(MON + 8, 0), scheduleFor(at(MON + 8, 0), versions, overrides))).toEqual([{ start: at(MON + 8, 13), seconds: H }]);
    expect(breakSpans(at(MON, 0), scheduleFor(at(MON, 0), versions, overrides))).toEqual([{ start: at(MON, 13), seconds: H }]);
  });

  it("moves the holes with the break, the target unchanged", () => {
    const day = at(MON + 1, 0);
    const logged = [{ start: at(MON + 1, 9), seconds: 6 * H }]; // 9–15, through the usual lunch
    expect(missingSpans(day, scheduleFor(day, versions, overrides), logged, at(MON + 2, 0))).toEqual([{ start: at(MON + 1, 16), seconds: 2 * H }]);
    expect(expectedSecondsBetween(at(MON, 0), 7, versions, overrides)).toBe(40 * H);
  });

  it("wins over a later weekly version, and can be a day off", () => {
    const later = [...versions, { validFrom: "2026-10-01", schedule: defaultWorkSchedule(6 * H) }];
    expect(expectedSeconds(at(MON + 1, 0), scheduleFor(at(MON + 1, 0), later, overrides))).toBe(8 * H);
    const off = { "2026-10-14": { enabled: false, start: "09:00", end: "18:00", breaks: [] } };
    expect(workBounds(at(MON + 2, 0), scheduleFor(at(MON + 2, 0), versions, off))).toBeNull();
    expect(effectiveTargetSecondsBetween(at(MON, 0), 7, versions, [], off)).toBe(32 * H);
  });

  it("keeps a DST day's wall-clock hours", () => {
    const sun = new Date(2026, 9, 25);
    const own = { "2026-10-25": { enabled: true, start: "01:00", end: "05:00", breaks: [] } };
    expect(workBounds(sun, scheduleFor(sun, versions, own))).toEqual({ start: new Date(2026, 9, 25, 1), end: new Date(2026, 9, 25, 5) });
  });

  it("same hours, ignoring a day off's", () => {
    const base = defaultWorkSchedule()[0];
    expect(sameWorkDay(base, { ...base, breaks: [{ start: "13:00", end: "14:00" }] })).toBe(true);
    expect(sameWorkDay(base, lateLunch)).toBe(false);
    expect(sameWorkDay({ ...base, enabled: false }, { enabled: false, start: "08:00", end: "12:00", breaks: [] })).toBe(true);
  });

  it("keeping the target moves the end", () => {
    const base = defaultWorkSchedule()[0]; // 9–18, lunch 13–14
    expect(keepTargetEnd(base, { ...base, breaks: [] })).toMatchObject({ end: "17:00" });
    expect(keepTargetEnd(base, { ...base, breaks: [{ start: "13:00", end: "13:30" }] })).toMatchObject({ end: "17:30" });
    expect(keepTargetEnd(base, { ...base, breaks: [{ start: "12:00", end: "14:00" }] })).toMatchObject({ end: "19:00" });
    expect(keepTargetEnd(base, lateLunch)).toBe(lateLunch);
    // Past the end of the day, or before the last break: can't.
    expect(keepTargetEnd(base, { ...base, start: "16:00", end: "18:00", breaks: [] })).toBeNull();
    expect(keepTargetEnd({ ...base, end: "12:00", breaks: [] }, { ...base, end: "18:00", breaks: [{ start: "16:00", end: "17:00" }] })).toBeNull();
    expect(keepTargetEnd(base, { ...base, enabled: false })).toBeNull();
  });
});

describe("worked through the break", () => {
  const sched = defaultWorkSchedule();
  const day = at(MON, 0);

  it("a covered break and a hole as long → the break moved there", () => {
    const logged = [{ start: at(MON, 9), seconds: 6 * H }, { start: at(MON, 16), seconds: 2 * H }]; // hole 15–16
    expect(suggestBreakMove(day, sched, logged, at(MON, 18, 30))).toEqual({
      from: { start: "13:00", end: "14:00" },
      to: { start: "15:00", end: "16:00" },
      workDay: { enabled: true, start: "09:00", end: "18:00", breaks: [{ start: "15:00", end: "16:00" }] },
    });
  });

  it("nothing when the break was taken, the hole is too short, or the break is still to come", () => {
    expect(suggestBreakMove(day, sched, [{ start: at(MON, 9), seconds: 4 * H }], at(MON, 18))).toBeNull();
    const short = [{ start: at(MON, 9), seconds: 6 * H }, { start: at(MON, 15, 30), seconds: 2.5 * H }];
    expect(suggestBreakMove(day, sched, short, at(MON, 18, 30))).toBeNull();
    expect(suggestBreakMove(day, sched, [{ start: at(MON, 9), seconds: 4 * H }], at(MON, 12))).toBeNull();
  });
});
