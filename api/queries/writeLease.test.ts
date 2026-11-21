import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("the write lease", () => {
  const saved = { leaseMs: 0, beatMs: 0 };

  beforeAll(async () => {
    await (await import("./connection")).resetDbForTests();
    const { writeLeaseTiming } = await import("./writeLease");
    Object.assign(saved, writeLeaseTiming);
    Object.assign(writeLeaseTiming, { leaseMs: 400, beatMs: 100 });
  });
  afterAll(async () => Object.assign((await import("./writeLease")).writeLeaseTiming, saved));

  it("is kept while a write outlasts it: another process never takes it meanwhile", async () => {
    const { q } = await import("./connection");
    const { withWriteLease } = await import("./writeLease");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('lease', 'Lease', 1) RETURNING id");
    // Another process tries the way acquire() does: it wins only an expired lease.
    const tries: boolean[] = [];
    const other = async () => {
      const now = Date.now();
      const got = await q<{ holder: string }>(
        "INSERT INTO write_leases (user_id, holder, expires_at) VALUES (?, 'other', ?) ON CONFLICT (user_id) DO UPDATE SET holder = 'other', expires_at = excluded.expires_at WHERE write_leases.expires_at < ? RETURNING holder",
        u.id,
        now + 400,
        now,
      );
      tries.push(got[0]?.holder === "other");
    };
    await withWriteLease(u.id, async () => {
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 100));
        await other();
      }
    });
    expect(tries.some(Boolean)).toBe(false);
  });
});
