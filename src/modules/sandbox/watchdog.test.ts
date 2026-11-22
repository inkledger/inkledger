import { describe, expect, it } from "vitest";
import { budgetOfStep, createLadder, TICK_MS, type Step } from "./watchdog";

function setup() {
  let t = 0;
  const steps: [string, Step][] = [];
  const ladder = createLadder({ now: () => t, onStep: (id, s) => steps.push([id, s]) });
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

  it("holds the module to its budget: reduce, then a still picture from there on", () => {
    expect((["normal", "warn", "reduce", "still", "paused", "killed"] as const).map(budgetOfStep)).toEqual(["normal", "normal", "reduce", "still", "still", "still"]);
  });

  it("a frame whose beats stop is late, and steps down without reporting anything", () => {
    const { ladder, steps, second } = setup();
    ladder.frame("stuck", "view");
    for (let i = 0; i < 8; i++) second();
    expect(steps.map(([, s]) => s)).toEqual(["warn", "reduce", "still", "paused", "killed"]);
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
