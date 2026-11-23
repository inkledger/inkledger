import { describe, expect, it } from "vitest";
import { ENABLED_HOLD_MS, createEnabledSignals } from "./enabledSignals";
import type { AnchorEl } from "./sandbox/anchors";

const card: AnchorEl = { getBoundingClientRect: () => ({ left: 10, top: 20, right: 210, bottom: 220 }), getAttribute: () => null };

describe("a module switched on from its Store card", () => {
  it("told before its frames listen (they are being made): heard once by the first, if recent", () => {
    let now = 0;
    const s = createEnabledSignals(() => now);
    s.tell("kanbunny", () => card);
    now = ENABLED_HOLD_MS - 1;
    const got: (AnchorEl | null)[] = [];
    s.subscribe("kanbunny", c => got.push(c));
    s.subscribe("kanbunny", c => got.push(c));
    expect(got).toHaveLength(1);
    expect(got[0]?.getBoundingClientRect()).toEqual(card.getBoundingClientRect());
  });

  it("frames already listening hear it at once; another module never does", () => {
    const s = createEnabledSignals(() => 0);
    const mine: unknown[] = [];
    const other: unknown[] = [];
    s.subscribe("kanbunny", c => mine.push(c));
    s.subscribe("bonsai", c => other.push(c));
    s.tell("kanbunny", () => card);
    expect(mine).toHaveLength(1);
    expect(other).toHaveLength(0);
    // Not held again for a later frame.
    s.subscribe("kanbunny", c => mine.push(c));
    expect(mine).toHaveLength(1);
  });

  it("an old word is dropped (frames made long after are no answer to that switch)", () => {
    let now = 0;
    const s = createEnabledSignals(() => now);
    s.tell("kanbunny", () => card);
    now = ENABLED_HOLD_MS + 1;
    const got: unknown[] = [];
    s.subscribe("kanbunny", c => got.push(c));
    expect(got).toHaveLength(0);
  });

  it("the card measured when heard: gone from the page, nothing to point at", () => {
    const s = createEnabledSignals(() => 0);
    let shown: AnchorEl | null = card;
    s.tell("kanbunny", () => shown);
    shown = null;
    const got: AnchorEl[] = [];
    s.subscribe("kanbunny", c => c && got.push(c));
    expect(got[0]?.getBoundingClientRect()).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
});
