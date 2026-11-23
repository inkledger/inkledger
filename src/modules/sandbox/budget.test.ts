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
});
