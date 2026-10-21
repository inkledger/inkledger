import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Every watcher call Jira received: "POST KEY body" / "DELETE KEY query". */
const calls: string[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/myself")) {
      return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    }
    const watchers = /\/issue\/([A-Z]+-\d+)\/watchers$/.exec(url.pathname);
    if (watchers) {
      calls.push(`${init?.method} ${watchers[1]} ${init?.method === "POST" ? String(init.body) : url.search}`);
      return new Response(null, { status: 204 });
    }
    const single = /\/issue\/([A-Z]+-\d+)$/.exec(url.pathname);
    if (single) {
      return json({
        id: "9",
        key: single[1],
        fields: {
          summary: "Someone else's job",
          status: { name: "To Do", statusCategory: { key: "new" } },
          project: { key: single[1].split("-")[0], name: "P" },
          assignee: { accountId: "someone-else" },
          created: "2026-10-01T10:00:00.000+0200",
          updated: "2026-10-01T10:00:00.000+0200",
        },
      });
    }
    return json({ errorMessages: [`unmocked ${url.pathname}`] }, 500);
  }),
);

describe("watching issues", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
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

  it("watches an unknown issue on Jira, imports it and lists it under Seguite", async () => {
    await caller.issues.watch({ key: "comm-7", watch: true });
    expect(calls).toEqual(['POST COMM-7 "acc-1"']);
    const watched = await caller.issues.list({ watchingOnly: true });
    expect(watched.issues.map((i) => [i.key, i.watching, i.isMine])).toEqual([["COMM-7", 1, false]]);
    // not assigned to me: out of the default view, counted for the toggle
    const mine = await caller.issues.list();
    expect(mine.issues).toHaveLength(0);
    expect(mine.counts.watching).toBe(1);
    expect((await caller.issues.all()).find((i) => i.key === "COMM-7")?.watching).toBe(1);
  });

  it("survives the cleanup of issues that are not mine", async () => {
    await caller.issues.cleanup();
    expect((await caller.issues.list({ watchingOnly: true })).issues).toHaveLength(1);
  });

  it("stops watching on Jira and locally", async () => {
    await caller.issues.watch({ key: "COMM-7", watch: false });
    expect(calls.at(-1)).toBe("DELETE COMM-7 ?accountId=acc-1");
    expect((await caller.issues.list({ watchingOnly: true })).issues).toHaveLength(0);
  });
});
