import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("buckets, per device", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  let userId = 0;
  let c1 = 0;
  let c2 = 0;
  let onDevice: (deviceId: string) => Promise<Caller>;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('b', 'B', ?) RETURNING id", Date.now());
    userId = u.id;
    const conn = async (host: string) =>
      (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', ?, 'me', 'x', ?) RETURNING id", userId, `https://${host}`, Date.now()))[0].id;
    c1 = await conn("one.example");
    c2 = await conn("two.example");
    const issue = (connectionId: number, key: string, project: string) =>
      q(
        "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, assignee_id, url, synced_at) VALUES (?, ?, ?, ?, ?, 'To Do', ?, ?, 'me', 'u', ?)",
        userId, connectionId, `id-${key}`, key, `Summary ${key}`, project, project, Date.now(),
      );
    await issue(c1, "ONE-1", "ONE");
    await issue(c2, "TWO-1", "TWO");
    await issue(c2, "OPS-1", "OPS");
    await q("INSERT INTO notifications (user_id, connection_id, kind, issue_key, detail, dedupe, created_at) VALUES (?, ?, 'assigned', 'ONE-1', '', 'a1', ?), (?, ?, 'assigned', 'TWO-1', '', 'a2', ?)", userId, c1, Date.now(), userId, c2, Date.now());
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, userId));
    onDevice = async (deviceId: string) => appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null, deviceId });
  });

  const keys = async (c: Caller) => (await c.issues.list({ includeUnassigned: true, sort: "key" })).issues.map((i) => i.key);

  it("a bucket on one device narrows that device's lists only", async () => {
    const phone = await onDevice("device-phone-1");
    const desk = await onDevice("device-desk-1");
    const { id } = await phone.buckets.save({ name: "Client two", sources: [{ connectionId: c2, containerId: null }] });
    await phone.buckets.setActive({ id });
    expect(await keys(phone)).toEqual(["OPS-1", "TWO-1"]);
    expect(await keys(desk)).toEqual(["ONE-1", "OPS-1", "TWO-1"]);
    expect((await phone.buckets.list()).active).toBe(id);
    expect((await desk.buckets.list()).active).toBeNull();
    // What counts time is never narrowed; the board asks for the bucket.
    expect((await phone.issues.all()).map((i) => i.key).sort()).toEqual(["ONE-1", "OPS-1", "TWO-1"]);
    expect((await phone.issues.all({ scope: "bucket" })).map((i) => i.key).sort()).toEqual(["OPS-1", "TWO-1"]);
    expect((await phone.notifications.list()).map((n) => n.issueKey)).toEqual(["TWO-1"]);
  });

  it("a source can be one project of a connection; back to everything with none", async () => {
    const phone = await onDevice("device-phone-1");
    const [ops] = await q<{ id: number }>("SELECT container_id AS id FROM issues WHERE key = 'OPS-1'");
    const { id } = await phone.buckets.save({ name: "Ops only", sources: [{ connectionId: c2, containerId: ops.id }] });
    await phone.buckets.setActive({ id });
    expect(await keys(phone)).toEqual(["OPS-1"]);
    await phone.buckets.setActive({ id: null });
    expect(await keys(phone)).toEqual(["ONE-1", "OPS-1", "TWO-1"]);
  });

  it("only the user's own sources", async () => {
    const [other] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('x', 'X', ?) RETURNING id", Date.now());
    const [foreign] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://x.example', 'x', 'x', ?) RETURNING id", other.id, Date.now());
    const phone = await onDevice("device-phone-1");
    await expect(phone.buckets.save({ name: "Not mine", sources: [{ connectionId: foreign.id, containerId: null }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a bucket's own search narrows it further; board mode, custom columns of its own trackers only, order", async () => {
    const tab = await onDevice("device-tab-1");
    const { id } = await tab.buckets.save({
      name: "Two, ops",
      sources: [{ connectionId: c2, containerId: null }],
      query: "progetto:OPS",
      boardMode: "custom",
      columns: [
        { name: "Waiting", statuses: { [c2]: ["To Do"], [c1]: ["To Do"] } },
        { name: "Moving", statuses: { [c2]: ["In Progress"] } },
      ],
    });
    await tab.buckets.setActive({ id });
    expect(await keys(tab)).toEqual(["OPS-1"]);
    expect((await tab.issues.all({ scope: "bucket" })).map((i) => i.key)).toEqual(["OPS-1"]);
    const saved = (await tab.buckets.list()).buckets.find((b) => b.id === id)!;
    expect(saved.query).toBe("project:OPS");
    expect(saved.boardMode).toBe("custom");
    // c1 is not in the bucket: its mapping is dropped.
    expect(saved.columns.map((c) => [c.name, c.statuses])).toEqual([
      ["Waiting", { [c2]: ["To Do"] }],
      ["Moving", { [c2]: ["In Progress"] }],
    ]);
    const ids = (await tab.buckets.list()).buckets.map((b) => b.id);
    await tab.buckets.reorder({ ids: [...ids].reverse() });
    expect((await tab.buckets.list()).buckets.map((b) => b.id)).toEqual([...ids].reverse());
    expect(await tab.buckets.statuses()).toContainEqual({ connectionId: c2, status: "To Do", category: expect.any(String) });
  });

  it("the pinboard shows the bucket's issues, and every free note", async () => {
    const pad = await onDevice("device-pad-1");
    await pad.pinboard.add({ issueKey: "ONE-1", connectionId: c1 });
    await pad.pinboard.add({ issueKey: "TWO-1", connectionId: c2 });
    await pad.pinboard.add({ note: "call the client" });
    const { id } = await pad.buckets.save({ name: "Only two", sources: [{ connectionId: c2, containerId: null }] });
    await pad.buckets.setActive({ id });
    expect((await pad.pinboard.list()).map((n) => n.issueKey ?? n.note)).toEqual(["TWO-1", "call the client"]);
    await pad.buckets.setActive({ id: null });
    expect((await pad.pinboard.list()).map((n) => n.issueKey ?? n.note)).toEqual(["ONE-1", "TWO-1", "call the client"]);
  });
});
