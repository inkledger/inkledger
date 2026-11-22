import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** TEAM-1 on Jira: one hour of mine (never imported here), an hour and a half of Anna's. */
const remote = [
  { id: "wl-1", started: "2026-10-20T08:00:00.000+0200", timeSpentSeconds: 3600, created: "2026-10-20T09:00:00.000+0200", author: { accountId: "acc-1", displayName: "Mario" } },
  { id: "wl-2", started: "2026-10-21T08:00:00.000+0200", timeSpentSeconds: 5400, created: "2026-10-21T09:30:00.000+0200", author: { accountId: "acc-2", displayName: "Anna" } },
];
const deletes: string[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    const one = /\/issue\/TEAM-1\/worklog\/([^/?]+)(\?.*)?$/.exec(url);
    const w = one ? remote.find((r) => r.id === decodeURIComponent(one[1])) : undefined;
    if (one && method === "DELETE") {
      deletes.push(one[1]);
      return new Response(null, { status: 204 });
    }
    if (one && method === "GET") return w ? json(w) : json({ errorMessages: ["gone"] }, 404);
    if (/\/issue\/TEAM-1\/worklog(\?.*)?$/.test(url) && method === "GET") return json({ worklogs: remote, total: remote.length, startAt: 0, maxResults: 1000 });
    return json({ errorMessages: [`unmocked ${method} ${url}`] }, 500);
  }),
);

describe("deleting a worklog by its id on the tracker", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
  });

  it("refuses a colleague's entry: nothing deleted there, nothing queued", async () => {
    await expect(caller.worklogs.delete({ issueKey: "TEAM-1", remoteId: "wl-2" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(deletes).toEqual([]);
    expect(await q("SELECT id FROM outbox")).toEqual([]);
  });

  it("still deletes one of mine not read back here yet", async () => {
    await caller.worklogs.delete({ issueKey: "TEAM-1", remoteId: "wl-1" });
    expect(deletes).toEqual(["wl-1"]);
  });
});
