import { beforeEach, describe, expect, it, vi } from "vitest";
import { assignColours, colourFor, DATA_SLOTS, OTHER_COLOUR, resetDataColoursCache } from "./dataColors";

describe("data colours", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    resetDataColoursCache();
  });

  it("gives up to eight categories eight different colours", () => {
    const types = ["Bug", "Task", "Story", "Epic", "Sub-task", "Improvement", "Attività", "Storia"];
    const slots = types.map((t, i) => colourFor(t, i).slot);
    expect(new Set(slots).size).toBe(DATA_SLOTS);
    expect(slots.every(s => s >= 1 && s <= DATA_SLOTS)).toBe(true);
  });

  it("keeps a category's colour whatever the order, the period or the page", () => {
    const first = assignColours(["Bug", "Task", "Story"]);
    const reordered = assignColours(["Story", "Epic", "Bug", "Task"]);
    expect(reordered.get("Bug")).toEqual(first.get("Bug"));
    expect(reordered.get("Story")).toEqual(first.get("Story"));
    expect(colourFor("Task", 3)).toEqual(first.get("Task"));
    // Case and spaces don't make a new category.
    expect(colourFor(" bug")).toEqual(first.get("Bug"));
  });

  it("survives a reload (saved on this device)", () => {
    const bug = colourFor("Bug");
    colourFor("Task");
    resetDataColoursCache();
    expect(colourFor("Task").slot).not.toBe(bug.slot);
    expect(colourFor("Bug")).toEqual(bug);
  });

  it("keeps dimensions apart: a project named like a type has its own slot", () => {
    colourFor("Bug", 0, "type");
    colourFor("Task", 1, "type");
    expect(colourFor("Alpha", 0, "project").slot).toBe(1);
  });

  it("sums a ninth series as Other, never a new hue", () => {
    const keys = Array.from({ length: 10 }, (_, i) => `T${i}`);
    const map = assignColours(keys);
    expect(map.get("T8")).toEqual(OTHER_COLOUR);
    expect(map.get("T9")).toEqual(OTHER_COLOUR);
    expect(colourFor("T9", 9)).toEqual(OTHER_COLOUR);
  });

  it("a full palette makes room from keys the chart doesn't draw, never from the ones it does", () => {
    assignColours(Array.from({ length: 8 }, (_, i) => `Old${i}`));
    const drawn = assignColours(["Old0", "New", "Old1"]);
    const slots = [...drawn.values()].map(c => c.slot);
    expect(new Set(slots).size).toBe(3);
    expect(drawn.get("Old0")?.slot).toBe(1);
    expect(drawn.get("Old1")?.slot).toBe(2);
  });

  it("offers literal Tailwind classes and a texture for every slot but the first", () => {
    const all = assignColours(Array.from({ length: 8 }, (_, i) => `K${i}`));
    for (const c of all.values()) {
      expect(c.fill).toBe(`bg-data-${c.slot}`);
      expect(c.texture).toBe(c.slot === 1 ? "" : `data-texture-${c.slot}`);
    }
  });
});
