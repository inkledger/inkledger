// A wall-clock hour of a day in a zone, as an instant: the same answer
// whatever zone this process runs in (the server runs in the host's zone,
// Europe/Rome in the image; the tests too).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { instantAtLocal, localDate, localDateOf, timeZone } from "@contracts/values";

const at = (day: string, hour: number, zone: string) => new Date(instantAtLocal(localDate(day), hour, timeZone(zone))).toISOString();

// The server's own zone, switched at runtime (Node reads process.env.TZ again).
const SERVER_ZONES = ["Europe/Rome", "UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Tokyo"];
const own = process.env.TZ;
afterAll(() => {
  process.env.TZ = own;
});

describe.each(SERVER_ZONES)("a wall-clock hour of a day, in a zone, the server in %s", (server) => {
  beforeEach(() => {
    process.env.TZ = server;
  });
  it("the server's zone is in force here", () => {
    process.env.TZ = server;
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(server);
  });

  it("09:00 in Rome is 07:00Z in summer time, 08:00Z in winter time", () => {
    expect(at("2026-10-21", 9, "Europe/Rome")).toBe("2026-10-21T07:00:00.000Z");
    expect(at("2026-12-01", 9, "Europe/Rome")).toBe("2026-12-01T08:00:00.000Z");
  });

  it("the day clocks go back (Rome, 25 Oct 2026): 09:00 is already winter time", () => {
    expect(at("2026-10-25", 9, "Europe/Rome")).toBe("2026-10-25T08:00:00.000Z");
  });

  it("zones far from the process's own: same wall hour, same day", () => {
    expect(at("2026-10-21", 9, "America/Los_Angeles")).toBe("2026-10-21T16:00:00.000Z");
    expect(at("2026-10-21", 9, "Pacific/Kiritimati")).toBe("2026-10-20T19:00:00.000Z");
    expect(at("2026-10-21", 9, "UTC")).toBe("2026-10-21T09:00:00.000Z");
  });

  it("an hour a clock change repeats (Rome, 25 Oct 2026 02:30) is its second occurrence", () => {
    expect(new Date(instantAtLocal(localDate("2026-10-25"), 2.5, timeZone("Europe/Rome"))).toISOString()).toBe("2026-10-25T01:30:00.000Z");
  });

  it("an hour a clock change skips (Rome, 29 Mar 2026 02:30) lands an hour later", () => {
    expect(new Date(instantAtLocal(localDate("2026-03-29"), 2.5, timeZone("Europe/Rome"))).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("west of UTC too: a skipped hour lands later, a repeated one is its second occurrence", () => {
    // New York, 8 Mar 2026 02:30 is skipped (03:30 EDT); 1 Nov 2026 01:30 comes twice (EDT, then EST).
    expect(new Date(instantAtLocal(localDate("2026-03-08"), 2.5, timeZone("America/New_York"))).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(new Date(instantAtLocal(localDate("2026-11-01"), 1.5, timeZone("America/New_York"))).toISOString()).toBe("2026-11-01T06:30:00.000Z");
    // Santiago skips midnight (6 Sep 2026): the day still starts on that day, at 01:00.
    expect(at("2026-09-06", 0, "America/Santiago")).toBe("2026-09-06T04:00:00.000Z");
  });

  it("midnight is on its own day all year, in zones east and west", () => {
    for (const zone of ["America/New_York", "America/Santiago", "America/Havana", "Europe/Rome", "Australia/Lord_Howe", "Asia/Tehran"]) {
      for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86_400_000) {
        const day = localDate(new Date(t).toISOString().slice(0, 10));
        expect(localDateOf(instantAtLocal(day, 0, timeZone(zone)), timeZone(zone)), `${zone} ${day}`).toBe(day);
      }
    }
  });
});
