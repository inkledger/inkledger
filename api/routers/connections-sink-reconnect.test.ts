import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));
// Everhour's own answer for whoever the token is.
vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 42, name: "Mario", email: "m@x.it" }), { headers: { "Content-Type": "application/json" } })));

describe("a time sink's token", () => {
  it("is replaced through Reconnect, as a tracker's is", async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { q, getDb } = await import("../queries/connection");
    const { sealSecret } = await import("../lib/crypto");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('s', 'S', 1) RETURNING id");
    const [c] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, status, created_at) VALUES (?, 'everhour', 'https://api.everhour.com', '42', '{}', 'x', 'auth_failed', 1) RETURNING id",
      u.id,
    );
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("old-token-123", c.id), c.id);
    const { appRouter } = await import("../router");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    const caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
    await expect(caller.connections.reconnectToken({ id: c.id, token: "new-token-456" })).resolves.toEqual({ ok: true });
    expect(await q("SELECT status FROM connections WHERE id = ?", c.id)).toEqual([{ status: "ok" }]);
  });
});
