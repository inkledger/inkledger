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

// An account as read before the write (stale): set by a test, otherwise the real read.
const stale = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock("../queries/accounts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../queries/accounts")>();
  return {
    ...real,
    userById: async (id: number) => {
      const read = stale.user;
      stale.user = null;
      return read ? ({ ...(await real.userById(id)), ...read } as Awaited<ReturnType<typeof real.userById>>) : real.userById(id);
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

  it("accepting a link while its maker is turned off sets nothing", async () => {
    const [pending] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('pending2', 'P', 1) RETURNING id");
    const [m] = await q<{ id: number }>("INSERT INTO users (username, display_name, permissions, created_at) VALUES ('maker2', 'M', '[\"manageUsers\"]', 1) RETURNING id");
    const { createInvite } = await import("../queries/accounts");
    const { token } = await createInvite(pending.id, m.id);
    const { appRouter } = await import("../router");
    const anon = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: null, sessionId: null, remoteAddress: "192.0.2.10" });
    during.hash = async () => {
      await q("UPDATE users SET disabled_at = ? WHERE id = ?", Date.now(), m.id);
    };
    await expect(anon.auth.acceptInvite({ token, password: "a link from someone turned off" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await q("SELECT password_hash FROM users WHERE id = ?", pending.id)).toEqual([{ password_hash: null }]);
  });

  it("an admin's write read on an account promoted since can't leave the server without an admin", async () => {
    // X, promoted meanwhile, has turned A off: X is the last active admin. A's request
    // (signed in before) read X as the member it was.
    const [a] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, disabled_at, created_at) VALUES ('was-admin', 'A', 'admin', ?, 1) RETURNING id", Date.now());
    const [x] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES ('promoted', 'X', 'admin', 1) RETURNING id");
    await q("UPDATE users SET disabled_at = ? WHERE role = 'admin' AND id NOT IN (?, ?)", Date.now(), a.id, x.id);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [admin] = await getDb().select().from(users).where(eq(users.id, a.id));
    const asA = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: { ...admin, disabledAt: null }, sessionId: null });
    stale.user = { role: "member" };
    await expect(asA.users.setDisabled({ id: x.id, disabled: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await q("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL")).toEqual([{ n: 1 }]);
  });
});
