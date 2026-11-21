import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("licence proof checks", () => {
  it("are limited per user: each one asks the store and an explorer", async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { q, getDb } = await import("../queries/connection");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('p', 'P', 1) RETURNING id");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    const { appRouter } = await import("../router");
    const caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
    // No such licence here: refused, but each try still counts.
    for (let i = 0; i < 30; i++) await expect(caller.modules.licenceProof({ id: "LIC-X" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.modules.licenceProof({ id: "LIC-X" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});
