// A wall-clock hour of a day in a zone, as an instant: the same answer
// whatever zone this process runs in (the server runs in the host's zone,
// Europe/Rome in the image; the tests too).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { instantAtLocal, localDate, timeZone } from "@contracts/values";

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

  it("an hour a clock change skips (Rome, 29 Mar 2026 02:30) lands an hour later", () => {
    expect(new Date(instantAtLocal(localDate("2026-03-29"), 2.5, timeZone("Europe/Rome"))).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
});
