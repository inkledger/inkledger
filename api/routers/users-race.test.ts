// A manager's change to an account is checked against the account as it is when
// written, not as it was read: promoted meanwhile (the hash of a reset takes a
// while), it is beyond the manager and nothing is written.
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

const during = vi.hoisted(() => ({ hash: null as null | (() => Promise<void>) }));
vi.mock("../lib/password", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/password")>();
  return {
    ...real,
    hashPassword: async (p: string) => {
      const hook = during.hash;
      during.hash = null;
      await hook?.();
      return real.hashPassword(p);
    },
  };
});

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

describe("a manager's change races an admin's promotion", () => {
  let manager: ReturnType<typeof import("../router").appRouter.createCaller>;
  let target = 0;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    await q("INSERT INTO users (username, display_name, role, created_at) VALUES ('boss', 'Boss', 'admin', 1)");
    const [m] = await q<{ id: number }>("INSERT INTO users (username, display_name, permissions, created_at) VALUES ('keeper', 'K', '[\"manageUsers\"]', 1) RETURNING id");
    [{ id: target }] = await q<{ id: number }>("INSERT INTO users (username, display_name, password_hash, created_at) VALUES ('soon', 'Soon', 'old-hash', 1) RETURNING id");
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, m.id));
    manager = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  });

  it("a reset of an account promoted while it ran writes nothing", async () => {
    during.hash = async () => {
      await q("UPDATE users SET role = 'admin' WHERE id = ?", target);
    };
    await expect(manager.users.resetPassword({ id: target })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await q("SELECT role, password_hash FROM users WHERE id = ?", target)).toEqual([{ role: "admin", password_hash: "old-hash" }]);
  });

  it("accepting a link while the account is promoted (or given a password) sets nothing", async () => {
    const [pending] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('pending', 'P', 1) RETURNING id");
    const [m] = await q<{ id: number }>("SELECT id FROM users WHERE username = 'keeper'");
    const { createInvite } = await import("../queries/accounts");
    const { token } = await createInvite(pending.id, m.id);
    const { appRouter } = await import("../router");
    const anon = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: null, sessionId: null, remoteAddress: "192.0.2.9" });
    during.hash = async () => {
      await q("UPDATE users SET role = 'admin' WHERE id = ?", pending.id);
    };
    await expect(anon.auth.acceptInvite({ token, password: "the manager's own choice" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await q("SELECT password_hash FROM users WHERE id = ?", pending.id)).toEqual([{ password_hash: null }]);
  });
});
