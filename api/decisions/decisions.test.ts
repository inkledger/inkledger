import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let nextId = 1;
/** Jira answers slowly: both pages' answers are in flight at once. */
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    if (url.includes("DEC-5/worklog") && method === "POST") return json({ errorMessages: ["Jira refuses it"] }, 400);
    if (url.endsWith("/worklog") && method === "POST") {
      await new Promise((r) => setTimeout(r, 30));
      const body = JSON.parse(String(init?.body)) as { timeSpentSeconds: number; started: string };
      return json({ id: `wl-${nextId++}`, ...body, author: { accountId: "acc-1" } });
    }
    return json({ errorMessages: [`unmocked ${method} ${url}`] }, 500);
  }),
);

type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;

describe("decisions: the same question on every page, the first answer wins", () => {
  let page: (client: string) => Caller;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: "https://acme.atlassian.net", deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    page = (client) => appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId, deviceId: "device-laptop-1", clientId: client });
  });

  const reset = async () => {
    await q("DELETE FROM timers");
    await q("DELETE FROM decisions");
    await q("DELETE FROM worklogs");
  };
  const started = new Date(Date.now() - 4 * 3600_000).toISOString();

  it("a stop asks every page once; a second stop refreshes the same question", async () => {
    await reset();
    const a = page("client-a-0001");
    const b = page("client-b-0001");
    await a.timers.start({ issueKey: "DEC-1" });
    const first = await a.timers.stop({ issueKey: "DEC-1" });
    const again = await a.timers.stop({ issueKey: "DEC-1" });
    expect(again.found && again.decision?.id).toBe(first.found && first.decision?.id);
    const seen = await b.decisions.list();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "timer-log", state: "open", payload: { issueKey: "DEC-1" } });
  });

  it("a draft typed on one page is the draft on all of them", async () => {
    const a = page("client-a-0001");
    const b = page("client-b-0001");
    const [d] = await a.decisions.list();
    await a.decisions.patchDraft({ id: d.id, fields: { comment: "Fixing login" } });
    const [seen] = await b.decisions.list();
    expect(seen.draft).toEqual({ comment: "Fixing login" });
    expect(seen.draftBy).toMatchObject({ comment: { client: "client-a-0001" } });
  });

  it("two pages answering at once: one worklog, the other told it was decided", async () => {
    await reset();
    const a = page("client-a-0001");
    const b = page("client-b-0001");
    await a.timers.start({ issueKey: "DEC-2" });
    await a.timers.stop({ issueKey: "DEC-2" });
    const [d] = await b.decisions.list();
    const log = (p: Caller) => p.worklogs.create({ issueKey: "DEC-2", timeSpent: "1h", started, fromTimer: true, decision: { id: d.id, revision: d.revision } });
    const results = await Promise.allSettled([log(a), log(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(String(lost?.status === "rejected" ? lost.reason : "")).toMatch(/decision:(busy|decided|changed)/);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM worklogs WHERE issue_key = 'DEC-2'"))[0].n).toBe(1);
    const [done] = await a.decisions.list();
    expect(done).toMatchObject({ state: "resolved", resolution: { choice: "logged" } });
    // A late answer from a page that never heard: refused, nothing written.
    await expect(log(b)).rejects.toThrow(/decision:decided/);
  });

  it("resumed elsewhere: the question no longer stands, on every page", async () => {
    await reset();
    const a = page("client-a-0001");
    const b = page("client-b-0001");
    await a.timers.start({ issueKey: "DEC-3" });
    await a.timers.stop({ issueKey: "DEC-3" });
    await b.timers.start({ issueKey: "DEC-3" });
    const [d] = await a.decisions.list();
    expect(d).toMatchObject({ state: "obsolete", resolution: { reason: "resumed" } });
  });

  it("logged another way (no answer): the open question ends", async () => {
    await reset();
    const a = page("client-a-0001");
    await a.timers.start({ issueKey: "DEC-4" });
    await a.timers.stop({ issueKey: "DEC-4" });
    await a.worklogs.create({ issueKey: "DEC-4", timeSpent: "1h", started, fromTimer: true });
    const [d] = await a.decisions.list();
    expect(d).toMatchObject({ state: "obsolete", resolution: { reason: "logged" } });
  });

  it("a failed answer opens the question again for everyone, with the error", async () => {
    await reset();
    const a = page("client-a-0001");
    await a.timers.start({ issueKey: "DEC-5" });
    await a.timers.stop({ issueKey: "DEC-5" });
    const [d] = await a.decisions.list();
    // Jira refuses the worklog: the time goes back to the timer.
    await expect(a.worklogs.create({ issueKey: "DEC-5", timeSpent: "1h", started, fromTimer: true, decision: { id: d.id, revision: d.revision } })).rejects.toThrow();
    const [back] = await a.decisions.list();
    expect(back.state).toBe("open");
    expect(back.resolution).toHaveProperty("lastError");
    expect((await a.timers.list())[0]).toMatchObject({ issueKey: "DEC-5", state: "paused" });
  });

  it("'Later' closes it everywhere; the timer stays to log", async () => {
    await reset();
    const a = page("client-a-0001");
    await a.timers.start({ issueKey: "DEC-6" });
    await a.timers.stop({ issueKey: "DEC-6" });
    const [d] = await a.decisions.list();
    await page("client-b-0001").decisions.dismiss({ id: d.id, revision: d.revision });
    expect((await a.decisions.list())[0]).toMatchObject({ state: "resolved", resolution: { choice: "later" } });
    expect((await a.timers.list())[0].state).toBe("paused");
  });

  it("an answer abandoned in flight: back to open; one whose timer's time was taken ends as logged", async () => {
    await reset();
    const a = page("client-a-0001");
    await a.timers.start({ issueKey: "DEC-7" });
    await a.timers.stop({ issueKey: "DEC-7" });
    const past = Date.now() - 1000;
    await q("UPDATE decisions SET state = 'resolving', busy_by = 'client-a-0001', busy_until = ?", past);
    expect((await a.decisions.list())[0]).toMatchObject({ state: "open", resolution: { lastError: "interrupted" } });
    await q("UPDATE decisions SET state = 'resolving', busy_by = 'client-a-0001', busy_until = ?", past);
    await q("DELETE FROM timers");
    expect((await a.decisions.list())[0]).toMatchObject({ state: "obsolete", resolution: { reason: "logged" } });
  });

  it("ended questions are purged after a week; open ones stay", async () => {
    const { purgeDecisions } = await import("./store");
    await q("UPDATE decisions SET updated_at = ?", Date.now() - 8 * 86_400_000);
    await purgeDecisions();
    expect(await q("SELECT count(*)::int AS n FROM decisions")).toEqual([{ n: 0 }]);
    const a = page("client-a-0001");
    await a.timers.start({ issueKey: "DEC-8" });
    await a.timers.stop({ issueKey: "DEC-8" });
    await q("UPDATE decisions SET updated_at = ?", Date.now() - 8 * 86_400_000);
    await purgeDecisions();
    expect(await q("SELECT count(*)::int AS n FROM decisions")).toEqual([{ n: 1 }]);
  });

  it("logged in part: the rest stays paused, to log later, with no new question", async () => {
    await reset();
    const a = page("client-a-0001");
    await a.timers.start({ issueKey: "DEC-9" });
    await q("UPDATE timers SET accumulated_seconds = 7200, started_at = ?", Date.now());
    await a.timers.stop({ issueKey: "DEC-9" });
    const [d] = await a.decisions.list();
    await a.worklogs.create({ issueKey: "DEC-9", timeSpent: "1h", started, fromTimer: true, decision: { id: d.id, revision: d.revision } });
    const [t] = await a.timers.list();
    expect(t).toMatchObject({ state: "paused" });
    expect(t.elapsedSeconds).toBeGreaterThanOrEqual(3600);
    expect(t.elapsedSeconds).toBeLessThan(3610);
    expect((await a.decisions.list()).filter((x) => x.state === "open")).toEqual([]);
    // Asked again (its "to log" button): one question, for the rest.
    await a.decisions.askTimerLog({ issueKey: "DEC-9" });
    const open = (await page("client-b-0001").decisions.list()).filter((x) => x.state === "open");
    expect(open).toHaveLength(1);
    expect(open[0].payload).toMatchObject({ seconds: 3600 });
  });

  it("'Later' keeps the comment typed so far as the timer's note", async () => {
    await reset();
    const a = page("client-a-0001");
    await a.timers.start({ issueKey: "DEC-10" });
    await a.timers.stop({ issueKey: "DEC-10" });
    const [d] = await a.decisions.list();
    const { revision } = await a.decisions.patchDraft({ id: d.id, fields: { comment: "Half done" } });
    await page("client-b-0001").decisions.dismiss({ id: d.id, revision });
    expect((await a.timers.list())[0].note).toBe("Half done");
  });

  it("a TODO started without an issue still asks to log the timers it paused", async () => {
    await reset();
    const a = page("client-a-0001");
    await a.timers.start({ issueKey: "DEC-11" });
    const [todo] = await q<{ id: number }>("INSERT INTO todos (user_id, text, position, created_at, updated_at) SELECT id, 'Write docs', 0, 1, 1 FROM users LIMIT 1 RETURNING id");
    await a.todos.startWork({ id: todo.id });
    expect((await a.decisions.list()).map((x) => [x.kind, x.state, x.payload.issueKey])).toEqual([["timer-log", "open", "DEC-11"]]);
  });
});
