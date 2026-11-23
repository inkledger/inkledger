import { describe, expect, it } from "vitest";
import { createFrameBudget, FRAME_BUDGET, MODULE_VIEWS } from "./budget";

describe("the frame budget", () => {
  it("six modules framed at once (a runtime and two views each) fit", () => {
    const b = createFrameBudget();
    for (let m = 0; m < 6; m++) expect([b.take("runtime", `m${m}`), b.take("view", `m${m}`), b.take("view", `m${m}`)]).toEqual([true, true, true]);
  });

  it("views and runtimes are counted apart: views never take a runtime's place", () => {
    const b = createFrameBudget();
    for (let i = 0; i < FRAME_BUDGET.view; i++) expect(b.take("view", `m${i % 4}`)).toBe(true);
    expect(b.take("view", "m9")).toBe(false);
    expect(b.take("runtime", "m0")).toBe(true);
    b.give("view", "m0");
    expect(b.take("view", "m9")).toBe(true);
  });

  it("one module never takes the others' views: it has its own share", () => {
    const b = createFrameBudget();
    for (let i = 0; i < MODULE_VIEWS; i++) expect(b.take("view", "greedy")).toBe(true);
    expect(b.take("view", "greedy")).toBe(false);
    expect(b.take("view", "other")).toBe(true);
    b.give("view", "greedy");
    expect(b.take("view", "greedy")).toBe(true);
  });

  it("a parked frame (its cleanup still running) never lets live frames pass the cap: the oldest goes first, the module's own", () => {
    const b = createFrameBudget({ view: 3, runtime: 1 });
    const ended: string[] = [];
    for (const m of ["a", "a", "b"]) expect(b.take("view", m)).toBe(true);
    b.park("view", "a", () => ended.push("a1"));
    b.park("view", "b", () => ended.push("b1"));
    b.park("view", "a", () => ended.push("a2"));
    // A remount still gets its frame: a parked one goes now instead.
    expect(b.take("view", "b")).toBe(true);
    expect(ended).toEqual(["b1"]);
    expect(b.take("view", "c")).toBe(true);
    expect(ended).toEqual(["b1", "a1"]);
    // One that ended by itself is no longer counted.
    const release = b.park("runtime", "a", () => ended.push("r"));
    release();
    expect(b.take("runtime", "b")).toBe(true);
    expect(ended).toEqual(["b1", "a1"]);
  });

  it("a module's parked views count in its own share", () => {
    const b = createFrameBudget();
    const ended: number[] = [];
    for (let i = 0; i < MODULE_VIEWS; i++) expect(b.take("view", "m")).toBe(true);
    for (let i = 0; i < MODULE_VIEWS; i++) b.park("view", "m", () => ended.push(i));
    expect(b.take("view", "m")).toBe(true);
    expect(ended).toEqual([0]);
  });
});
