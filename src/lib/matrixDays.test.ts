import { describe, expect, it } from "vitest";
import { dayKey } from "@contracts/time";
import { matrixDays } from "./matrixDays";

describe("matrixDays", () => {
  it("fills every day between the first and the last, in order", () => {
    const keys = matrixDays([{ day: "2026-11-05" }, { day: "2026-11-02" }]).map(dayKey);
    expect(keys).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
  });
  it("crosses a DST change without a missing or doubled day", () => {
    const keys = matrixDays([{ day: "2026-10-24" }, { day: "2026-10-27" }]).map(dayKey);
    expect(keys).toEqual(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]);
  });
  it("is empty with no days", () => expect(matrixDays([])).toEqual([]));
});
