// Where a sink files a container's time: one mapping per container, whatever
// the timing of two saves of it (two tabs, a double click).
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

describe("sinks.map", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;
  let sinkId = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { sealSecret } = await import("../lib/crypto");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('s', 'S', 1) RETURNING id");
    const [c] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'everhour', 'https://api.everhour.com', 'me', '{}', 'x', 1) RETURNING id", u.id);
    sinkId = c.id;
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("t", sinkId), sinkId);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  });

  const target = (remoteId: string) => ({ remoteId, name: `Project ${remoteId}`, path: [] });

  it("two saves at once both succeed, and one mapping stays", async () => {
    const results = await Promise.allSettled([
      caller.sinks.map({ id: sinkId, containerId: null, target: target("p-1"), activityId: null }),
      caller.sinks.map({ id: sinkId, containerId: null, target: target("p-2"), activityId: null }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const rows = await q<{ target_remote_id: string }>("SELECT target_remote_id FROM sink_mappings WHERE sink_connection_id = ?", sinkId);
    expect(rows).toHaveLength(1);
    expect(["p-1", "p-2"]).toContain(rows[0].target_remote_id);
  });

  it("a later save replaces the mapping", async () => {
    await caller.sinks.map({ id: sinkId, containerId: null, target: target("p-3"), activityId: "a-1" });
    expect(await q("SELECT target_remote_id, target_name, activity_id FROM sink_mappings WHERE sink_connection_id = ?", sinkId)).toEqual([
      { target_remote_id: "p-3", target_name: "Project p-3", activity_id: "a-1" },
    ]);
  });
});
