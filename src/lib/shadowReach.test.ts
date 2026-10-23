import { describe, expect, it } from "vitest";
import { reachOf } from "./shadowReach";

describe("how far a shadow reaches (room for the Shadow mod)", () => {
  it("the widest layer per side: offset, blur and spread", () => {
    // As the mod writes --sh-1: a contact shadow, then the cast one, the sun low on the left.
    expect(reachOf("0.45px 1px 1px 0 hsl(var(--shadow-color) / 0.14), 3px 6px 8px -1px hsl(var(--shadow-color) / 0.2)")).toEqual({ l: 4, r: 10, t: 1, b: 13 });
    // Light from below-right: the shadow falls up and left.
    expect(reachOf("-4px -2px 10px -1px hsl(0 0% 0% / 0.3)")).toEqual({ l: 13, r: 5, t: 11, b: 7 });
  });

  it("nothing for no shadow, inset layers, or what can't be read", () => {
    expect(reachOf("")).toEqual({ l: 0, r: 0, t: 0, b: 0 });
    expect(reachOf("0 0 #0000")).toEqual({ l: 0, r: 0, t: 0, b: 0 });
    expect(reachOf("none")).toEqual({ l: 0, r: 0, t: 0, b: 0 });
    expect(reachOf("inset 0 1px 0 hsl(0 0% 100% / 0.85)")).toEqual({ l: 0, r: 0, t: 0, b: 0 });
    expect(reachOf("var(--sh-1)")).toEqual({ l: 0, r: 0, t: 0, b: 0 });
  });
});
