import { beforeAll, describe, expect, it, vi } from "vitest";
import { jiraSignIn } from "../testing/signIn";

process.env.DATABASE_URL = ":memory:";

type Row = { item_id: number; closed_at: string };

describe("issue closures", () => {
  let q: typeof import("../queries/connection").q;
  let userId = 0;
  let connectionId = 0;

  beforeAll(async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) =>
      String(input).endsWith("/rest/api/3/myself")
        ? new Response(JSON.stringify({ accountId: "acc-1", displayName: "Mario" }), { headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 500 }),
    );
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    q = conn.q;
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders: new Headers() }, { siteUrl: "https://acme.atlassian.net", deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const [c] = await q<{ id: number; user_id: number }>("SELECT id, user_id FROM connections LIMIT 1");
    connectionId = c.id;
    userId = c.user_id;
  });

  const issue = async (key: string, category: string, statusChangedAt: number | null) =>
    (
      await q<{ id: number }>(
        "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, category, status_changed_at, project_key, project_name, url, synced_at) VALUES (?, ?, ?, ?, 's', 'x', ?, ?, 'P', 'P', 'u', 1) RETURNING id",
        userId,
        connectionId,
        key,
        key,
        category,
        statusChangedAt,
      )
    )[0].id;
  const closures = (id: number) => q<Row>("SELECT item_id, closed_at FROM issue_closures WHERE item_id = ? ORDER BY closed_at", id);

  it("a move into done is recorded once, at its tracker's time; a reopened one closed again is a second", async () => {
    const id = await issue("P-1", "doing", 1000);
    await q("UPDATE issues SET category = 'done', status_changed_at = ? WHERE id = ?", 5000, id);
    // Synced again, still done: nothing new.
    await q("UPDATE issues SET category = 'done', summary = 'renamed' WHERE id = ?", id);
    expect((await closures(id)).map((r) => Number(r.closed_at))).toEqual([5000]);
    await q("UPDATE issues SET category = 'doing', status_changed_at = ? WHERE id = ?", 6000, id);
    await q("UPDATE issues SET category = 'done', status_changed_at = ? WHERE id = ?", 7000, id);
    expect((await closures(id)).map((r) => Number(r.closed_at))).toEqual([5000, 7000]);
  });

  it("closed without a new status time: when it was seen", async () => {
    const id = await issue("P-2", "todo", 1000);
    const before = Date.now();
    await q("UPDATE issues SET category = 'done' WHERE id = ?", id);
    const [r] = await closures(id);
    expect(Number(r.closed_at)).toBeGreaterThanOrEqual(before);
  });

  it("an issue first seen already done, or cancelled, is no closure", async () => {
    const done = await issue("P-3", "done", 1000);
    const cancelled = await issue("P-4", "doing", 1000);
    await q("UPDATE issues SET category = 'cancelled', status_changed_at = 2000 WHERE id = ?", cancelled);
    expect(await closures(done)).toEqual([]);
    expect(await closures(cancelled)).toEqual([]);
  });

  it("whether it was assigned to the user when it closed (their account on the connection)", async () => {
    const mine = await issue("P-6", "doing", 1000);
    const theirs = await issue("P-7", "doing", 1000);
    await q("UPDATE issues SET assignee_id = 'acc-1' WHERE id = ?", mine);
    await q("UPDATE issues SET assignee_id = 'someone-else' WHERE id = ?", theirs);
    await q("UPDATE issues SET category = 'done', status_changed_at = 3000 WHERE id IN (?, ?)", mine, theirs);
    const flag = async (id: number) => (await q<{ assigned: number }>("SELECT assigned FROM issue_closures WHERE item_id = ?", id))[0]?.assigned;
    expect([await flag(mine), await flag(theirs)]).toEqual([1, 0]);
  });

  it("an upsert that moves it (the sync's insert … on conflict) records it too", async () => {
    const id = await issue("P-5", "doing", 1000);
    await q(
      "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, category, status_changed_at, project_key, project_name, url, synced_at) VALUES (?, ?, 'P-5', 'P-5', 's', 'Done', 'done', 9000, 'P', 'P', 'u', 1) ON CONFLICT (user_id, connection_id, jira_id) DO UPDATE SET category = excluded.category, status_changed_at = excluded.status_changed_at",
      userId,
      connectionId,
    );
    expect((await closures(id)).map((r) => Number(r.closed_at))).toEqual([9000]);
  });
});
