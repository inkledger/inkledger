import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDataColoursCache } from "@/lib/dataColors";
import { typeSeries } from "./typeSeries";

describe("issue types as chart series", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    resetDataColoursCache();
  });

  it("gives hues to real types only: no type is a neutral, takes no slot, and stacks after them", () => {
    const s = typeSeries([
      { type: "", seconds: 9000 },
      { type: "Bug", seconds: 3600 },
      { type: "Attività", seconds: 1800 },
    ]);
    const none = s.keyOf("");
    expect(s.colourOf(none).fill).toBe("bg-data-none");
    expect(s.colourOf(none).slot).toBe(0);
    expect(s.colourOf(s.keyOf("Bug")).slot).toBe(1);
    expect(s.colourOf(s.keyOf("Attività")).slot).toBe(2);
    expect(s.order).toEqual(["Bug", "Attività", none]);
  });

  it("sums types past the eighth as Other, in its own neutral, last", () => {
    const types = Array.from({ length: 10 }, (_, i) => ({ type: `T${i}`, seconds: 1000 - i }));
    const s = typeSeries([...types, { type: "", seconds: 1 }]);
    const other = s.keyOf("T9");
    expect(s.keyOf("T8")).toBe(other);
    expect(s.colourOf(other).fill).toBe("bg-data-other");
    expect(s.order.at(-1)).toBe(other);
    expect(s.order.at(-2)).toBe(s.keyOf(""));
    expect(s.legend.find(l => l.key === other)?.seconds).toBe(992 + 991);
  });
});
