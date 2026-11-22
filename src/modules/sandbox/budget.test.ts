import { describe, expect, it } from "vitest";
import { createFrameBudget, FRAME_BUDGET } from "./budget";

describe("the frame budget", () => {
  it("six modules framed at once (a runtime and two views each) fit", () => {
    const b = createFrameBudget();
    for (let m = 0; m < 6; m++) expect([b.take("runtime"), b.take("view"), b.take("view")]).toEqual([true, true, true]);
  });

  it("views and runtimes are counted apart: views never take a runtime's place", () => {
    const b = createFrameBudget();
    for (let i = 0; i < FRAME_BUDGET.view; i++) expect(b.take("view")).toBe(true);
    expect(b.take("view")).toBe(false);
    expect(b.take("runtime")).toBe(true);
    b.give("view");
    expect(b.take("view")).toBe(true);
  });
});
