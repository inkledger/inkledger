import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Jira, reachable or not. */
let offline = false;
let nextId = 1;
/** Set: Jira holds the next worklog POST until released (an answer still on its way). */
let holdPost: { started: () => void; until: Promise<void> } | null = null;
const remote = new Map<string, { id: string; issue?: string; started: string; timeSpentSeconds: number; created: string }>();
/** The issue a worklog URL is about, as Jira scopes its worklog lists. */
const issueIn = (url: string) => /\/issue\/([A-Z0-9_]+-\d+)\/worklog/.exec(url)?.[1];

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    if (offline) throw new TypeError("fetch failed");
    const one = /\/issue\/[A-Z0-9_]+-\d+\/worklog\/([^/?]+)$/.exec(url);
    if (one && method === "DELETE") {
      remote.delete(decodeURIComponent(one[1]));
      return new Response(null, { status: 204 });
    }
    if (one && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { timeSpentSeconds: number; started: string };
      const w = { id: decodeURIComponent(one[1]), ...body, created: new Date().toISOString() };
      remote.set(w.id, w);
      return json({ ...w, author: { accountId: "acc-1" } });
    }
    if (/\/worklog(\?.*)?$/.test(url) && method === "POST") {
      if (holdPost) {
        const h = holdPost;
        holdPost = null;
        h.started();
        await h.until;
      }
      const body = JSON.parse(String(init?.body)) as { timeSpentSeconds: number; started: string };
      const w = { id: `wl-${nextId++}`, issue: issueIn(url), ...body, created: new Date().toISOString() };
      remote.set(w.id, w);
      return json({ ...w, author: { accountId: "acc-1" } });
    }
    if (/\/worklog(\?.*)?$/.test(url)) {
      const mine = [...remote.values()].filter((w) => !w.issue || w.issue === issueIn(url));
      return json({ worklogs: mine.map((w) => ({ ...w, author: { accountId: "acc-1" } })), total: mine.length, startAt: 0, maxResults: 1000 });
    }
    return json({ errorMessages: [`unmocked ${method} ${url}`] }, 500);
  }),
);

describe("the worklog registry", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let userId = 0;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    userId = ctx.user!.id;
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
  });

  const sinkOf = (worklogId: number) => q<{ remote_id: string | null; state: string }>("SELECT remote_id, state FROM worklog_sinks WHERE worklog_id = ?", worklogId);

  it("a worklog logged in seconds gets its own identity and its place on Jira", async () => {
    const saved = await caller.worklogs.create({ issueKey: "REG-1", seconds: 5400, started: "2026-10-12T08:00:00+02:00", comment: "" });
    expect(saved.timeSpentSeconds).toBe(5400);
    expect(saved.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(await sinkOf(saved.id)).toEqual([{ remote_id: saved.remoteId, state: "synced" }]);
  });

  it("logged offline, it waits as pending; when Jira is back it lands in place: same id, same uuid", async () => {
    offline = true;
    const queued = await caller.worklogs.create({ issueKey: "REG-1", seconds: 1800, started: "2026-10-13T08:00:00+02:00", comment: "offline" });
    offline = false;
    expect(queued.remoteId).toMatch(/^pending-/);
    expect(await sinkOf(queued.id)).toEqual([{ remote_id: null, state: "pending" }]);
    expect(await q("SELECT worklog_id FROM outbox WHERE user_id = ?", userId)).toEqual([{ worklog_id: queued.id }]);
    await caller.outbox.retry();
    const [landed] = await q<{ id: number; uuid: string; jira_worklog_id: string }>("SELECT id, uuid, jira_worklog_id FROM worklogs WHERE comment = 'offline'");
    expect(landed).toMatchObject({ id: queued.id, uuid: queued.uuid });
    expect(landed.jira_worklog_id).toMatch(/^wl-/);
    expect(await sinkOf(queued.id)).toEqual([{ remote_id: landed.jira_worklog_id, state: "synced" }]);
  });

  it("is changed and deleted by its id in inkledger", async () => {
    const saved = await caller.worklogs.create({ issueKey: "REG-2", seconds: 3600, started: "2026-10-14T08:00:00+02:00", comment: "" });
    const moved = await caller.worklogs.update({ id: saved.id, seconds: 2700, started: "2026-10-14T09:00:00+02:00", comment: "shorter" });
    expect(moved).toMatchObject({ id: saved.id, timeSpentSeconds: 2700, comment: "shorter" });
    await caller.worklogs.delete({ id: saved.id });
    expect(await q("SELECT count(*)::int AS n FROM worklogs WHERE id = ?", saved.id)).toEqual([{ n: 0 }]);
    expect(await sinkOf(saved.id)).toEqual([]);
    await expect(caller.worklogs.delete({ id: saved.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("asks for a duration, and a worklog either way", async () => {
    await expect(caller.worklogs.create({ issueKey: "REG-3", started: "2026-10-15T08:00:00+02:00", comment: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.worklogs.delete({ issueKey: "REG-3" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  describe("the trash", () => {
    const trash = () => q<{ issue_key: string; reason: string; remote_id: string | null; time_spent_seconds: number }>("SELECT issue_key, reason, remote_id, time_spent_seconds FROM worklog_trash WHERE user_id = ? ORDER BY id", userId);

    it("a deleted worklog waits there; restoring logs it again (a new id on Jira)", async () => {
      await q("DELETE FROM worklog_trash");
      const saved = await caller.worklogs.create({ issueKey: "TR-1", seconds: 1200, started: "2026-10-16T08:00:00+02:00", comment: "to trash" });
      await caller.worklogs.delete({ id: saved.id });
      expect(await trash()).toEqual([{ issue_key: "TR-1", reason: "user", remote_id: saved.remoteId, time_spent_seconds: 1200 }]);
      const [{ id }] = await caller.worklogs.trash();
      const back = await caller.worklogs.restore({ id });
      expect(back.remoteId).not.toBe(saved.remoteId);
      expect(back).toMatchObject({ issueKey: "TR-1", timeSpentSeconds: 1200, comment: "to trash" });
      expect(await trash()).toEqual([]);
    });

    it("a worklog gone from Jira is there too, as removed on the service", async () => {
      await q("DELETE FROM worklog_trash");
      const saved = await caller.worklogs.create({ issueKey: "TR-2", seconds: 600, started: "2026-10-17T08:00:00+02:00", comment: "" });
      remote.delete(saved.remoteId);
      await caller.worklogs.syncIssue({ issueKey: "TR-2" });
      expect(await trash()).toEqual([{ issue_key: "TR-2", reason: "remote", remote_id: saved.remoteId, time_spent_seconds: 600 }]);
    });

    it("an offline delete leaves one trace, not two when it reaches Jira; old trash goes after 30 days", async () => {
      await q("DELETE FROM worklog_trash");
      const saved = await caller.worklogs.create({ issueKey: "TR-3", seconds: 900, started: "2026-10-18T08:00:00+02:00", comment: "" });
      offline = true;
      await caller.worklogs.delete({ id: saved.id });
      offline = false;
      await caller.outbox.retry();
      expect((await trash()).map((r) => r.reason)).toEqual(["user"]);
      const { purgeTrash } = await import("../queries/trash");
      expect(await purgeTrash(Date.now() + 31 * 86_400_000)).toBe(1);
      expect(await trash()).toEqual([]);
    });
  });

  it("a retry while the tracker is still away says how much is left, as a number", async () => {
    offline = true;
    const queued = await caller.worklogs.create({ issueKey: "REG-9", seconds: 300, started: "2026-10-19T08:00:00+02:00", comment: "left" });
    const res = await caller.outbox.retry();
    expect(res).toMatchObject({ synced: 0, remaining: 1 });
    expect(typeof res.remaining).toBe("number");
    offline = false;
    expect(await caller.outbox.retry()).toMatchObject({ synced: 1, remaining: 0 });
    await caller.worklogs.delete({ id: queued.id });
  });

  it("a sync of the issue while a new worklog's answer is still on its way leaves it be: it lands once, no error, no copy", async () => {
    let release: () => void = () => undefined;
    let posting: () => void = () => undefined;
    const inFlight = new Promise<void>((r) => (posting = r));
    holdPost = { started: posting, until: new Promise<void>((r) => (release = r)) };
    const creating = caller.worklogs.create({ issueKey: "RACE-1", seconds: 1500, started: "2026-10-20T10:00:00+02:00", comment: "racing" });
    await inFlight;
    // Jira doesn't have it yet: the issue's sync runs right now.
    await caller.worklogs.syncIssue({ issueKey: "RACE-1" });
    release();
    const saved = await creating;
    expect(saved.remoteId).toMatch(/^wl-/);
    const rows = await q<{ id: number; jira_worklog_id: string }>("SELECT id, jira_worklog_id FROM worklogs WHERE comment = 'racing'");
    expect(rows).toEqual([{ id: saved.id, jira_worklog_id: saved.remoteId }]);
    expect([...remote.values()].filter((w) => w.timeSpentSeconds === 1500)).toHaveLength(1);
  });

  it("a creation that never finished (its process died) doesn't linger: past the claim's lease a sync drops it", async () => {
    const { CLAIM_TTL_MS } = await import("../sync/timeWrites");
    const [conn] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ? AND type = 'jira'", userId);
    const old = Date.now() - CLAIM_TTL_MS - 60_000;
    await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, 'RACE-2', 'new-orphan', 600, ?, 'orphan', ?)", userId, conn.id, Date.now(), old);
    await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, 'RACE-2', 'new-young', 600, ?, 'young', ?)", userId, conn.id, Date.now(), Date.now());
    await caller.worklogs.syncIssue({ issueKey: "RACE-2" });
    expect((await q<{ comment: string }>("SELECT comment FROM worklogs WHERE issue_key = 'RACE-2' ORDER BY comment")).map((r) => r.comment)).toEqual(["young"]);
    await q("DELETE FROM worklogs WHERE issue_key = 'RACE-2'");
  });
});
