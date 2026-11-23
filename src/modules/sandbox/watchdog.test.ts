import { describe, expect, it } from "vitest";
import { budgetOfStep, createLadder, STEPS, TICK_MS, type Step } from "./watchdog";

function setup(o: { judgeLag?: boolean } = {}) {
  let t = 0;
  const steps: [string, Step][] = [];
  const ladder = createLadder({ now: () => t, onStep: (id, s) => steps.push([id, s]), ...o });
  // One second: beats from the frames that beat, then the tick.
  const second = (beats: { frame: ReturnType<typeof ladder.frame>; busy?: number }[] = [], lag = 0) => {
    for (const half of [TICK_MS / 2, TICK_MS / 2]) {
      t += half;
      beats.forEach(b => b.frame.beat((b.busy ?? 0) / 2));
    }
    ladder.tick(lag);
  };
  return { ladder, steps, second, at: () => t };
}

describe("the watchdog's ladder", () => {
  it("steps a busy module down one step per bad second, to stopped", () => {
    const { ladder, steps, second } = setup();
    const hog = ladder.frame("hog", "view");
    second([{ frame: hog, busy: 600 }]);
    second([{ frame: hog, busy: 600 }]);
    expect(steps).toEqual([]); // startup is not judged
    for (let i = 0; i < 5; i++) second([{ frame: hog, busy: 600 }]);
    expect(steps.map(([, s]) => s)).toEqual(["warn", "reduce", "still", "paused", "killed"]);
    second([{ frame: hog, busy: 600 }]);
    expect(steps).toHaveLength(5);
  });

  it("counts a flood in ticks: they run late under it, three in a row stop it however long the page took", () => {
    let t = 0;
    const l = createLadder({ now: () => t, onStep: () => {} });
    const f = l.frame("flood", "view");
    for (let i = 0; i < 3; i++) {
      t += 5000;
      f.beat(0);
      f.flood();
      l.tick(0);
    }
    expect(l.step("flood")).toBe("killed");
  });

  it("holds a frame flooding the page to reduce at once, and stops it if it keeps on", () => {
    const { ladder, steps, second } = setup();
    const f = ladder.frame("flood", "view");
    const other = ladder.frame("other", "view");
    second([{ frame: f }, { frame: other }]);
    second([{ frame: f }, { frame: other }]);
    f.flood();
    second([{ frame: f }, { frame: other }]);
    expect(ladder.step("flood")).toBe("reduce");
    second([{ frame: f }, { frame: other }]);
    f.flood();
    second([{ frame: f }, { frame: other }]);
    expect(ladder.step("flood")).toBe("reduce");
    f.flood();
    second([{ frame: f }, { frame: other }]);
    expect(ladder.step("flood")).toBe("killed");
    expect(steps.filter(([id]) => id === "other")).toEqual([]);
  });

  it("holds the module to its budget: reduce, then a still picture from there on", () => {
    expect((["normal", "warn", "reduce", "still", "paused", "killed"] as const).map(budgetOfStep)).toEqual(["normal", "normal", "reduce", "still", "still", "still"]);
  });

  it("a frame whose beats stop is late: asked to reduce, never stopped on lateness alone (nothing says it's the one)", () => {
    const { ladder, steps, second } = setup();
    ladder.frame("stuck", "view");
    for (let i = 0; i < 20; i++) second();
    expect(steps.map(([, s]) => s)).toEqual(["warn", "reduce"]);
  });

  it("one module stalling the frames' shared process never gets the others stopped", () => {
    const { ladder, second } = setup();
    const hog = ladder.frame("hog", "view");
    const victim = ladder.frame("victim", "view");
    // Both beat once in five seconds, neither says it was busy.
    for (let i = 0; i < 30; i++) second(i % 5 === 4 ? [{ frame: hog }, { frame: victim }] : []);
    expect(STEPS.indexOf(ladder.step("victim"))).toBeLessThanOrEqual(STEPS.indexOf("reduce"));
    expect(ladder.step("hog")).not.toBe("killed");
  });

  it("the page's own work on a module's calls is the module's: judged even while the page lags", () => {
    const { ladder, steps, second } = setup({ judgeLag: true });
    const hog = ladder.frame("hog", "view");
    const victim = ladder.frame("victim", "view");
    second([{ frame: hog }, { frame: victim }]);
    second([{ frame: hog }, { frame: victim }]);
    for (let i = 0; i < 6; i++) {
      hog.hostWork(400);
      second([{ frame: hog }, { frame: victim }], 900);
    }
    expect(ladder.step("hog")).toBe("killed");
    expect(steps.filter(([id]) => id === "victim")).toEqual([]);

    expect(ladder.step("hog")).toBe("killed");
    expect(steps.filter(([id]) => id === "victim")).toEqual([]);
  });

  it("one heavy second of host work (a module starting) is no habit", () => {
    const { ladder, steps, second } = setup();
    const f = ladder.frame("m", "view");
    second([{ frame: f }]);
    second([{ frame: f }]);
    f.hostWork(400);
    second([{ frame: f }]);
    for (let i = 0; i < 5; i++) second([{ frame: f }]);
    expect(steps).toEqual([]);
  });

  it("a module at its full legal rate of host work is never struck", () => {
    const { ladder, steps, second } = setup({ judgeLag: true });
    const f = ladder.frame("kanbunny", "view");
    for (let i = 0; i < 30; i++) {
      f.hostWork(120);
      second([{ frame: f }]);
    }
    expect(steps).toEqual([]);
  });

  it("where frames share the page's thread (no long-task data), a page that keeps lagging asks its modules to reduce", () => {
    const { ladder, second } = setup({ judgeLag: true });
    const hog = ladder.frame("hog", "view");
    const victim = ladder.frame("victim", "view");
    for (let i = 0; i < 30; i++) second([{ frame: hog }, { frame: victim }], 900);
    expect(ladder.step("hog")).toBe("reduce");
    expect(ladder.step("victim")).toBe("reduce");
    // A sleep (one long gap) says nothing.
    const s = setup({ judgeLag: true });
    const m = s.ladder.frame("m", "view");
    s.second([{ frame: m }]);
    s.second([{ frame: m }]);
    s.second([{ frame: m }], 60_000);
    s.second([{ frame: m }]);
    expect(s.steps).toEqual([]);
  });

  it("spares a module stalled by another one's long tasks (they share a process)", () => {
    const { ladder, steps, second } = setup();
    const hog = ladder.frame("hog", "view");
    const victim = ladder.frame("victim", "view");
    second([{ frame: hog }, { frame: victim }]);
    second([{ frame: hog }, { frame: victim }]);
    // The hog's loop holds both: neither beats, the hog says why afterwards.
    for (let i = 0; i < 2; i++) second();
    for (let i = 0; i < 6; i++) second([{ frame: hog, busy: 900 }]);
    expect(steps.filter(([id]) => id === "victim")).toEqual([]);
    expect(ladder.step("hog")).toBe("killed");
  });

  it("judges no lateness while the host itself ran late (its own jank, a sleep)", () => {
    const { ladder, steps, second } = setup();
    ladder.frame("m", "view");
    for (let i = 0; i < 8; i++) second([], 400);
    expect(steps).toEqual([]);
  });

  it("judges no lateness off screen, and gives a frame back on screen time to catch up", () => {
    const { ladder, steps, second } = setup();
    const f = ladder.frame("m", "view");
    f.suspend(true);
    for (let i = 0; i < 6; i++) second();
    f.suspend(false);
    second();
    expect(steps).toEqual([]);
    second([{ frame: f }]);
    second([{ frame: f }]);
    expect(steps).toEqual([]);
  });

  it("still counts a module's own long tasks off screen: they cost the page all the same", () => {
    const { ladder, second } = setup();
    const f = ladder.frame("m", "view");
    second([{ frame: f }]);
    second([{ frame: f }]);
    f.suspend(true);
    second([{ frame: f, busy: 300 }]);
    expect(ladder.step("m")).toBe("warn");
  });

  it("lets a runtime frame, never on screen, beat more slowly", () => {
    const { ladder, steps, second } = setup();
    const r = ladder.frame("m", "runtime");
    for (let i = 0; i < 12; i++) second(i % 3 === 0 ? [{ frame: r }] : []);
    expect(steps).toEqual([]);
  });

  it("steps a module back up after ten clean seconds", () => {
    const { ladder, steps, second } = setup();
    const f = ladder.frame("m", "view");
    second([{ frame: f }]);
    second([{ frame: f }]);
    second([{ frame: f, busy: 100 }]);
    second([{ frame: f, busy: 100 }]);
    expect(ladder.step("m")).toBe("reduce");
    for (let i = 0; i < 9; i++) second([{ frame: f }]);
    expect(ladder.step("m")).toBe("reduce");
    second([{ frame: f }]);
    expect(ladder.step("m")).toBe("warn");
    for (let i = 0; i < 10; i++) second([{ frame: f }]);
    expect(steps.map(([, s]) => s)).toEqual(["warn", "reduce", "warn", "normal"]);
  });

  it("forgets nothing when a module's frames go and come back (a route change)", () => {
    const { ladder, second } = setup();
    const f = ladder.frame("m", "view");
    second([{ frame: f }]);
    second([{ frame: f }]);
    second([{ frame: f, busy: 100 }]);
    f.dispose();
    for (let i = 0; i < 20; i++) second();
    expect(ladder.step("m")).toBe("warn");
  });
});
