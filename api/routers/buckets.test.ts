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

  it("the sidebar's favorites come alone (not the whole catalogue), in their order, as issues.all gives them", async () => {
    const desk = await onDevice("device-desk-fav");
    await q("UPDATE issues SET favorite = 1, favorite_rank = 2 WHERE key = 'ONE-1'");
    await q("UPDATE issues SET favorite = 1, favorite_rank = 1 WHERE key = 'OPS-1'");
    try {
      const favs = await desk.issues.favorites();
      expect(favs.map((i) => i.key)).toEqual(["OPS-1", "ONE-1"]);
      const all = await desk.issues.all();
      expect(favs[0]).toEqual(all.find((i) => i.key === "OPS-1"));
    } finally {
      await q("UPDATE issues SET favorite = 0, favorite_rank = 0");
    }
  });

  it("the sidebar's unread counter is one number, the same one issues.all gives", async () => {
    const desk = await onDevice("device-desk-unread");
    const { isClosed } = await import("@contracts/categories");
    const count = (rows: Awaited<ReturnType<Caller["issues"]["all"]>>) => rows.filter((i) => i.hidden !== 1 && i.unread && i.isMine && !isClosed(i.category)).length;
    // News on all three: only ONE-1 counts (TWO-1 is done, OPS-1 someone else's).
    await q("UPDATE issues SET others_activity_at = ?", Date.now());
    await q("UPDATE issues SET category = 'done' WHERE key = 'TWO-1'");
    await q("UPDATE issues SET assignee_id = 'other' WHERE key = 'OPS-1'");
    try {
      expect(await desk.issues.unreadCount()).toBe(1);
      expect(await desk.issues.unreadCount()).toBe(count(await desk.issues.all()));
      await q("UPDATE issues SET seen_at = ? WHERE key = 'ONE-1'", Date.now() + 1);
      expect(await desk.issues.unreadCount()).toBe(0);
    } finally {
      await q("UPDATE issues SET others_activity_at = NULL, seen_at = NULL, category = 'todo', assignee_id = 'me'");
    }
  });

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

  it("clearing all notifications on a device with a bucket clears that bucket's only", async () => {
    await q("INSERT INTO notifications (user_id, connection_id, kind, issue_key, detail, dedupe, created_at) VALUES (?, ?, 'due', 'ONE-1', '', 'c1', ?), (?, ?, 'due', 'TWO-1', '', 'c2', ?)", userId, c1, Date.now(), userId, c2, Date.now());
    const phone = await onDevice("device-phone-clear");
    const desk = await onDevice("device-desk-clear");
    const { id } = await phone.buckets.save({ name: "Two to clear", sources: [{ connectionId: c2, containerId: null }] });
    await phone.buckets.setActive({ id });
    const before = (await desk.notifications.list()).map((n) => n.issueKey).sort();
    expect(before).toContain("ONE-1");
    await phone.notifications.dismissAll();
    expect(await phone.notifications.list()).toEqual([]);
    // Never seen on the phone: still there everywhere else.
    expect((await desk.notifications.list()).map((n) => n.issueKey).sort()).toEqual(before.filter((k) => k !== "TWO-1"));
  });
});

describe("pinboard, as the board shows it", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

  it("counts exactly the post-its it lists, for every bucket and tracker: free notes always, an issue not synced yet only outside a bucket", async () => {
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('pin', 'Pin', ?) RETURNING id", Date.now());
    const conn = async (host: string) =>
      (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', ?, 'me', 'x', ?) RETURNING id", u.id, `https://${host}`, Date.now()))[0].id;
    const a = await conn("pin-a.example");
    const b = await conn("pin-b.example");
    for (const [c, key] of [[a, "AAA-1"], [b, "BBB-1"]] as const) {
      await q(
        "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, assignee_id, url, synced_at) VALUES (?, ?, ?, ?, 's', 'To Do', ?, ?, 'me', 'u', ?)",
        u.id, c, `id-${key}`, key, key.slice(0, 3), key.slice(0, 3), Date.now(),
      );
    }
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    const device: Caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null, deviceId: "device-pin-1" });
    await device.pinboard.add({ issueKey: "AAA-1", connectionId: a });
    await device.pinboard.add({ issueKey: "BBB-1", connectionId: b });
    await device.pinboard.add({ issueKey: "AAA-404", connectionId: a });
    await device.pinboard.add({ note: "free" });

    const shown = async (connectionId?: number) => {
      const scope = connectionId ? { connectionId } : undefined;
      const list = (await device.pinboard.list(scope)).map((n) => n.issueKey ?? "free").sort();
      const [board] = await device.pinboard.boards(scope);
      expect(board.count).toBe(list.length);
      return list;
    };
    expect(await shown()).toEqual(["AAA-1", "AAA-404", "BBB-1", "free"]);
    expect(await shown(b)).toEqual(["BBB-1", "free"]);
    // An issue not synced here yet still belongs to its tracker.
    expect(await shown(a)).toEqual(["AAA-1", "AAA-404", "free"]);
    const { id } = await device.buckets.save({ name: "B only", sources: [{ connectionId: b, containerId: null }] });
    await device.buckets.setActive({ id });
    expect(await shown()).toEqual(["BBB-1", "free"]);
    expect(await shown(a)).toEqual(["free"]);
    // The pin menu says so: pinned or not, the bucket keeps it off the board.
    expect((await device.pinboard.where({ issueKey: "AAA-1", connectionId: a })).hiddenByBucket).toBe(true);
    expect((await device.pinboard.where({ issueKey: "BBB-1", connectionId: b })).hiddenByBucket).toBe(false);
    // What the filter keeps out is counted apart, never lost: 4 post-its, 2 shown.
    expect((await device.pinboard.boards())[0]).toMatchObject({ count: 2, hidden: 2, bucket: null });
    await device.buckets.setActive({ id: null });
    expect((await device.pinboard.boards())[0]).toMatchObject({ count: 4, hidden: 0 });
  });
});

describe("pinboards for one bucket, or for every bucket", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  let device: Caller;
  let other: Caller;
  let conn = 0;

  beforeAll(async () => {
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const caller = async (name: string, deviceId: string) => {
      const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES (?, ?, ?) RETURNING id", name, name, Date.now());
      const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
      return { id: u.id, caller: appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null, deviceId }) };
    };
    const me = await caller("scoped", "device-scope-1");
    device = me.caller;
    other = (await caller("intruder", "device-scope-2")).caller;
    conn = (await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://scope.example', 'me', 'x', ?) RETURNING id", me.id, Date.now()))[0].id;
  });

  const names = async (c: Caller) => (await c.pinboard.boards()).map((b) => `${b.name}${b.bucket ? `@${b.bucket.name}` : ""}`);

  it("switching the bucket tells the device's other tabs, by its id", async () => {
    const { subscribe } = await import("../lib/userEvents");
    const [me] = await q<{ id: number }>("SELECT id FROM users WHERE username = 'scoped'");
    const heard: unknown[] = [];
    const stop = subscribe(me.id, (e) => heard.push(e), () => undefined);
    await device.buckets.setActive({ id: null });
    stop();
    expect(heard).toEqual([{ type: "bucket", deviceId: "device-scope-1" }]);
  });

  it("under a bucket only its boards and the shared ones show; without one, all, with where they belong", async () => {
    const work = await device.buckets.save({ name: "Work", sources: [{ connectionId: conn, containerId: null }] });
    const home = await device.buckets.save({ name: "Home", sources: [{ connectionId: conn, containerId: null }] });
    const [first] = await device.pinboard.boards();
    await device.buckets.setActive({ id: work.id });
    // A new board belongs to the device's bucket by default; null asks for every bucket.
    const sprint = await device.pinboard.createBoard({ name: "Sprint" });
    await device.pinboard.createBoard({ name: "Ideas", bucketId: null });
    await device.buckets.setActive({ id: home.id });
    const garden = await device.pinboard.createBoard({ name: "Garden" });
    expect(await names(device)).toEqual([`${first.name}`, "Ideas", "Garden@Home"]);
    await device.buckets.setActive({ id: work.id });
    expect(await names(device)).toEqual([`${first.name}`, "Sprint@Work", "Ideas"]);
    // The switcher's groups come from the same bucket that chose the boards.
    expect((await device.pinboard.boards()).map((b) => b.group)).toEqual(["shared", "bucket", "shared"]);
    // Moved to another bucket, a board leaves; moved to this one, it joins its group.
    await device.pinboard.setBoardScope({ id: sprint.id, bucketId: home.id });
    expect(await names(device)).toEqual([`${first.name}`, "Ideas"]);
    await device.pinboard.setBoardScope({ id: sprint.id, bucketId: work.id });
    expect((await device.pinboard.boards()).find((b) => b.id === sprint.id)?.group).toBe("bucket");
    await device.buckets.setActive({ id: null });
    expect(await names(device)).toEqual([`${first.name}`, "Sprint@Work", "Ideas", "Garden@Home"]);
    expect((await device.pinboard.boards()).every((b) => b.group === "all")).toBe(true);

    // A board of another bucket asked by id (a stale choice on this device) gives the first one shown.
    await device.buckets.setActive({ id: work.id });
    expect((await device.pinboard.add({ boardId: garden.id, note: "rake" })).boardId).toBe(first.id);
    expect((await device.pinboard.list({ boardId: garden.id })).map((n) => n.note)).toContain("rake");
    await device.buckets.setActive({ id: null });
    expect((await device.pinboard.list({ boardId: garden.id })).map((n) => n.note)).not.toContain("rake");

    // Moving between scopes, and a deleted bucket leaving its boards to every bucket.
    await device.pinboard.setBoardScope({ id: garden.id, bucketId: null });
    await device.pinboard.setBoardScope({ id: sprint.id, bucketId: home.id });
    expect(await names(device)).toEqual([`${first.name}`, "Sprint@Home", "Ideas", "Garden"]);
    await device.buckets.delete({ id: home.id });
    expect(await names(device)).toEqual([`${first.name}`, "Sprint", "Ideas", "Garden"]);
  });

  it("a board's bucket must be the user's own", async () => {
    const mine = await device.buckets.save({ name: "Mine", sources: [{ connectionId: conn, containerId: null }] });
    const [theirs] = await other.pinboard.boards();
    await expect(other.pinboard.setBoardScope({ id: theirs.id, bucketId: mine.id })).rejects.toThrow(/Bucket not found/);
    await expect(other.pinboard.createBoard({ name: "Spy", bucketId: mine.id })).rejects.toThrow(/Bucket not found/);
    const [board] = await device.pinboard.boards();
    await expect(other.pinboard.setBoardScope({ id: board.id, bucketId: null })).rejects.toThrow(/not found/i);
  });
});
