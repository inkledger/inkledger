import { describe, expect, it } from "vitest";
import { defaultWorkSchedule, type WorkDay } from "@contracts/workSchedule";
import { workDaySchema } from "@contracts/workScheduleSchema";
import { addBreak, breakAt, breakHolding, handleAt, moveHandle, removeBreak, snapTo, targetChoice } from "./dayHours";

const day: WorkDay = defaultWorkSchedule()[0]; // 9–18, lunch 13–14
const m = (h: number, min = 0) => h * 60 + min;
const valid = (d: WorkDay) => workDaySchema.safeParse(d).success;

describe("moving the hours of a day", () => {
  it("moves a whole break, its length kept, never past the day's bounds", () => {
    expect(moveHandle(day, { kind: "break", i: 0 }, m(15)).breaks).toEqual([{ start: "15:00", end: "16:00" }]);
    expect(moveHandle(day, { kind: "break", i: 0 }, m(17, 30)).breaks).toEqual([{ start: "17:00", end: "18:00" }]);
    expect(moveHandle(day, { kind: "break", i: 0 }, m(6)).breaks).toEqual([{ start: "09:00", end: "10:00" }]);
  });

  it("resizes a break, at least 5 minutes, never over its neighbours", () => {
    const two = { ...day, breaks: [{ start: "11:00", end: "11:15" }, { start: "13:00", end: "14:00" }] };
    expect(moveHandle(two, { kind: "breakEnd", i: 0 }, m(13, 30)).breaks[0]).toEqual({ start: "11:00", end: "13:00" });
    expect(moveHandle(two, { kind: "breakStart", i: 1 }, m(14)).breaks[1]).toEqual({ start: "13:55", end: "14:00" });
    expect(moveHandle(two, { kind: "breakStart", i: 1 }, m(10)).breaks[1]).toEqual({ start: "11:15", end: "14:00" });
  });

  it("the day's bounds stop at its breaks and at 23:55", () => {
    expect(moveHandle(day, { kind: "start" }, m(14)).start).toBe("13:00");
    expect(moveHandle(day, { kind: "end" }, m(12)).end).toBe("14:00");
    expect(moveHandle(day, { kind: "end" }, m(25)).end).toBe("23:55");
    expect(moveHandle({ ...day, breaks: [] }, { kind: "start" }, m(20)).start).toBe("17:55");
  });

  it("every move leaves a valid day", () => {
    const handles = [{ kind: "start" }, { kind: "end" }, { kind: "break", i: 0 }, { kind: "breakStart", i: 0 }, { kind: "breakEnd", i: 0 }] as const;
    for (const h of handles) for (let to = -60; to <= 25 * 60; to += 35) expect(valid(moveHandle(day, h, to))).toBe(true);
  });

  it("where a handle stands; snapping", () => {
    expect(handleAt(day, { kind: "breakEnd", i: 0 })).toBe(m(14));
    expect(snapTo(m(13, 2), 5)).toBe(m(13));
    expect(snapTo(m(13, 3), 5)).toBe(m(13, 5));
  });
});

describe("adding and removing breaks", () => {
  it("half an hour at lunch when free, else in the first free stretch", () => {
    expect(addBreak({ ...day, breaks: [] })?.breaks).toEqual([{ start: "13:00", end: "13:30" }]);
    expect(addBreak(day)?.breaks).toEqual([{ start: "10:00", end: "10:30" }, { start: "13:00", end: "14:00" }]);
    expect(addBreak({ ...day, enabled: false })).toBeNull();
    expect(addBreak({ ...day, start: "09:00", end: "09:20", breaks: [] })).toBeNull();
    expect(removeBreak(day, 0).breaks).toEqual([]);
  });
});

describe("that was my break", () => {
  it("the closest break moves to the away time, rounded out to 5 minutes", () => {
    expect(breakAt(day, m(15, 2), m(15, 58))?.breaks).toEqual([{ start: "15:00", end: "16:00" }]);
  });
  it("replaces and merges the breaks it overlaps; added on a day without any", () => {
    const two = { ...day, breaks: [{ start: "11:00", end: "11:15" }, { start: "13:00", end: "14:00" }] };
    expect(breakAt(two, m(12, 30), m(13, 30))?.breaks).toEqual([{ start: "11:00", end: "11:15" }, { start: "12:30", end: "13:30" }]);
    expect(breakAt(two, m(11), m(14))?.breaks).toEqual([{ start: "11:00", end: "14:00" }]);
    expect(breakAt({ ...day, breaks: [] }, m(12), m(12, 40))?.breaks).toEqual([{ start: "12:00", end: "12:40" }]);
  });
  it("within the day's hours only", () => {
    expect(breakAt(day, m(18, 10), m(19))).toBeNull();
    // Over the day's start or end: arrived late or went home, not a break (lunch stays).
    expect(breakAt(day, m(8), m(9, 30))).toBeNull();
    expect(breakAt(day, m(17, 30), m(19, 30))).toBeNull();
    expect(breakAt(day, m(17), m(18))).toBeNull();
    expect(breakAt({ ...day, enabled: false }, m(12), m(13))).toBeNull();
  });
});

describe("the break that already holds the time away", () => {
  it("is the day's own break when the time falls inside it, rounded out to 5", () => {
    expect(breakHolding(day, m(13, 40), m(13, 58))).toEqual({ start: "13:00", end: "14:00" });
    expect(breakHolding(day, m(13), m(14))).toEqual({ start: "13:00", end: "14:00" });
  });
  it("is none when the time reaches out of it, or the day has none", () => {
    expect(breakHolding(day, m(12, 30), m(13, 30))).toBeNull();
    expect(breakHolding(day, m(13, 40), m(14, 2))).toBeNull();
    expect(breakHolding({ ...day, breaks: [] }, m(13, 10), m(13, 20))).toBeNull();
    expect(breakHolding({ ...day, enabled: false }, m(13, 10), m(13, 20))).toBeNull();
  });
});

describe("saving: keep the target or the hours", () => {
  it("asks only when the work changes", () => {
    expect(targetChoice(day, moveHandle(day, { kind: "break", i: 0 }, m(15)))).toBeNull();
    const noLunch = removeBreak(day, 0);
    expect(targetChoice(day, noLunch)).toEqual({ keep: { ...noLunch, end: "17:00" }, baseSeconds: 8 * 3600, draftSeconds: 9 * 3600 });
    expect(targetChoice(day, { ...day, enabled: false })).toBeNull();
  });
});
