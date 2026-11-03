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
    // 14:20–14:50 would overlap by 10m30s: goes before it, and before lunch (13–14)
    expect(r).toEqual({ ok: true, start: at(FRI, 12, 30) });
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

describe("placeBlock: around the day's breaks (lunch 13–14)", () => {
  const THU = FRI - 1;
  const parts = (...p: [Date, number][]) => p.map(([start, minutes]) => ({ start, seconds: minutes * MIN }));

  it("a paused timer of 8h stopped at 18:00 → 9–13 and 14–18", () => {
    expect(place({ seconds: 480 * MIN, tracked: 480 * MIN, now: at(FRI, 18), endAt: at(FRI, 18) })).toEqual({
      ok: true,
      start: at(FRI, 9),
      parts: parts([at(FRI, 9), 240], [at(FRI, 14), 240]),
    });
  });

  it("a timer that ran through lunch (never paused) stays in one piece", () => {
    expect(place({ seconds: 120 * MIN, tracked: 120 * MIN, unbroken: true, now: at(FRI, 14, 30), endAt: at(FRI, 14, 30) })).toEqual({
      ok: true,
      start: at(FRI, 12, 30),
    });
  });

  it("2h typed at 14:30 → 11:30–13:00 and 14:00–14:30", () => {
    expect(place({ seconds: 120 * MIN, now: at(FRI, 14, 30) })).toEqual({
      ok: true,
      start: at(FRI, 11, 30),
      parts: parts([at(FRI, 11, 30), 90], [at(FRI, 14), 30]),
    });
  });

  it("never splits over other time: goes further back instead", () => {
    // 14:00–14:20 taken: 30m can't continue from 14:20–14:30 over it, so it fits before lunch.
    expect(place({ seconds: 30 * MIN, now: at(FRI, 14, 30), occupied: [wl(at(FRI, 14), 20)] })).toEqual({ ok: true, start: at(FRI, 12, 30) });
  });

  it("follows the day's own break", () => {
    const own = sched.map((d, i) => (i === 4 ? { ...d, breaks: [{ start: "15:00", end: "16:00" }] } : d));
    expect(place({ seconds: 120 * MIN, now: at(FRI, 16, 30), schedule: own })).toEqual({
      ok: true,
      start: at(FRI, 13, 30),
      parts: parts([at(FRI, 13, 30), 90], [at(FRI, 16), 30]),
    });
  });

  it("nothing fits around the break: one piece over it, said so", () => {
    // 9–12 taken, 2h at 14:30: 12–13 + 14–14:30 is only 1h30.
    expect(place({ seconds: 120 * MIN, now: at(FRI, 14, 30), occupied: [wl(at(FRI, 9), 180)] })).toEqual({
      ok: true,
      start: at(FRI, 12, 30),
      overBreak: true,
    });
  });

  it("past days: appended after a break, never in it, split by one further on", () => {
    expect(place({ day: at(THU, 0), seconds: 60 * MIN, occupied: [wl(at(THU, 9), 240)] })).toEqual({ ok: true, start: at(THU, 14) });
    expect(place({ day: at(THU, 0), seconds: 120 * MIN, occupied: [wl(at(THU, 9), 180)] })).toEqual({
      ok: true,
      start: at(THU, 12),
      parts: parts([at(THU, 12), 60], [at(THU, 14), 60]),
    });
    // Ends right at the break: one piece.
    expect(place({ day: at(THU, 0), seconds: 60 * MIN, occupied: [wl(at(THU, 9), 180)] })).toEqual({ ok: true, start: at(THU, 12) });
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

describe("pieces for logging", () => {
  it("blocks laid over a split placement go on after the break, in pieces", async () => {
    const { layOver } = await import("@contracts/placement");
    const parts = [{ start: at(FRI, 12), seconds: 60 * MIN }, { start: at(FRI, 14), seconds: 90 * MIN }];
    const laid = layOver(parts, [30 * MIN, 60 * MIN, 60 * MIN]);
    expect(laid.map((b) => b.map((p) => [p.start.getHours(), p.start.getMinutes(), p.seconds / MIN]))).toEqual([
      [[12, 0, 30]],
      [[12, 30, 30], [14, 0, 30]],
      [[14, 30, 60]],
    ]);
  });

  it("whole seconds adding up exactly; the label of the pieces", async () => {
    const { partsInput, partsLabel } = await import("@contracts/placement");
    const parts = [{ start: at(FRI, 9), seconds: 240 * MIN }, { start: at(FRI, 14), seconds: 240 * MIN + 0.4 }];
    expect(partsInput(parts, 480 * MIN + 1).map((p) => p.seconds)).toEqual([240 * MIN, 240 * MIN + 1]);
    expect(partsLabel(parts)).toBe("09:00–13:00 + 14:00–18:00");
  });
});

describe("placeBlock: split around breaks, edge cases", () => {
  const MON = 12; // Monday 2026-10-12, a past day when now is Friday

  it("never chains a split over another worklog: free time starting in the break is not linked to the morning", () => {
    // 12:30–13:30 taken; a 6 h timer stopped at 18:00 can't be 10:30–12:30 + 14:00–18:00 (around the worklog).
    const taken = [wl(at(FRI, 12, 30), 60)];
    const r = place({ seconds: 6 * 60 * MIN, endAt: at(FRI, 18), now: at(FRI, 19), occupied: taken });
    const parts = r.ok ? (r.parts ?? [{ start: r.start, seconds: 6 * 60 * MIN }]) : [];
    for (const p of parts) expect(overlapping(p, taken)).toEqual([]);
    expect(parts.some(p => p.start < at(FRI, 12, 30)) && parts.some(p => p.start >= at(FRI, 13, 30))).toBe(false);
  });

  it("no piece under a minute when appending on a past day (4h 0m 30s from 9:00)", () => {
    const r = placeBlock({ day: at(MON, 0), occupied: [], schedule: sched, now: at(FRI, 15), seconds: 4 * 3600 + 30 });
    // 9:00–13:00 then the 30 s run on past the break's start (within the tolerance), not alone at 14:00.
    expect(r).toEqual({ ok: true, start: at(MON, 9) });
  });

  it("no piece under a minute when filling back across breaks", () => {
    const two = sched.map(d => (d.enabled ? { ...d, breaks: [{ start: "11:00", end: "11:30" }, { start: "13:00", end: "14:00" }] } : d));
    const r = place({ schedule: two, seconds: 19830, endAt: at(FRI, 18), now: at(FRI, 19) });
    expect(r.ok).toBe(true);
    if (r.ok && r.parts) {
      for (const p of r.parts) expect(p.seconds).toBeGreaterThanOrEqual(60);
      expect(r.parts.reduce((a, p) => a + p.seconds, 0)).toBe(19830);
    }
  });
});

describe("placeBlock: split around breaks on DST days", () => {
  // Sundays enabled 9–18 with lunch 13–14, as any weekday.
  const sundays = sched.map((d, i) => (i === 6 ? { ...sched[0] } : d));
  const parts = (r: ReturnType<typeof placeBlock>) => (r.ok ? (r.parts ?? [{ start: r.start, seconds: -1 }]) : null);
  for (const [name, d] of [["25 Oct (25 h)", 25], ["29 Mar (23 h)", 29]] as const) {
    const month = d === 25 ? 9 : 2;
    const on = (h: number, m = 0) => new Date(2026, month, d, h, m);
    it(`appends around lunch at wall-clock hours on ${name}`, () => {
      const r = placeBlock({ day: on(0), occupied: [], schedule: sundays, now: new Date(2026, month, d + 2, 9), seconds: 6 * 3600 });
      expect(parts(r)).toEqual([{ start: on(9), seconds: 4 * 3600 }, { start: on(14), seconds: 2 * 3600 }]);
    });
    it(`fills back from a stop around lunch on ${name}`, () => {
      const r = placeBlock({ day: on(0), occupied: [], schedule: sundays, now: new Date(2026, month, d + 2, 9), endAt: on(18), tracked: 8 * 3600, seconds: 8 * 3600 });
      expect(parts(r)).toEqual([{ start: on(9), seconds: 4 * 3600 }, { start: on(14), seconds: 4 * 3600 }]);
    });
  }
  it("a break over the hour that doesn't exist (29 Mar, 02:00–03:00) never breaks the sum", () => {
    const night = sched.map((d, i) => (i === 6 ? { enabled: true, start: "01:00", end: "06:00", breaks: [{ start: "02:00", end: "03:00" }] } : d));
    const r = placeBlock({ day: new Date(2026, 2, 29), occupied: [], schedule: night, now: new Date(2026, 2, 31, 9), seconds: 3 * 3600 });
    expect(r.ok).toBe(true);
    const p = parts(r) ?? [];
    expect(p.reduce((a, x) => a + (x.seconds < 0 ? 3 * 3600 : x.seconds), 0)).toBe(3 * 3600);
    for (const x of p) if (x.seconds >= 0) expect(x.seconds).toBeGreaterThanOrEqual(60);
  });
});
