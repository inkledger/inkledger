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
