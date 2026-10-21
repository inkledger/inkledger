import { describe, it, expect, beforeAll, vi } from "vitest";
import { jiraSignIn } from "../testing/signIn";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Jira's worklog API as it answers; every call recorded as "METHOD path". */
const jira = { calls: [] as string[], offline: false, worklogs: new Map<string, { id: string; started: string; timeSpentSeconds: number; comment?: string; created: string }>(), seq: 0 };
vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.pathname.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
  if (!url.pathname.includes("/worklog")) return json({ errorMessages: ["unmocked"] }, 500);
  jira.calls.push(`${method} ${url.pathname.replace(/^\/rest\/api\/\d+/, "")}`);
  if (jira.offline) throw new TypeError("fetch failed");
  const one = /\/worklog\/([^/]+)$/.exec(url.pathname);
  const out = (w: { id: string; started: string; timeSpentSeconds: number; comment?: string; created: string }) => ({ ...w, author: { accountId: "acc-1" }, updated: w.created });
  if (method === "POST") {
    const body = JSON.parse(String(init?.body)) as { started: string; timeSpentSeconds: number };
    const w = { id: `wl-${++jira.seq}`, started: body.started, timeSpentSeconds: body.timeSpentSeconds, created: new Date().toISOString() };
    jira.worklogs.set(w.id, w);
    return json(out(w));
  }
  if (one && method === "PUT") {
    const body = JSON.parse(String(init?.body)) as { started: string; timeSpentSeconds: number };
    const w = { ...jira.worklogs.get(one[1])!, ...body };
    jira.worklogs.set(w.id, w);
    return json(out(w));
  }
  if (one && method === "DELETE") {
    jira.worklogs.delete(one[1]);
    return new Response(null, { status: 204 });
  }
  if (method === "GET") return json({ startAt: 0, maxResults: 5000, total: jira.worklogs.size, worklogs: [...jira.worklogs.values()].map(out) });
  return json({ errorMessages: ["unmocked"] }, 500);
});

/**
 * The gate for Jira's time on the provider contract: the same calls to
 * Jira, in the same order, as its own path made (one POST to log, one PUT
 * to change, one DELETE; a queued create looks first whether it landed).
 */
describe("Jira's time through the contract: the same calls as before", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
  });

  it("log, change, delete: POST, PUT, DELETE on the issue's worklog", async () => {
    jira.calls = [];
    const made = await caller.worklogs.create({ issueKey: "GATE-1", seconds: 1800, started: "2026-10-14T09:00:00+02:00", comment: "a" });
    expect(made.remoteId).toBe("wl-1");
    await caller.worklogs.update({ id: made.id, seconds: 2400, started: "2026-10-14T09:00:00+02:00", comment: "b" });
    await caller.worklogs.delete({ id: made.id });
    expect(jira.calls).toEqual(["POST /issue/GATE-1/worklog", "PUT /issue/GATE-1/worklog/wl-1", "DELETE /issue/GATE-1/worklog/wl-1"]);
  });

  it("offline: queued; at the replay the issue's worklogs are read first (did it land?), then one POST", async () => {
    jira.calls = [];
    jira.offline = true;
    const made = await caller.worklogs.create({ issueKey: "GATE-2", seconds: 600, started: "2026-10-15T09:00:00+02:00", comment: "" });
    jira.offline = false;
    expect(made.remoteId).toMatch(/^pending-/);
    const r = await caller.outbox.retry();
    expect(r).toMatchObject({ synced: 1, failed: 0, remaining: 0 });
    expect(jira.calls).toEqual(["POST /issue/GATE-2/worklog", "GET /issue/GATE-2/worklog", "POST /issue/GATE-2/worklog"]);
    const [now] = await caller.worklogs.list({ issueKey: "GATE-2" });
    expect(now.remoteId).toBe(`wl-${jira.seq}`);
  });

  it("a create that landed though its answer was lost is adopted at the replay: no second POST", async () => {
    jira.calls = [];
    // Jira takes it, the answer never arrives.
    jira.worklogs.set("wl-90", { id: "wl-90", started: "2026-10-16T09:00:00.000+0200", timeSpentSeconds: 900, created: new Date().toISOString() });
    jira.offline = true;
    const made = await caller.worklogs.create({ issueKey: "GATE-3", seconds: 900, started: "2026-10-16T09:00:00+02:00", comment: "" });
    jira.offline = false;
    await caller.outbox.retry();
    expect(jira.calls).toEqual(["POST /issue/GATE-3/worklog", "GET /issue/GATE-3/worklog"]);
    const [now] = (await caller.worklogs.list({ issueKey: "GATE-3" })).filter((w) => w.id === made.id);
    expect(now.remoteId).toBe("wl-90");
  });
});
