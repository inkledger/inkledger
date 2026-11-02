import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { defaultWorkSchedule, expectedSecondsBetween, EPOCH_DAY } from "@contracts/workSchedule";

process.env.DATABASE_URL = ":memory:";

/** Raw SQL on the test database (Postgres, "?" placeholders). */
const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async () =>
    new Response(JSON.stringify({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} }), {
      headers: { "Content-Type": "application/json" },
    }),
  ),
);

const H = 3600;
const MON = new Date(2026, 9, 12);

describe("work schedule versions", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: "https://acme.atlassian.net", deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({
      req: new Request("http://localhost/"),
      resHeaders: new Headers(),
      user: ctx.user,
      sessionId: ctx.sessionId,
    });
  });

  it("creates the first version from the old daily target", async () => {
    await caller.settings.update({ dailyTargetSeconds: 7 * H });
    const versions = await caller.workSchedule.list();
    expect(versions).toHaveLength(1);
    expect(versions[0].validFrom).toBe(EPOCH_DAY);
    expect(versions[0].schedule).toEqual(defaultWorkSchedule(7 * H));
  });

  it("a new version leaves the weeks before it untouched", async () => {
    const before = expectedSecondsBetween(MON, 7, await caller.workSchedule.list());
    const friShort = defaultWorkSchedule(7 * H);
    friShort[4] = { enabled: true, start: "09:00", end: "15:00", breaks: [] };
    const versions = await caller.workSchedule.save({ validFrom: "2026-10-19", schedule: friShort });
    expect(versions.map((v) => v.validFrom)).toEqual([EPOCH_DAY, "2026-10-19"]);
    expect(expectedSecondsBetween(MON, 7, versions)).toBe(before);
    expect(expectedSecondsBetween(new Date(2026, 9, 19), 7, versions)).toBe(before - H);
  });

  it("refuses dates touching a closed week, and invalid schedules", async () => {
    await caller.weeks.close({ week: "2026-10-26" });
    await expect(
      caller.workSchedule.save({ validFrom: "2026-10-27", schedule: defaultWorkSchedule() }),
    ).rejects.toThrow(/closed/);
    // an earlier date would rewrite the closed week too
    await expect(
      caller.workSchedule.save({ validFrom: "2026-10-21", schedule: defaultWorkSchedule() }),
    ).rejects.toThrow(/closed/);
    await expect(caller.workSchedule.remove({ validFrom: "2026-10-19" })).rejects.toThrow(/closed/);
    await expect(caller.workSchedule.remove({ validFrom: EPOCH_DAY })).rejects.toThrow(/first/);
    const bad = defaultWorkSchedule();
    bad[0] = { ...bad[0], start: "18:00", end: "09:00" };
    await expect(caller.workSchedule.save({ validFrom: "2026-11-02", schedule: bad })).rejects.toThrow();
  });

  it("removes a version once its weeks are open again", async () => {
    await caller.weeks.reopen({ week: "2026-10-26" });
    const versions = await caller.workSchedule.remove({ validFrom: "2026-10-19" });
    expect(versions.map((v) => v.validFrom)).toEqual([EPOCH_DAY]);
    expect(((await q("SELECT count(*) n FROM work_schedules"))[0] as { n: number }).n).toBe(1);
  });
});

describe("hours of a single day", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let userId = 0;
  const lateLunch = { enabled: true, start: "09:00", end: "17:00", breaks: [{ start: "15:00", end: "16:00" }] };

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: "https://acme.atlassian.net", deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
    userId = ctx.user!.id;
  });

  it("saves, replaces and removes a day's hours, past or future", async () => {
    expect(await caller.workSchedule.days()).toEqual({});
    expect(await caller.workSchedule.saveDay({ day: "2026-10-13", workDay: lateLunch })).toEqual({ "2026-10-13": lateLunch });
    const off = { enabled: false, start: "09:00", end: "18:00", breaks: [] };
    await caller.workSchedule.saveDay({ day: "2026-10-13", workDay: off });
    expect(await caller.workSchedule.saveDay({ day: "2030-01-07", workDay: lateLunch })).toEqual({ "2026-10-13": off, "2030-01-07": lateLunch });
    expect(await caller.workSchedule.removeDay({ day: "2030-01-07" })).toEqual({ "2026-10-13": off });
    expect(await caller.workSchedule.removeDay({ day: "2030-01-07" })).toEqual({ "2026-10-13": off });
  });

  it("the same hours as the week's: the day follows the week again", async () => {
    const versions = await caller.workSchedule.list();
    expect(await caller.workSchedule.saveDay({ day: "2026-10-13", workDay: versions[0].schedule[1] })).toEqual({});
  });

  it("refuses a closed week (a Monday too), invalid hours and dates", async () => {
    await caller.weeks.close({ week: "2026-10-26" });
    await expect(caller.workSchedule.saveDay({ day: "2026-10-26", workDay: lateLunch })).rejects.toThrow(/closed/);
    await expect(caller.workSchedule.saveDay({ day: "2026-11-01", workDay: lateLunch })).rejects.toThrow(/closed/);
    await expect(caller.workSchedule.removeDay({ day: "2026-10-28" })).rejects.toThrow(/closed/);
    await caller.workSchedule.saveDay({ day: "2026-11-02", workDay: lateLunch });
    await caller.weeks.reopen({ week: "2026-10-26" });
    await expect(caller.workSchedule.saveDay({ day: "2026-10-27", workDay: { ...lateLunch, breaks: [{ start: "18:00", end: "19:00" }] } })).rejects.toThrow();
    await expect(caller.workSchedule.saveDay({ day: "2026-02-30", workDay: lateLunch })).rejects.toThrow();
  });

  it("a new weekly version keeps the days it covers, or drops them when asked", async () => {
    await caller.workSchedule.saveDay({ day: "2026-12-01", workDay: lateLunch });
    await caller.workSchedule.save({ validFrom: "2026-11-15", schedule: defaultWorkSchedule() });
    expect(Object.keys(await caller.workSchedule.days())).toEqual(["2026-11-02", "2026-12-01"]);
    await caller.workSchedule.save({ validFrom: "2026-11-15", schedule: defaultWorkSchedule(7 * H), overrides: "drop" });
    expect(Object.keys(await caller.workSchedule.days())).toEqual(["2026-11-02"]);
  });

  it("tells the user's other pages", async () => {
    const { subscribe } = await import("../lib/userEvents");
    const seen: string[] = [];
    const stop = subscribe(userId, (e) => seen.push(e.type), () => undefined);
    await caller.workSchedule.saveDay({ day: "2026-12-02", workDay: lateLunch });
    await caller.workSchedule.removeDay({ day: "2026-12-02" });
    stop();
    expect(seen).toEqual(["schedule", "schedule"]);
  });
});
