import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { minuteSpan } from "@contracts/time";

process.env.DATABASE_URL = ":memory:";

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

/** Local times of one day, to the second. */
const at = (h: number, m: number, s = 0) => new Date(2026, 9, 22, h, m, s);

describe("Play right after a Stop: the new block starts where the one before ends", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let q: typeof import("../queries/connection").q;
  let userId = 0;
  let connId = 0;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(10, 0));
    const conn = await import("../queries/connection");
    q = conn.q;
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: "https://acme.atlassian.net", deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    userId = ctx.user!.id;
    connId = (await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ?", userId))[0].id;
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  beforeEach(async () => {
    await q("DELETE FROM timers");
    await q("DELETE FROM worklogs");
  });

  const timer = async (key: string) => (await caller.timers.list()).find((t) => t.issueKey === key);
  /** Started at 10:00, stopped at 10:15:20 (its log rounds down to 10:15). */
  const stopped = async (key: string) => {
    vi.setSystemTime(at(10, 0));
    await caller.timers.start({ issueKey: key });
    vi.setSystemTime(at(10, 15, 20));
    return caller.timers.stop({ issueKey: key });
  };

  it("resuming the same issue keeps its start: the block does not slide forward", async () => {
    await stopped("RS-1");
    vi.setSystemTime(at(10, 15, 50));
    await caller.timers.start({ issueKey: "RS-1" });
    const t = await timer("RS-1");
    expect(t?.trackedFrom.getTime()).toBe(at(10, 0).getTime());
    expect(t?.elapsedSeconds).toBe(950);
  });

  it("another issue starts on the stop: its log begins where the stopped one's ends", async () => {
    const stop = await stopped("RS-2");
    vi.setSystemTime(at(10, 15, 50));
    await caller.timers.start({ issueKey: "RS-3" });
    const t = await timer("RS-3");
    expect(t?.trackedFrom.getTime()).toBe(at(10, 15, 20).getTime());
    vi.setSystemTime(at(10, 40, 0));
    expect(minuteSpan(new Date(), (await timer("RS-3"))?.elapsedSeconds ?? 0).start.getTime()).toBe(stop.stoppedAt?.getTime());
  });

  it("once the stopped timer is logged, the next starts where its worklog ends", async () => {
    vi.setSystemTime(at(10, 15, 50));
    await q(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, 'RS-4', 'w-1', 900, ?, 1)",
      userId, connId, at(10, 0).getTime(),
    );
    await caller.timers.start({ issueKey: "RS-5" });
    expect((await timer("RS-5"))?.trackedFrom.getTime()).toBe(at(10, 15).getTime());
  });

  it("after a minute or more the hole is real (Play asks about it): started now", async () => {
    await stopped("RS-6");
    vi.setSystemTime(at(10, 17, 0));
    await caller.timers.start({ issueKey: "RS-7" });
    expect((await timer("RS-7"))?.trackedFrom.getTime()).toBe(at(10, 17).getTime());
  });

  it("time logged up to after now is not joined: started now", async () => {
    vi.setSystemTime(at(10, 15, 50));
    await q(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, 'RS-8', 'w-2', 1200, ?, 1)",
      userId, connId, at(10, 0).getTime(),
    );
    await caller.timers.start({ issueKey: "RS-9" });
    expect((await timer("RS-9"))?.trackedFrom.getTime()).toBe(at(10, 15, 50).getTime());
  });
});
