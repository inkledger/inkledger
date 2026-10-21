import { describe, it, expect } from "vitest";
import { dayKey } from "@contracts/time";
import { periodRange, shiftPeriod } from "./usePeriod";

const d = (s: string) => new Date(`${s}T12:00:00`);

describe("periodRange", () => {
  it("follows today when no anchor is set", () => {
    const before = periodRange("day", null, d("2026-10-12"));
    const after = periodRange("day", null, d("2026-10-13"));
    expect(dayKey(before.from)).toBe("2026-10-12");
    expect(dayKey(after.from)).toBe("2026-10-13");
    expect(after.isCurrent).toBe(true);
  });

  it("keeps a period picked by hand after midnight", () => {
    const anchor = d("2026-10-11");
    const r = periodRange("day", anchor, d("2026-10-13"));
    expect(dayKey(r.from)).toBe("2026-10-11");
    expect(r.isCurrent).toBe(false);
  });

  it("weeks start on Monday, months on the 1st", () => {
    const w = periodRange("week", d("2026-10-15"), d("2026-10-15"));
    expect(dayKey(w.from)).toBe("2026-10-12");
    expect(w.days).toHaveLength(7);
    const m = periodRange("month", null, d("2026-02-10"));
    expect(dayKey(m.from)).toBe("2026-02-01");
    expect(m.days).toHaveLength(28);
  });
});

describe("shiftPeriod", () => {
  it("moves by days, weeks and months", () => {
    expect(dayKey(shiftPeriod("day", d("2026-10-01"), -1))).toBe("2026-09-30");
    expect(dayKey(shiftPeriod("week", d("2026-10-12"), 1))).toBe("2026-10-19");
    expect(dayKey(shiftPeriod("month", new Date(2026, 0, 1), 1))).toBe("2026-02-01");
  });
});
