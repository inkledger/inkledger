import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** How the GitLab host answers a Jira-shaped worklog call. */
let jiraPathAnswer: () => Response = () => json({ message: "401 Unauthorized" }, 401);
const jiraPathCalls: string[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith(SITE) && url.endsWith("/myself")) return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    if (url.startsWith("https://gitlab.example") && url.includes("/rest/api/")) {
      jiraPathCalls.push(url);
      return jiraPathAnswer();
    }
    return json({ message: `unmocked ${method} ${url}` }, 500);
  }),
);

describe("syncing one issue's worklogs on a tracker that keeps its own time", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let gitlab = 0;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const { encrypt } = await import("../lib/crypto");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
    [{ id: gitlab }] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', 'https://gitlab.example', '7', '{}', ?, 1) RETURNING id",
      ctx.user!.id,
      encrypt("glpat-x"),
    );
    await q(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, 'g/r#1', 'gl-1', 600, 1760000000000, 'kept', 1)",
      ctx.user!.id,
      gitlab,
    );
  });

  const kept = () => q<{ n: number }>("SELECT count(*)::int AS n FROM worklogs WHERE connection_id = ? AND comment = 'kept'", gitlab);
  const status = async () => (await q<{ status: string }>("SELECT status FROM connections WHERE id = ?", gitlab))[0].status;

  it("never calls Jira's API there: a 401 doesn't flag the connection", async () => {
    jiraPathAnswer = () => json({ message: "401 Unauthorized" }, 401);
    await caller.worklogs.syncIssue({ issueKey: "g/r#1", connectionId: gitlab }).catch(() => undefined);
    expect(await status()).toBe("ok");
    expect(await kept()).toEqual([{ n: 1 }]);
    expect(jiraPathCalls).toEqual([]);
  });

  it("an answer without worklogs doesn't wipe the local ones", async () => {
    jiraPathCalls.length = 0;
    jiraPathAnswer = () => json({});
    await caller.worklogs.syncIssue({ issueKey: "g/r#1", connectionId: gitlab }).catch(() => undefined);
    expect(await kept()).toEqual([{ n: 1 }]);
    expect(jiraPathCalls).toEqual([]);
  });
});
