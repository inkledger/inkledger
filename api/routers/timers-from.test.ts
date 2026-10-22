import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

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

/** Midday, local: earlier today is always today. */
const NOON = new Date(2026, 9, 22, 12, 0, 0);
const minutesAgo = (m: number) => new Date(NOON.getTime() - m * 60_000).toISOString();

describe("a timer started from the start of a gap", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let q: typeof import("../queries/connection").q;
  let userId = 0;
  let connId = 0;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);
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
    await caller.settings.update({ overlapPolicy: "warn" });
  });

  const elapsed = async (key: string) => (await caller.timers.list()).find((t) => t.issueKey === key)?.elapsedSeconds;

  it("counts from that moment, not from now", async () => {
    await caller.timers.start({ issueKey: "GAP-1", from: minutesAgo(30) });
    expect(await elapsed("GAP-1")).toBe(1800);
  });

  it("never from the future, nor from another day", async () => {
    await expect(caller.timers.start({ issueKey: "GAP-1", from: new Date(NOON.getTime() + 60_000).toISOString() })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.timers.start({ issueKey: "GAP-1", from: minutesAgo(13 * 60) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await caller.timers.list()).toEqual([]);
  });

  it("never while another timer runs: that one's time would count twice", async () => {
    await caller.timers.start({ issueKey: "RUN-1" });
    await expect(caller.timers.start({ issueKey: "GAP-1", from: minutesAgo(30) })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.timers.start({ issueKey: "GAP-1", from: minutesAgo(30), force: true })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await caller.timers.list()).map((t) => [t.issueKey, t.state])).toEqual([["RUN-1", "running"]]);
  });

  it("never before a paused timer stopped; after it, a paused one resumes with its time plus the gap", async () => {
    await caller.timers.start({ issueKey: "GAP-1", from: minutesAgo(90) });
    await caller.timers.pause({ issueKey: "GAP-1" });
    await expect(caller.timers.start({ issueKey: "OTHER-1", from: minutesAgo(10) })).rejects.toMatchObject({ code: "CONFLICT" });
    vi.setSystemTime(new Date(NOON.getTime() + 20 * 60_000));
    await caller.timers.start({ issueKey: "GAP-1", from: minutesAgo(-5) });
    // 90 before the pause, then from 12:05 to 12:20.
    expect(await elapsed("GAP-1")).toBe(90 * 60 + 15 * 60);
    vi.setSystemTime(NOON);
  });

  it("over time already logged: refused with the block policy, let be with warn", async () => {
    await q(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, 'LOG-1', 'w-1', 1200, ?, 1)",
      userId, connId, NOON.getTime() - 25 * 60_000,
    );
    await caller.settings.update({ overlapPolicy: "block" });
    await expect(caller.timers.start({ issueKey: "GAP-1", from: minutesAgo(30) })).rejects.toMatchObject({ code: "CONFLICT" });
    await caller.timers.start({ issueKey: "GAP-1", from: minutesAgo(5) });
    expect(await elapsed("GAP-1")).toBe(300);
    await q("DELETE FROM timers");
    await caller.settings.update({ overlapPolicy: "warn" });
    await caller.timers.start({ issueKey: "GAP-1", from: minutesAgo(30) });
    expect(await elapsed("GAP-1")).toBe(1800);
  });
});
