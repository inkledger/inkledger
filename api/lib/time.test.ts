import { describe, it, expect } from "vitest";
import {
  parseDurationToSeconds,
  formatSeconds,
  formatHours,
  formatDurationLong,
  formatDuration,
  formatDate,
  idleGap,
  findGaps,
  formatHMS,
  toJiraStarted,
  dayKey,
  parseDayKey,
  startOfWeek,
  weekStartKey,
  addDays,
  toLocalInputValue,
} from "@contracts/time";

describe("parseDurationToSeconds", () => {
  it("parses plain hours", () => {
    expect(parseDurationToSeconds("2")).toBe(7200);
    expect(parseDurationToSeconds("1.5")).toBe(5400);
  });

  it("parses Jira-style units", () => {
    expect(parseDurationToSeconds("45m")).toBe(2700);
    expect(parseDurationToSeconds("2h")).toBe(7200);
    expect(parseDurationToSeconds("1d")).toBe(8 * 3600);
    expect(parseDurationToSeconds("1w")).toBe(5 * 8 * 3600);
  });

  it("parses composite durations", () => {
    expect(parseDurationToSeconds("2h 30m")).toBe(9000);
    expect(parseDurationToSeconds("1w 2d 3h 4m")).toBe(
      5 * 8 * 3600 + 2 * 8 * 3600 + 3 * 3600 + 4 * 60,
    );
    expect(parseDurationToSeconds("1h30m")).toBe(5400);
  });

  it("is case-insensitive", () => {
    expect(parseDurationToSeconds("2H 30M")).toBe(9000);
  });

  it("accepts the Italian decimal comma", () => {
    expect(parseDurationToSeconds("1.5h")).toBe(5400);
    expect(parseDurationToSeconds("1,5")).toBe(5400);
    expect(parseDurationToSeconds("0,25d")).toBe(2 * 3600);
  });

  it("reads a bare number after hours as minutes", () => {
    expect(parseDurationToSeconds("2h30")).toBe(9000);
    expect(parseDurationToSeconds("2h 30")).toBe(9000);
    expect(parseDurationToSeconds("1d 2h15")).toBe(8 * 3600 + 2 * 3600 + 15 * 60);
    expect(parseDurationToSeconds("2m30")).toBeNull();
  });

  it("rejects invalid input", () => {
    expect(parseDurationToSeconds("1,5,5")).toBeNull();
    expect(parseDurationToSeconds("")).toBeNull();
    expect(parseDurationToSeconds("abc")).toBeNull();
    expect(parseDurationToSeconds("2x")).toBeNull();
    expect(parseDurationToSeconds("h")).toBeNull();
    expect(parseDurationToSeconds("2h garbage")).toBeNull();
  });
});

describe("formatSeconds", () => {
  it("formats compact durations", () => {
    expect(formatSeconds(0)).toBe("0m");
    expect(formatSeconds(2700)).toBe("45m");
    expect(formatSeconds(7200)).toBe("2h");
    expect(formatSeconds(9000)).toBe("2h 30m");
    expect(formatSeconds(8 * 3600)).toBe("1d");
    expect(formatSeconds(5 * 8 * 3600 + 3600)).toBe("1w 1h");
  });

  it("round-trips with parseDurationToSeconds", () => {
    const values = [600, 3600, 9000, 8 * 3600 + 1800, 5 * 8 * 3600];
    for (const v of values) {
      expect(parseDurationToSeconds(formatSeconds(v))).toBe(v);
    }
  });
});

describe("formatHours", () => {
  it("formats decimal hours", () => {
    expect(formatHours(3600)).toBe("1h");
    expect(formatHours(5400)).toBe("1.5h");
  });
});

describe("toJiraStarted", () => {
  it("produces the Jira worklog format with numeric offset", () => {
    const d = new Date(2026, 6, 20, 14, 30, 5); // local time
    const out = toJiraStarted(d);
    expect(out).toMatch(/^2026-07-20T14:30:05\.000[+-]\d{4}$/);
  });
});

describe("local calendar helpers (Europe/Rome)", () => {
  it("runs in the Docker time zone", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Europe/Rome");
  });

  it("dayKey uses the local day, not UTC", () => {
    // 23:30 UTC on Oct 14 is already Oct 15 in Rome (UTC+2)
    expect(dayKey(new Date("2026-10-14T23:30:00Z"))).toBe("2026-10-15");
  });

  it("parseDayKey round-trips and rejects invalid dates", () => {
    expect(dayKey(parseDayKey("2026-03-29")!)).toBe("2026-03-29");
    expect(parseDayKey("2026-02-30")).toBeNull();
    expect(parseDayKey("2026-10-15T00:00")).toBeNull();
  });

  it("week starts on local Monday across DST changes", () => {
    // DST ends Sun 2026-10-25, begins Sun 2026-03-29
    expect(weekStartKey(new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-26");
    expect(weekStartKey(new Date("2026-10-25T10:00:00Z"))).toBe("2026-10-19");
    expect(weekStartKey(new Date("2026-03-29T12:00:00Z"))).toBe("2026-03-23");
    expect(startOfWeek(new Date("2026-03-30T08:00:00Z")).getHours()).toBe(0);
  });

  it("addDays keeps local midnight across DST", () => {
    const d = addDays(parseDayKey("2026-10-24")!, 2);
    expect(dayKey(d)).toBe("2026-10-26");
    expect(d.getHours()).toBe(0);
  });

  it("toLocalInputValue formats local time", () => {
    expect(toLocalInputValue(new Date("2026-07-01T07:05:00Z"))).toBe("2026-07-01T09:05");
  });
});

describe("long and clock formats", () => {
  it("formatDuration: one display format, large totals in whole hours", () => {
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(8460)).toBe("2 h 21 min");
    expect(formatDuration(1200)).toBe("20 min");
    expect(formatDuration(2556.2 * 3600)).toBe("2,556 h");
    expect(formatDuration(12_000 * 3600)).toBe("12,000 h");
  });

  it("formatDate: short and long calendar dates", () => {
    const d = new Date(2026, 9, 5);
    expect(formatDate(d, "short")).toBe("5 Oct 2026");
    expect(formatDate(d, "long")).toBe("5 October 2026");
  });

  it("idleGap: only away periods past the threshold", () => {
    const now = 10_000_000;
    expect(idleGap(now - 9 * 60_000, now, 10)).toBe(0);
    expect(idleGap(now - 25 * 60_000, now, 10)).toBe(1500);
    expect(idleGap(now - 25 * 60_000, now, 0)).toBe(0);
  });

  it("findGaps: free stretches between logged spans", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 15, h, m);
    const spans = [
      { start: at(10), seconds: 3600 }, // 10-11
      { start: at(10, 30), seconds: 3600 }, // overlaps, 10:30-11:30
      { start: at(13), seconds: 1200 }, // 13:00-13:20
      { start: at(13, 40), seconds: 600 }, // 13:40-13:50 (20 min gap: ignored)
    ];
    expect(findGaps(spans, at(9), at(15))).toEqual([
      { start: at(9), seconds: 3600 },
      { start: at(11, 30), seconds: 5400 },
      { start: at(13, 50), seconds: 4200 },
    ]);
    expect(findGaps([], at(9), at(9, 20))).toEqual([]);
  });

  it("formatDurationLong", () => {
    expect(formatDurationLong(27600)).toBe("7 h 40 min");
    expect(formatDurationLong(2400)).toBe("40 min");
    expect(formatDurationLong(7200)).toBe("2 h");
  });
  it("formatHMS", () => {
    expect(formatHMS(5305)).toBe("1:28:25");
    expect(formatHMS(59)).toBe("0:00:59");
  });
});

describe("a typed day follows the work schedule (D14)", () => {
  it("1d and 1w use the given day, else 8 hours", () => {
    expect(parseDurationToSeconds("1d", { daySeconds: 7.5 * 3600 })).toBe(27_000);
    expect(parseDurationToSeconds("1w", { daySeconds: 6 * 3600 })).toBe(5 * 6 * 3600);
    expect(parseDurationToSeconds("1d 2h", { daySeconds: 0 })).toBe(10 * 3600);
    expect(parseDurationToSeconds("1d")).toBe(8 * 3600);
  });

  it("a field shows hours and minutes, which read back the same whatever the day", () => {
    expect(formatSeconds(8 * 3600, { days: false })).toBe("8h");
    expect(formatSeconds(10.5 * 3600, { days: false })).toBe("10h 30m");
    const shown = formatSeconds(8 * 3600, { days: false });
    expect(parseDurationToSeconds(shown, { daySeconds: 7.5 * 3600 })).toBe(8 * 3600);
    expect(formatSeconds(8 * 3600)).toBe("1d");
  });
});
