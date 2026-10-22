import { describe, it, expect } from "vitest";
import { conflictMessage, occupiedId, overlapping, placeBlock, type Occupied } from "@contracts/placement";
import { defaultWorkSchedule } from "@contracts/workSchedule";

const at = (d: number, h: number, m = 0, s = 0) => new Date(2026, 9, d, h, m, s); // Oct 2026
const FRI = 16; // Friday 2026-10-16
const sched = defaultWorkSchedule(); // Mon–Fri 9–18, lunch 13–14
const MIN = 60;
const wl = (start: Date, minutes: number, label = "DEMO-1", id?: string): Occupied => ({
  start,
  seconds: minutes * MIN,
  label,
  id,
});
const place = (o: Partial<Parameters<typeof placeBlock>[0]> & { seconds: number }) =>
  placeBlock({ day: at(FRI, 0), occupied: [], schedule: sched, now: at(FRI, 15), ...o });

describe("placeBlock: today ends now", () => {
  it("logged 9–10, now 15:00, 30m → 14:30 (not the morning hole)", () => {
    expect(place({ seconds: 30 * MIN, occupied: [wl(at(FRI, 9), 60)] })).toEqual({
      ok: true,
      start: at(FRI, 14, 30),
    });
  });

  it("the end of the day taken → end of the latest free stretch before now", () => {
    const occupied = [wl(at(FRI, 9), 60), wl(at(FRI, 14, 45), 15)];
    expect(place({ seconds: 30 * MIN, occupied })).toEqual({ ok: true, start: at(FRI, 14, 15) });
  });

  it("skips a too short stretch and goes further back", () => {
    const occupied = [wl(at(FRI, 9), 300), wl(at(FRI, 14, 50), 10)]; // 9–14, 14:50–15
    // 14:00–14:50 is too short, and before 9:00 is not working time
    expect(place({ seconds: 60 * MIN, occupied }).ok).toBe(false);
    expect(place({ seconds: 40 * MIN, occupied })).toEqual({ ok: true, start: at(FRI, 14, 10) });
  });

  it("a full day is a conflict, never an overlap", () => {
    const r = place({ seconds: 30 * MIN, occupied: [wl(at(FRI, 0), 15 * 60)] });
    expect(r.ok).toBe(false);
  });

  it("ignores breaks: what was just done ends now, even at 13:30", () => {
    expect(place({ seconds: 20 * MIN, now: at(FRI, 13, 30) })).toEqual({ ok: true, start: at(FRI, 13, 10) });
  });

  it("does not cover a block ending a few seconds past the minute", () => {
    const occupied = [wl(at(FRI, 14, 0, 30), 30)]; // 14:00:30–14:30:30
    const r = place({ seconds: 30 * MIN, occupied, now: at(FRI, 14, 50) });
    // 14:20–14:50 would overlap by 10m30s: goes before it
    expect(r).toEqual({ ok: true, start: at(FRI, 13, 30) });
  });

  it("tracked work begun before the working hours ends at its stop in its own place (a timer from 8:15 stopped at 9:05)", () => {
    expect(place({ seconds: 50 * MIN, tracked: 50 * MIN, now: at(FRI, 9, 5), endAt: at(FRI, 9, 5) })).toEqual({ ok: true, start: at(FRI, 8, 15) });
    expect(place({ seconds: 50 * MIN, tracked: 50 * MIN + 20, now: at(FRI, 10), endAt: at(FRI, 9, 5) })).toEqual({ ok: true, start: at(FRI, 8, 15) });
    // Its own place taken: moved back, but never before the working hours.
    expect(place({ seconds: 50 * MIN, tracked: 50 * MIN, now: at(FRI, 9, 5), endAt: at(FRI, 9, 5), occupied: [wl(at(FRI, 8, 50), 15)] }).ok).toBe(false);
    // More than the timer tracked (typed over it): not tracked time, out of the night.
    expect(place({ seconds: 8 * 60 * MIN, tracked: 50 * MIN, now: at(FRI, 10), endAt: at(FRI, 10) }).ok).toBe(false);
    expect(place({ seconds: 50 * MIN, now: at(FRI, 9, 5), endAt: at(FRI, 9, 5) }).ok).toBe(false);
  });

  it("a typed duration or a copied day stays out of the night, however empty the day", () => {
    expect(place({ seconds: 50 * MIN, now: at(FRI, 9, 5) }).ok).toBe(false);
    expect(place({ seconds: 8 * 60 * MIN, now: at(FRI, 10) }).ok).toBe(false);
  });

  it("never before midnight: early in the day there is no room", () => {
    expect(place({ seconds: 2 * 3600, now: at(FRI, 1) }).ok).toBe(false);
    expect(place({ seconds: 30 * MIN, now: at(FRI, 1) })).toEqual({ ok: true, start: at(FRI, 0, 30) });
  });
});

describe("placeBlock: a stopped timer ends at the stop", () => {
  it("stopped at 12:00, logged at 17:00 → 11:15–12:00", () => {
    expect(place({ seconds: 45 * MIN, now: at(FRI, 17), endAt: at(FRI, 12) })).toEqual({
      ok: true,
      start: at(FRI, 11, 15),
    });
  });

  it("two queued timers do not overlap", () => {
    const first = place({ seconds: 30 * MIN, now: at(FRI, 17), endAt: at(FRI, 12) });
    expect(first).toEqual({ ok: true, start: at(FRI, 11, 30) });
    const second = place({
      seconds: 30 * MIN,
      now: at(FRI, 17),
      endAt: at(FRI, 11, 45), // stopped while the first was running
      occupied: [wl(at(FRI, 11, 30), 30)],
    });
    expect(second).toEqual({ ok: true, start: at(FRI, 11) });
  });

  it("a timer stopped yesterday goes on yesterday", () => {
    expect(
      place({ day: at(FRI - 1, 0), seconds: 30 * MIN, now: at(FRI, 9), endAt: at(FRI - 1, 18) }),
    ).toEqual({ ok: true, start: at(FRI - 1, 17, 30) });
  });
});

describe("placeBlock: past days append", () => {
  const THU = FRI - 1;
  it("after the last block of the day", () => {
    const occupied = [wl(at(THU, 9), 60), wl(at(THU, 14), 90)];
    expect(place({ day: at(THU, 0), seconds: 30 * MIN, occupied })).toEqual({ ok: true, start: at(THU, 15, 30) });
  });

  it("an empty day starts with its working hours, 9:00 on days off", () => {
    expect(place({ day: at(THU, 0), seconds: 30 * MIN })).toEqual({ ok: true, start: at(THU, 9) });
    const sat = at(FRI + 1, 0);
    expect(place({ day: sat, seconds: 30 * MIN, now: at(FRI + 3, 10) })).toEqual({ ok: true, start: at(FRI + 1, 9) });
  });

  it("rounds a ragged last end up to the minute", () => {
    const occupied = [wl(at(THU, 9, 0, 20), 60)];
    expect(place({ day: at(THU, 0), seconds: 30 * MIN, occupied })).toEqual({ ok: true, start: at(THU, 10, 1) });
  });

  it("past midnight is a conflict", () => {
    const occupied = [wl(at(THU, 22), 90)];
    expect(place({ day: at(THU, 0), seconds: 60 * MIN, occupied }).ok).toBe(false);
  });

  it("keeps the wall clock on the DST day (25 Oct)", () => {
    const sun = new Date(2026, 9, 25);
    expect(place({ day: sun, seconds: 30 * MIN, now: at(27, 9), occupied: [wl(new Date(2026, 9, 25, 10), 60)] })).toEqual({
      ok: true,
      start: new Date(2026, 9, 25, 11),
    });
  });
});

describe("overlapping", () => {
  const existing = [wl(at(FRI, 9), 60, "DEMO-1", "w1"), wl(at(FRI, 10), 30, "SHOP-2", "w2")];
  it("adjacent blocks and sub-minute touches are fine", () => {
    expect(overlapping({ start: at(FRI, 10, 30), seconds: 600 }, existing)).toEqual([]);
    expect(overlapping({ start: at(FRI, 10, 29, 30), seconds: 600 }, existing)).toEqual([]);
  });
  it("real overlaps are reported, the edited one excluded", () => {
    const hits = overlapping({ start: at(FRI, 9, 30), seconds: 3600 }, existing);
    expect(hits.map((h) => h.label)).toEqual(["DEMO-1", "SHOP-2"]);
    expect(overlapping({ start: at(FRI, 9), seconds: 5400 }, existing, "w1").map((h) => h.id)).toEqual(["w2"]);
    // The same remote id on two trackers: skipping one entry never skips the other.
    const twins = [wl(at(FRI, 9), 60, "A-1", occupiedId({ connectionId: 1, remoteId: "7" })), wl(at(FRI, 11), 60, "B-1", occupiedId({ connectionId: 2, remoteId: "7" }))];
    expect(overlapping({ start: at(FRI, 11, 30), seconds: 3600 }, twins, occupiedId({ connectionId: 1, remoteId: "7" })).map((h) => h.label)).toEqual(["B-1"]);
    expect(conflictMessage(hits)).toBe("Overlaps DEMO-1 09:00–10:00, SHOP-2 10:00–10:30");
  });
});

describe("time logged in parallel", () => {
  const at = (h: number, m = 0) => new Date(2026, 8, 7, h, m);
  const b = (h: number, m: number, minutes: number) => ({ start: at(h, m), seconds: minutes * 60 });

  it("overlapping blocks share lanes; a block alone keeps the full height; touching ones don't overlap", async () => {
    const { lanesOf } = await import("@contracts/placement");
    const out = lanesOf([b(9, 0, 60), b(9, 30, 60), b(10, 0, 30), b(11, 0, 30), b(11, 30, 30)]);
    expect(out.map((x) => [x.lane, x.lanes])).toEqual([
      [0, 2],
      [1, 2],
      [0, 2],
      [0, 1],
      [0, 1],
    ]);
  });

  it("clock time counts parallel time once", async () => {
    const { realSeconds } = await import("@contracts/placement");
    expect(realSeconds([b(9, 0, 60), b(9, 30, 60), b(14, 0, 30)])).toBe(120 * 60);
    expect(realSeconds([])).toBe(0);
  });
});

describe("hours worked (parallel work once)", () => {
  const b = (d: number, h: number, m: number, minutes: number, s = 0) => ({ start: at(d, h, m, s), seconds: minutes * MIN });

  it("a day without parallel work is the plain sum, touching pieces included (rounded to the minute)", async () => {
    const { realSeconds } = await import("@contracts/placement");
    const day = [b(FRI, 9, 0, 60), b(FRI, 10, 0, 30), b(FRI, 14, 0, 45)];
    expect(realSeconds(day)).toBe(135 * MIN);
    // A piece rounded up overlaps the next by 30 s: still the sum.
    expect(realSeconds([b(FRI, 9, 0, 61), b(FRI, 10, 0, 30, 30)])).toBe(91 * MIN);
    expect(realSeconds([])).toBe(0);
  });

  it("parallel work counts once: what runs past the others, any order, any nesting", async () => {
    const { realSeconds } = await import("@contracts/placement");
    expect(realSeconds([b(FRI, 10, 0, 60), b(FRI, 10, 0, 60)])).toBe(60 * MIN);
    expect(realSeconds([b(FRI, 9, 30, 60), b(FRI, 9, 0, 60)])).toBe(90 * MIN);
    expect(realSeconds([b(FRI, 9, 0, 120), b(FRI, 9, 30, 30), b(FRI, 10, 30, 60)])).toBe(150 * MIN);
  });

  it("by local day, and over many days the sum of each day's", async () => {
    const { realSecondsByDay, realSecondsTotal } = await import("@contracts/placement");
    const items = [b(FRI, 9, 0, 60), b(FRI, 9, 0, 60), b(FRI + 1, 9, 0, 30)];
    expect([...realSecondsByDay(items).values()]).toEqual([60 * MIN, 30 * MIN]);
    expect(realSecondsTotal(items)).toBe(90 * MIN);
  });
});
