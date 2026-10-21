import { describe, it, expect } from "vitest";
import { startOfDay, wallHours } from "@contracts/time";

describe("wallHours", () => {
  it("reads the clock, not the elapsed time, on DST change days", () => {
    for (const day of [new Date(2026, 9, 25), new Date(2027, 2, 28), new Date(2026, 9, 15)]) {
      const midnight = startOfDay(day).getTime();
      const nine = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 30).getTime();
      expect(wallHours(nine, midnight)).toBe(9.5);
    }
  });
});
