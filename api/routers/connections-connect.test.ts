import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

/** The connection rows as seen while the service is still being asked who the token is. */
const seen = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.stubGlobal(
  "fetch",
  vi.fn(async () => {
    const { q } = await import("../queries/connection");
    seen.rows = await q("SELECT status, archived_at FROM connections");
    return new Response(JSON.stringify({ id: 42, name: "Mario", email: "m@x.it" }), { headers: { "Content-Type": "application/json" } });
  }),
);

describe("connecting with a token", () => {
  it("the new connection is out of every pass until its token is confirmed, then on and ok", async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { q, getDb } = await import("../queries/connection");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('c', 'C', 1) RETURNING id");
    const { appRouter } = await import("../router");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    const caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
    await caller.connections.connectToken({ type: "everhour", token: "a-token-123" });
    // While being checked: archived (no sync, sink pass or list takes it).
    expect(seen.rows).toHaveLength(1);
    expect((seen.rows[0] as { archived_at: number | null }).archived_at).not.toBeNull();
    expect(await q("SELECT status, archived_at FROM connections")).toEqual([{ status: "ok", archived_at: null }]);
  });
});
