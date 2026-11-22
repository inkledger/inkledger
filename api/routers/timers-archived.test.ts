import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";

vi.stubGlobal(
  "fetch",
  vi.fn(async () =>
    new Response(JSON.stringify({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} }), {
      headers: { "Content-Type": "application/json" },
    }),
  ),
);

describe("timers of an archived connection", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let gitlab = 0;
  const timer = async (key: string) => (await caller.timers.list()).find((t) => t.issueKey === key);

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId, deviceId: "dev-1" });
    [{ id: gitlab }] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', 'https://gitlab.example', '7', '{}', 'x', 1) RETURNING id",
      ctx.user!.id,
    );
    await caller.timers.start({ issueKey: "g/r#3", connectionId: gitlab });
    await caller.timers.start({ issueKey: "g/r#4", connectionId: gitlab, mode: "alongside" });
    await caller.connections.archive({ id: gitlab });
  });

  it("stop counting once it is archived: paused, nobody holding them", async () => {
    expect(await timer("g/r#3")).toMatchObject({ state: "paused", ownerLabel: "", heldElsewhere: false });
    expect(await timer("g/r#4")).toMatchObject({ state: "paused" });
  });

  it("can still be paused, discarded and moved away; never started again there", async () => {
    await q("UPDATE timers SET state = 'running', started_at = ? WHERE issue_key = 'g/r#3'", Date.now());
    await caller.timers.pause({ issueKey: "g/r#3", connectionId: gitlab });
    expect((await timer("g/r#3"))?.state).toBe("paused");
    await caller.timers.discard({ issueKey: "g/r#3", connectionId: gitlab });
    expect(await timer("g/r#3")).toBeUndefined();
    await caller.timers.move({ issueKey: "g/r#4", connectionId: gitlab, toIssueKey: "PRJ-1" });
    expect(await timer("g/r#4")).toBeUndefined();
    expect(await timer("PRJ-1")).toMatchObject({ state: "paused" });
    await expect(caller.timers.start({ issueKey: "g/r#4", connectionId: gitlab })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
