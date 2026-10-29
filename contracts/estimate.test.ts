import { describe, expect, it } from "vitest";
import {
  backtest,
  countsAsWork,
  estimate,
  MIN_SAMPLES,
  recencyWeight,
  roundEstimate,
  toStatusChanges,
  usableSummary,
  weightedQuantile,
  winsorize,
  workSeconds,
  workStretches,
  type Sample,
  type StatusChange,
  type Target,
} from "./estimate";

const DAY = 86_400_000;
const HOUR = 3600;
const NOW = Date.UTC(2026, 9, 29);

const sample = (over: Partial<Sample> = {}): Sample => ({
  workSeconds: 2 * HOUR,
  type: "Task",
  components: [],
  containerId: 1,
  trackerEstimate: null,
  lastCountedWorklogAt: NOW - DAY,
  similarity: null,
  allWorklogs: false,
  ...over,
});
const many = (n: number, over: Partial<Sample> = {}) => Array.from({ length: n }, () => sample(over));
const target: Target = { type: "Task", components: ["api"], containerId: 1, trackerEstimate: null };

describe("L1 estimates (docs/work/ideas/estimates.md, batch 1)", () => {
  it("weighted quantiles follow their definition", () => {
    // Sorted: 1 (w1), 2 (w1), 3 (w2), 4 (w4); W = 8; C = 1, 2, 4, 8.
    expect(weightedQuantile([4, 1, 3, 2], [4, 1, 2, 1], 0.2)).toBe(2); // first C ≥ 1.6
    expect(weightedQuantile([4, 1, 3, 2], [4, 1, 2, 1], 0.5)).toBe(3); // first C ≥ 4
    expect(weightedQuantile([4, 1, 3, 2], [4, 1, 2, 1], 0.8)).toBe(4); // first C ≥ 6.4
    expect(weightedQuantile([4, 1, 3, 2], [4, 1, 2, 1], 1)).toBe(4);
    expect(() => weightedQuantile([], [], 0.5)).toThrow();
    expect(() => weightedQuantile([1], [1], 0)).toThrow();
    expect(() => weightedQuantile([1], [1], 1.1)).toThrow();
    expect(() => weightedQuantile([1, 2], [1, 0], 0.5)).toThrow();
    expect(() => weightedQuantile([1, 2], [1], 0.5)).toThrow();
  });

  it("winsorizing uses the same recency weights", () => {
    const values = [1, 2, 3, 4, 100];
    // Equal weights: W = 5, 0.95·W = 4.75 is reached only at 100, which stays.
    expect(winsorize(values, [1, 1, 1, 1, 1])).toEqual([1, 2, 3, 4, 100]);
    // The outlier is old (about 598 days, weight ≈ 0.1): W ≈ 4.1, 0.95·W ≈ 3.9 is reached at 4, so 100 → 4.
    const old = recencyWeight(NOW - 598 * DAY, NOW);
    expect(old).toBeCloseTo(0.1, 2);
    expect(winsorize(values, [1, 1, 1, 1, old])).toEqual([1, 2, 3, 4, 4]);
    expect(recencyWeight(NOW - 180 * DAY, NOW)).toBeCloseTo(0.5, 10);
    expect(recencyWeight(NOW + DAY, NOW)).toBe(1);
  });

  it("four samples give no number, five do", () => {
    expect(MIN_SAMPLES).toBe(5);
    expect(estimate(many(4), target, NOW)).toEqual({ none: true, n: 4 });
    const five = estimate(many(5), target, NOW);
    expect(five.none).toBe(false);
    if (!five.none) expect(five.n).toBe(5);
  });

  it("the first tier with five samples is used", () => {
    const t0 = many(4, { similarity: 0.5, components: ["api"] });
    const t1 = many(6, { components: ["api"] });
    const r = estimate([...t0, ...t1], target, NOW);
    expect(r.none).toBe(false);
    if (!r.none) {
      expect(r.tier).toBe(1);
      expect(r.n).toBe(10);
    }
  });

  it("an outlier does not drag the range", () => {
    const usual = Array.from({ length: 19 }, (_, i) => sample({ workSeconds: HOUR + i * 300 }));
    const all = [...usual, sample({ workSeconds: 200 * HOUR })];
    const r = estimate(all, target, NOW);
    expect(r.none).toBe(false);
    if (!r.none) {
      const weights = all.map(s => recencyWeight(s.lastCountedWorklogAt, NOW));
      expect(r.p80).toBeLessThanOrEqual(weightedQuantile(all.map(s => s.workSeconds), weights, 0.95));
      expect(r.p80).toBeLessThan(4 * HOUR);
    }
  });

  it("calibration comes from the chosen tier, its ratios winsorized", () => {
    // In the tier (same project and type): ratio 1.5. Outside it (another project): ratio 3, never used.
    const inTier = many(6, { workSeconds: 3 * HOUR, trackerEstimate: 2 * HOUR });
    const outside = many(6, { containerId: 2, workSeconds: 6 * HOUR, trackerEstimate: 2 * HOUR });
    const r = estimate([...inTier, ...outside], { ...target, trackerEstimate: 4 * HOUR }, NOW);
    expect(r.none).toBe(false);
    if (!r.none) {
      expect(r.tier).toBe(2);
      expect(r.calibration).toEqual({ ratio: 1.5, n: 6, calibrated: 6 * HOUR });
    }
    // One ratio of 30 among 19 of 1.5: winsorized, the ratio stays 1.5.
    const withOutlier = estimate(
      [...many(19, { workSeconds: 3 * HOUR, trackerEstimate: 2 * HOUR }), sample({ workSeconds: 60 * HOUR, trackerEstimate: 2 * HOUR })],
      target,
      NOW
    );
    if (!withOutlier.none) expect(withOutlier.calibration?.ratio).toBe(1.5);
    // Fewer than 5 with an estimate in the tier: no calibration, even with many outside it.
    const few = estimate([...many(4, { trackerEstimate: HOUR }), ...many(2), ...many(9, { containerId: 2, trackerEstimate: HOUR })], target, NOW);
    if (!few.none) {
      expect(few.tier).toBe(2);
      expect(few.calibration).toBeNull();
    }
  });

  it("estimates are rounded to readable steps", () => {
    expect(roundEstimate(HOUR + 7 * 60)).toBe(HOUR + 5 * 60);
    expect(roundEstimate(2 * HOUR + 7 * 60)).toBe(2 * HOUR);
    expect(roundEstimate(60)).toBe(5 * 60);
  });

  it("confidence follows how many and how alike", () => {
    const of = (n: number, over: Partial<Sample>) => {
      const r = estimate(many(n, over), target, NOW);
      return r.none ? "none" : `${r.tier}:${r.confidence}`;
    };
    expect(of(16, { components: ["api"] })).toBe("1:high");
    expect(of(9, {})).toBe("2:medium");
    expect(of(20, { type: "Bug" })).toBe("4:low");
    expect(of(6, { similarity: 0.6 })).toBe("0:low");
  });

  it("an issue with no type matches no type", () => {
    // Target without a type: tiers 1–3 never apply; same project → T4.
    const r1 = estimate(many(8, { type: null }), { ...target, type: null }, NOW);
    if (!r1.none) expect(r1.tier).toBe(4);
    // Samples without a type against a typed target: same.
    const r2 = estimate(many(8, { type: null, containerId: 9 }), target, NOW);
    if (!r2.none) expect(r2.tier).toBe(5);
  });

  it("the backtest counts only the predictions it could make", () => {
    const cases = Array.from({ length: 8 }, (_, i) => ({ ...sample({ workSeconds: HOUR, lastCountedWorklogAt: NOW - (20 - i) * DAY }), target }));
    const r = backtest(cases, NOW);
    expect(r).toMatchObject({ n: 3, skipped: 5 });
    expect(r.mdape).toBe(0);
    expect(r.coverage).toBe(100);
    expect(backtest(cases.slice(0, 4), NOW)).toEqual({ n: 0, skipped: 4, mdape: null, coverage: null });
  });

  it("the backtest never peeks at the future", () => {
    // Five early 1 h issues, a sixth predicted from them, and a 10 h issue worked after all of them.
    const early = Array.from({ length: 6 }, (_, i) => ({ ...sample({ workSeconds: HOUR, lastCountedWorklogAt: NOW - (30 - i) * DAY }), target }));
    const late = { ...sample({ workSeconds: 10 * HOUR, lastCountedWorklogAt: NOW - DAY }), target };
    const r = backtest([late, ...early], NOW);
    // The sixth is predicted from five 1 h issues only: exact. The late one from six 1 h: way off.
    expect(r.n).toBe(2);
    expect(r.coverage).toBe(50);
    expect(r.mdape).toBe((0 + 90) / 2);
  });

  it("stretches include their start and exclude their end", () => {
    const at = (h: number, m = 0, s = 0, ms = 0) => Date.UTC(2026, 9, 20, h, m, s, ms);
    const check = workStretches({
      changes: [
        { at: at(10), ordinal: 0, from: "todo", to: "doing" },
        { at: at(12), ordinal: 1, from: "doing", to: "done" },
      ],
      createdAt: at(9),
      readAt: at(18),
      statusNow: "done",
      classify: id => id === "doing",
      closed: true,
    });
    expect(check).toEqual({ ok: true, stretches: [{ from: at(10), until: at(12) }] });
    if (!check.ok) return;
    expect(workSeconds([{ started: at(10), seconds: 60 }], check.stretches)).toBe(60);
    expect(workSeconds([{ started: at(12), seconds: 60 }], check.stretches)).toBe(0);
    expect(workSeconds([{ started: at(11, 59, 59, 999), seconds: 60 }], check.stretches)).toBe(60);
  });

  it("a tester's reopening counts again, the wait between does not", () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 9, 20, h, m);
    const check = workStretches({
      changes: [
        { at: at(10), ordinal: 0, from: "todo", to: "doing" },
        { at: at(12), ordinal: 1, from: "doing", to: "done" },
        { at: at(14), ordinal: 2, from: "done", to: "doing" },
        { at: at(15), ordinal: 3, from: "doing", to: "done" },
      ],
      createdAt: at(9),
      readAt: at(18),
      statusNow: "done",
      classify: id => id === "doing",
      closed: true,
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.stretches).toEqual([
      { from: at(10), until: at(12) },
      { from: at(14), until: at(15) },
    ]);
    expect(
      workSeconds(
        [
          { started: at(11), seconds: HOUR },
          { started: at(13), seconds: HOUR },
          { started: at(14, 30), seconds: 1800 },
        ],
        check.stretches
      )
    ).toBe(HOUR + 1800);
  });

  it("an incoherent history is refused with its reason", () => {
    const at = (h: number) => Date.UTC(2026, 9, 20, h);
    const base = { createdAt: at(9), readAt: at(18), statusNow: "done", classify: (id: string) => (id === "gone" ? null : id === "doing"), closed: true };
    const reason = (changes: StatusChange[], over: Partial<typeof base> = {}) => {
      const r = workStretches({ ...base, ...over, changes });
      return r.ok ? "ok" : r.reason;
    };
    expect(reason([{ at: at(10), ordinal: 0, from: "todo", to: "doing" }, { at: at(12), ordinal: 1, from: "review", to: "done" }])).toBe("chain");
    expect(reason([{ at: at(8), ordinal: 0, from: "todo", to: "done" }])).toBe("beforeCreation");
    expect(reason([{ at: at(19), ordinal: 0, from: "todo", to: "done" }])).toBe("afterRead");
    expect(reason([{ at: at(10), ordinal: 0, from: "todo", to: "gone" }, { at: at(11), ordinal: 1, from: "gone", to: "done" }])).toBe("unknownStatus");
    expect(reason([{ at: at(10), ordinal: 0, from: "todo", to: "doing" }], { statusNow: "doing" })).toBe("openOnClosed");
    const tooMany = Array.from({ length: 5001 }, (_, i) => ({ at: at(10) + i, ordinal: i, from: i % 2 ? "doing" : "todo", to: i % 2 ? "todo" : "doing" }));
    expect(reason(tooMany, { closed: false })).toBe("tooMany");
    expect(reason([{ at: at(10), ordinal: 0, from: "todo", to: "doing" }, { at: at(12), ordinal: 1, from: "doing", to: "done" }])).toBe("ok");
  });

  it("work statuses default by provider", () => {
    expect(countsAsWork({ category: "doing", hasDoing: true })).toBe(true);
    expect(countsAsWork({ category: "todo", hasDoing: true })).toBe(false);
    expect(countsAsWork({ category: "todo", hasDoing: false })).toBe(true);
    expect(countsAsWork({ category: "done", hasDoing: false })).toBe(false);
    expect(countsAsWork({ category: "cancelled", hasDoing: false })).toBe(false);
    expect(countsAsWork({ category: "doing", hasDoing: true, override: false })).toBe(false);
    expect(countsAsWork({ category: "todo", hasDoing: true, override: true })).toBe(true);
  });

  it("changes at the same instant keep the tracker's order", () => {
    const at = (h: number) => Date.UTC(2026, 9, 20, h);
    const same = at(12);
    // The tracker returns: to In Progress, then (same instant) to Review, then to Done: ordinals in that order.
    const converted = toStatusChanges(
      [
        { sourceOrdinal: 0, at: at(10), from: [{ id: "todo", text: "To Do" }], to: [{ id: "doing", text: "In Progress" }] },
        { sourceOrdinal: 1, at: same, from: [{ id: "doing", text: "In Progress" }], to: [{ id: "review", text: "Review" }] },
        { sourceOrdinal: 2, at: same, from: [{ id: "review", text: "Review" }], to: [{ id: "done", text: "Done" }] },
      ],
      []
    );
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    const changes: StatusChange[] = converted.changes;
    expect(changes.map(c => c.ordinal)).toEqual([0, 1, 2]);
    const run = (list: StatusChange[]) =>
      workStretches({ changes: list, createdAt: at(9), readAt: at(18), statusNow: "done", classify: id => id === "doing" || id === "review", closed: true });
    const expected = { ok: true, stretches: [{ from: at(10), until: same }] };
    expect(run(changes)).toEqual(expected);
    expect(run([changes[2], changes[0], changes[1]])).toEqual(expected);
    expect(run([changes[1], changes[2], changes[0]])).toEqual(expected);
  });

  it("tracker changes become status changes only when unambiguous", () => {
    const statuses = [
      { id: "1", name: "To Do" },
      { id: "3", name: "In Progress" },
      { id: "4", name: "Review" },
      { id: "5", name: "Review" },
    ];
    const at = Date.UTC(2026, 9, 20, 10);
    // `from` empty → null; one value → its id; the ordinal is the tracker's order.
    expect(toStatusChanges([{ sourceOrdinal: 0, at, from: [], to: [{ id: "3", text: "In Progress" }] }], statuses)).toEqual({
      ok: true,
      changes: [{ at, ordinal: 0, from: null, to: "3" }],
    });
    expect(
      toStatusChanges(
        [
          // Indices 0 and 2 of the complete changelog (index 1 was another field): picking never renumbers.
          { sourceOrdinal: 0, at, from: [{ id: "1", text: "To Do" }], to: [{ id: "3", text: "In Progress" }] },
          { sourceOrdinal: 2, at, from: [{ text: "In Progress" }], to: [{ text: "To Do" }] },
        ],
        statuses
      )
    ).toEqual({ ok: true, changes: [{ at, ordinal: 0, from: "1", to: "3" }, { at, ordinal: 2, from: "3", to: "1" }] });
    const bad = { ok: false, reason: "ambiguousChange" };
    expect(toStatusChanges([{ sourceOrdinal: 0, at, from: [{ id: "1", text: "To Do" }], to: [] }], statuses)).toEqual(bad);
    expect(toStatusChanges([{ sourceOrdinal: 0, at, from: [{ id: "1", text: "To Do" }], to: [{ id: "3", text: "a" }, { id: "4", text: "b" }] }], statuses)).toEqual(bad);
    expect(toStatusChanges([{ sourceOrdinal: 0, at, from: [{ id: "1", text: "a" }, { id: "3", text: "b" }], to: [{ id: "4", text: "c" }] }], statuses)).toEqual(bad);
    // No id: the name must match exactly one status ("Review" matches two, "Gone" none).
    expect(toStatusChanges([{ sourceOrdinal: 0, at, from: [{ text: "To Do" }], to: [{ text: "Review" }] }], statuses)).toEqual(bad);
    expect(toStatusChanges([{ sourceOrdinal: 0, at, from: [{ text: "To Do" }], to: [{ text: "Gone" }] }], statuses)).toEqual(bad);
  });

  it("an unknown first status makes the history invalid", () => {
    const at = (h: number) => Date.UTC(2026, 9, 20, h);
    const base = { createdAt: at(9), readAt: at(18), statusNow: "done", classify: (id: string) => id === "doing", closed: true };
    expect(workStretches({ ...base, changes: [{ at: at(10), ordinal: 0, from: null, to: "done" }] })).toEqual({ ok: false, reason: "noInitialStatus" });
    expect(
      workStretches({
        ...base,
        changes: [
          { at: at(10), ordinal: 0, from: "todo", to: "doing" },
          { at: at(12), ordinal: 1, from: null, to: "done" },
        ],
      })
    ).toEqual({ ok: false, reason: "chain" });
    // No changes at all: the status at creation is the current one, and that is proven.
    expect(workStretches({ ...base, changes: [], statusNow: "done" })).toEqual({ ok: true, stretches: [] });
  });

  it("titles too short to compare never make tier 0", () => {
    expect(usableSummary(null)).toBe(false);
    expect(usableSummary(undefined)).toBe(false);
    expect(usableSummary("")).toBe(false);
    expect(usableSummary("   ")).toBe(false);
    expect(usableSummary(" ab ")).toBe(false);
    expect(usableSummary("abc")).toBe(true);
    // A null similarity (a title not usable on either side) never makes T0, however many samples.
    const r = estimate(many(10, { similarity: null }), target, NOW);
    if (!r.none) expect(r.tier).not.toBe(0);
  });

  it("a history must end in the issue's current status", () => {
    const at = (h: number) => Date.UTC(2026, 9, 20, h);
    const changes: StatusChange[] = [
      { at: at(10), ordinal: 0, from: "todo", to: "doing" },
      { at: at(12), ordinal: 1, from: "doing", to: "done" },
      { at: at(14), ordinal: 2, from: "done", to: "doing" },
    ];
    const base = { createdAt: at(9), readAt: at(18), classify: (id: string) => id === "doing", closed: false };
    // Ends in In Progress while the issue is Done now: the history is not the issue's.
    expect(workStretches({ ...base, changes, statusNow: "done" })).toEqual({ ok: false, reason: "currentStatusMismatch" });
    // Ending where the issue is: valid, the last stretch still open.
    expect(workStretches({ ...base, changes, statusNow: "doing" })).toEqual({
      ok: true,
      stretches: [
        { from: at(10), until: at(12) },
        { from: at(14), until: null },
      ],
    });
  });

  it("cases worked at the same instant never train on one another", () => {
    // Five 1 h issues earlier, then two at the very same instant: one of 1 h, one of 10 h.
    const early = Array.from({ length: 5 }, (_, i) => ({ ...sample({ workSeconds: HOUR, lastCountedWorklogAt: NOW - (30 - i) * DAY }), target }));
    const same = NOW - 2 * DAY;
    const a = { ...sample({ workSeconds: HOUR, lastCountedWorklogAt: same }), target };
    const b = { ...sample({ workSeconds: 10 * HOUR, lastCountedWorklogAt: same }), target };
    const forward = backtest([...early, a, b], NOW);
    const reversed = backtest([...early, b, a], NOW);
    expect(forward).toEqual(reversed);
    // Both predicted from the five earlier 1 h issues only: a exact (0%), b 90% off; neither saw the other.
    expect(forward).toEqual({ n: 2, skipped: 5, mdape: 45, coverage: 50 });
  });
});
