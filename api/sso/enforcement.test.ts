import { describe, it, expect, beforeAll } from "vitest";

/**
 * Single sign-on enforced: password sign-in only for break-glass owners; every other way to a
 * password or a session without the provider is closed (login, remembered device, invite,
 * re-invite, reset, activation), and enforcement can't lock everyone out.
 */

process.env.DATABASE_URL = ":memory:";

type Router = typeof import("../router").appRouter;
type Ctx = import("../context").TrpcContext;
type User = import("@db/schema").User;

const q = async <T = Record<string, unknown>>(text: string, ...params: unknown[]) => (await import("../queries/connection")).q<T>(text, ...params);
const PASSWORD = "a long enough password";
let ip = 0;
let appRouter: Router;

const anon = (): Ctx => ({ req: new Request("http://localhost/api/trpc"), resHeaders: new Headers(), user: null, sessionId: null, remoteAddress: `198.51.100.${++ip % 250}` });
const as = (user: User): Ctx => ({ ...anon(), user, sessionId: null });

async function account(username: string, extra: Partial<typeof import("@db/schema").users.$inferInsert> = {}): Promise<User> {
  const { hashPassword } = await import("../lib/password");
  const { getDb } = await import("../queries/connection");
  const { users } = await import("@db/schema");
  const [u] = await getDb().insert(users).values({ username, displayName: username, passwordHash: await hashPassword(PASSWORD), ...extra }).returning();
  return u;
}

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e && typeof e === "object" && "code" in e ? String(e.code) : String(e)));

let owner: User;
let spare: User;
let providerId: number;

beforeAll(async () => {
  const { resetDbForTests } = await import("../queries/connection");
  await resetDbForTests();
  ({ appRouter } = await import("../router"));
  // Only these owners: the seeded default admin is turned off.
  await q("UPDATE users SET disabled_at = 1 WHERE role = 'admin'");
  owner = await account("owner1", { role: "admin" });
  spare = await account("owner2", { role: "admin" });
  const [{ id }] = await q<{ id: number }>("INSERT INTO identity_providers (kind, name, issuer, client_id, created_at) VALUES ('oidc', 'Corp', 'https://idp.example', 'c', 1) RETURNING id");
  providerId = id;
});

describe("before enforcing", () => {
  it("an account of the identity provider never signs in with a password", async () => {
    await account("ssouser", { authSource: "sso" });
    expect(await code(appRouter.createCaller(anon()).auth.login({ username: "ssouser", password: PASSWORD }))).toBe("FORBIDDEN");
  });

  it("enforcing is refused while no owner keeps password sign-in (break-glass)", async () => {
    expect(await code(appRouter.createCaller(as(owner)).sso.setEnforced({ id: providerId, enforced: true }))).toBe("BAD_REQUEST");
  });

  it("break-glass is for local accounts only", async () => {
    const sso = await account("ssouser2", { authSource: "sso", role: "admin" });
    expect(await code(appRouter.createCaller(as(owner)).users.setBreakGlass({ id: sso.id, breakGlass: true }))).toBe("FORBIDDEN");
  });
});

describe("enforced", () => {
  beforeAll(async () => {
    const caller = appRouter.createCaller(as(owner));
    await caller.users.setBreakGlass({ id: owner.id, breakGlass: true });
    await caller.sso.setEnforced({ id: providerId, enforced: true });
  });

  it("a local account that isn't break-glass can't sign in with its password; a break-glass owner can", async () => {
    await account("mario");
    expect(await code(appRouter.createCaller(anon()).auth.login({ username: "mario", password: PASSWORD }))).toBe("FORBIDDEN");
    expect(await code(appRouter.createCaller(anon()).auth.login({ username: "owner1", password: PASSWORD }))).toBe("ok");
  });

  it("the login page learns enforcement and the providers to offer", async () => {
    expect(await appRouter.createCaller(anon()).sso.loginOptions()).toEqual({ providers: [{ id: providerId, name: "Corp", kind: "oidc" }], enforced: true });
  });

  it("no password by reset, invite or re-invite for anyone but break-glass", async () => {
    const caller = appRouter.createCaller(as(owner));
    const member = await account("luigi");
    expect(await code(caller.users.resetPassword({ id: member.id }))).toBe("FORBIDDEN");
    expect(await code(caller.users.invite({ role: "member", permissions: [], modules: [], username: "newbie", displayName: "Newbie" }))).toBe("FORBIDDEN");
    const pending = await account("pending1", { passwordHash: null });
    expect(await code(caller.users.reinvite({ id: pending.id }))).toBe("FORBIDDEN");
  });

  it("an invite made before enforcing can't be accepted now", async () => {
    const { createInvite } = await import("../queries/accounts");
    const pending = await account("pending2", { passwordHash: null });
    const { token } = await createInvite(pending.id, owner.id);
    expect(await code(appRouter.createCaller(anon()).auth.acceptInvite({ token, password: PASSWORD }))).toBe("FORBIDDEN");
  });

  it("the last break-glass owner keeps it, and stays on", async () => {
    const caller = appRouter.createCaller(as(spare));
    expect(await code(caller.users.setBreakGlass({ id: owner.id, breakGlass: false }))).toBe("BAD_REQUEST");
    expect(await code(caller.users.setDisabled({ id: owner.id, disabled: true }))).toBe("BAD_REQUEST");
  });

  it("with a second break-glass owner, the first may give it up", async () => {
    const caller = appRouter.createCaller(as(owner));
    await caller.users.setBreakGlass({ id: spare.id, breakGlass: true });
    expect(await code(caller.users.setBreakGlass({ id: owner.id, breakGlass: false }))).toBe("ok");
  });

  it("a provider turned off stops enforcing", async () => {
    const { ssoEnforced } = await import("./store");
    expect(await ssoEnforced()).toBe(true);
    await q("UPDATE identity_providers SET disabled_at = 1 WHERE id = ?", providerId);
    expect(await ssoEnforced()).toBe(false);
  });
});
