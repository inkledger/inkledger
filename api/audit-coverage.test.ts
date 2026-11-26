import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The audit log, enumerated: every mutation behind a permission (permProcedure) writes
 * exactly one event, whoever calls it: done or failed for an account holding the
 * permission, refused for one that doesn't. Every sign-in, and every failed one, writes
 * exactly one too. New procedures fail here until they have a case (or a reason not to).
 */

process.env.DATABASE_URL = ":memory:";
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-audit-backups-"));
process.env.MODULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-audit-modules-"));
process.env.AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-audit-files-"));
process.env.PG_DUMP_BIN = "/nonexistent/pg_dump";

type Row = Record<string, unknown>;
type Caller = ReturnType<typeof import("./router").appRouter.createCaller>;
const q = async <T = Row>(text: string, ...params: unknown[]): Promise<T[]> => (await import("./queries/connection")).q<T>(text, ...params);

type Procedure = { _def: { type: string; inputs: unknown[]; middlewares: unknown[] } };
const isProcedure = (p: unknown): p is Procedure => typeof p === "function" && "_def" in p && typeof p._def === "object" && p._def !== null && "middlewares" in p._def;

async function procedures(): Promise<Map<string, Procedure>> {
  const { appRouter } = await import("./router");
  const out = new Map<string, Procedure>();
  for (const [k, v] of Object.entries(appRouter._def.procedures as Record<string, unknown>)) if (isProcedure(v)) out.set(k, v);
  return out;
}

/** Mutations behind a permission: more middlewares than protectedProcedure's own (as authz-idor.test.ts reads them). */
async function permMutations(): Promise<string[]> {
  const { publicQuery, protectedProcedure } = await import("./middleware");
  const layers = (b: unknown) => (Reflect.get(Reflect.get(b as object, "_def") as object, "middlewares") as unknown[]).length;
  const all = await procedures();
  const built = all.get("ping")!._def.middlewares.length - layers(publicQuery);
  return [...all]
    .filter(([, p]) => p._def.type === "mutation" && p._def.middlewares.length - p._def.inputs.length - built > layers(protectedProcedure))
    .map(([k]) => k)
    .sort();
}

/** A valid input for each, and what the event is named when it isn't the path. */
const CASES: Record<string, { input: (t: { member: number }) => unknown; action?: string }> = {
  "info.addHosts": { input: () => ({ hosts: ["laptop.local"] }) },
  "info.setAccess": { input: () => ({ customHosts: [] }) },
  "audit.setRetention": { input: () => ({ days: 120 }) },
  "feedback.setStatus": { input: () => ({ id: 999999, status: "accepted" }) },
  "feedback.setSharing": { input: () => ({ enabled: false }) },
  "alerts.setWebhook": { input: () => ({ url: "https://203.0.113.10/SECRET-hook-path", format: "json" }) },
  "alerts.test": { input: () => undefined },
  "backup.update": { input: () => ({ keep: 5 }) },
  "backup.run": { input: () => undefined },
  "backup.restore": { input: () => ({ name: "inkledger-20200101-000000.dump" }) },
  "backup.offsiteUpdate": { input: () => ({ kind: "none", secret: "SECRET-offsite-key" }) },
  "backup.offsiteUpload": { input: () => undefined },
  "backup.offsiteRestore": { input: () => ({ name: "inkledger-20200101-000000.dump" }) },
  "backup.drill": { input: () => undefined },
  "backup.drillUpdate": { input: () => ({ weekly: true }) },
  "store.requestLicense": { input: () => ({ product: "inkledger.test", email: "who@example.com", message: "hi" }) },
  "store.checkout": { input: () => ({ product: "inkledger.test", method: "card" }) },
  "store.claimPaid": { input: () => ({ product: "inkledger.test", code: "SECRET-code" }) },
  "store.install": { input: () => ({ product: "inkledger.test" }) },
  "store.restoreLicense": { input: () => ({ text: "SECRET-licence" }) },
  "store.dismiss": { input: () => ({ product: "inkledger.test" }) },
  "store.offer": { input: ({ member }) => ({ product: "inkledger.test", userId: member }) },
  "store.withdrawOffer": { input: () => ({ id: 999999 }) },
  "store.assign": { input: ({ member }) => ({ product: "inkledger.test", kind: "request", people: [{ userId: member, email: "who@example.com" }] }) },
  "store.reassign": { input: ({ member }) => ({ licence: "nope", userId: member }) },
  "modules.activate": { input: () => ({ product: "inkledger.test" }) },
  "modules.deactivate": { input: () => ({ product: "inkledger.test" }) },
  "modules.acceptToken": { input: () => ({ product: "inkledger.test", token: "SECRET-token-0123456789" }) },
  "modules.removeLicense": { input: () => ({ id: "nope" }) },
  "modules.uninstall": { input: () => ({ id: "audit-test" }) },
  "modules.setEnabled": { input: () => ({ id: "audit-test", enabled: false }) },
  "modules.importProgress": { input: () => ({ text: "{}" }) },
  "users.invite": { input: () => ({ role: "member", permissions: [], modules: [], username: `inv${Date.now()}`, displayName: "Invited" }) },
  "users.reinvite": { input: ({ member }) => ({ id: member }) },
  "users.setAccess": { input: ({ member }) => ({ id: member, role: "member", permissions: ["viewTeamTime"], modules: [] }) },
  "users.rename": { input: ({ member }) => ({ id: member, displayName: "Renamed", username: `ren${Date.now()}` }) },
  "users.resetPassword": { input: ({ member }) => ({ id: member }) },
  "users.setDisabled": { input: ({ member }) => ({ id: member, disabled: false }) },
  // The username typed wrong: refused, and still one event (the erasure itself: api/gdpr/gdpr.test.ts)
  "users.erase": { input: ({ member }) => ({ id: member, confirmUsername: "not-the-name" }) },
  "roles.create": { input: () => ({ key: `r${Date.now()}`, name: "Ops", permissions: ["manageServer"] }) },
  "roles.update": { input: () => ({ id: 999_999, name: "Gone", permissions: [] }) },
  "roles.remove": { input: () => ({ id: 999_999 }) },
  "teams.create": { input: () => ({ name: `Team ${Date.now()}` }) },
  "teams.rename": { input: () => ({ id: 999_999, name: "Gone" }) },
  "teams.remove": { input: () => ({ id: 999_999 }) },
  "teams.setMember": { input: ({ member }) => ({ teamId: 999_999, userId: member, role: "member" }) },
  "teams.removeMember": { input: ({ member }) => ({ teamId: 999_999, userId: member }) },
  "users.setBreakGlass": { input: ({ member }) => ({ id: member, breakGlass: false }) },
  "sso.createProvider": { input: () => ({ kind: "oidc", name: "Idp", issuer: "https://203.0.113.10", clientId: "client", clientSecret: "SECRET-client" }) },
  "sso.updateProvider": { input: () => ({ id: 999_999, kind: "oidc", name: "Gone", issuer: "https://203.0.113.10", clientId: "client", clientSecret: "SECRET-client" }) },
  "sso.removeProvider": { input: () => ({ id: 999_999 }) },
  "sso.setEnforced": { input: () => ({ id: 999_999, enforced: true }) },
  "sso.createScimToken": { input: () => ({ providerId: 999_999, label: "Entra" }) },
  "sso.revokeScimToken": { input: () => ({ id: 999_999 }) },
};

let n = 0;
async function account(role: "admin" | "member", permissions: string[] = [], passwordHash: string | null = null): Promise<{ id: number; caller: Caller; username: string }> {
  const { appRouter } = await import("./router");
  const { getDb } = await import("./queries/connection");
  const { users } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const username = `audit${++n}`;
  const [{ id }] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, permissions, password_hash, created_at) VALUES (?, 'Someone', ?, ?, ?, 1) RETURNING id", username, role, JSON.stringify(permissions), passwordHash);
  const [user] = await getDb().select().from(users).where(eq(users.id, id));
  return { id, username, caller: appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null, deviceId: `dev-${id}` }) };
}

async function callAt(c: Caller, at: string, input: unknown): Promise<unknown> {
  let fn: unknown = c;
  for (const k of at.split(".")) fn = Reflect.get(fn as object, k);
  if (typeof fn !== "function") throw new Error("no procedure " + at);
  return Reflect.apply(fn, undefined, [input]) as Promise<unknown>;
}

const run = (p: () => Promise<unknown>) => p().then(() => "ok", (e: unknown) => (e && typeof e === "object" && "code" in e ? String(e.code) : String(e)));
const lastId = async () => Number((await q<{ id: number | null }>("SELECT max(id) AS id FROM audit_events"))[0]?.id ?? 0);
const since = (id: number) => q<{ action: string; outcome: string; actor_user_id: number | null; after: string | null; before: string | null }>("SELECT action, outcome, actor_user_id, after, before FROM audit_events WHERE id > ? ORDER BY id", id);

beforeAll(async () => {
  const { resetDbForTests } = await import("./queries/connection");
  await resetDbForTests();
});

describe("every mutation behind a permission writes exactly one event", () => {
  it("each one has a case here, or a reason it writes none", async () => {
    const { UNAUDITED_PROCEDURES } = await import("./lib/audit");
    const found = await permMutations();
    expect(found.filter((p) => !(p in CASES) && !(p in UNAUDITED_PROCEDURES))).toEqual([]);
    expect([...Object.keys(CASES), ...Object.keys(UNAUDITED_PROCEDURES)].filter((p) => !found.includes(p))).toEqual([]);
    // Every event the middleware writes is a registered action (redacted by its own fields).
    const { isAuditAction } = await import("@contracts/audit");
    expect(Object.entries(CASES).map(([p, c]) => c.action ?? p).filter((a) => !isAuditAction(a))).toEqual([]);
  });

  it.each(Object.keys(CASES))("%s, by an admin: one event, by the admin", async (proc) => {
    const admin = await account("admin");
    const member = await account("member");
    const before = await lastId();
    const outcome = await run(() => callAt(admin.caller, proc, CASES[proc].input({ member: member.id })));
    const events = await since(before);
    expect(events.map((e) => [e.action, e.actor_user_id]), "answered " + outcome).toEqual([[CASES[proc].action ?? proc, admin.id]]);
    expect(events[0].outcome).toBe(outcome === "ok" ? "ok" : "failed");
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it.each(Object.keys(CASES))("%s, by a member without the permission: one refused event", async (proc) => {
    const member = await account("member");
    const before = await lastId();
    expect(await run(() => callAt(member.caller, proc, CASES[proc].input({ member: member.id })))).toBe("FORBIDDEN");
    expect((await since(before)).map((e) => [e.action, e.outcome, e.actor_user_id])).toEqual([[proc, "denied", member.id]]);
  });

  it("input the parser refuses is no event", async () => {
    const admin = await account("admin");
    const before = await lastId();
    expect(await run(() => admin.caller.users.setAccess({ id: "x" } as never))).toBe("BAD_REQUEST");
    expect(await since(before)).toEqual([]);
  });

  it("a change of access keeps what it was and what it became", async () => {
    const admin = await account("admin");
    const member = await account("member");
    const before = await lastId();
    await admin.caller.users.setAccess({ id: member.id, role: "member", permissions: ["viewAudit"], modules: [] });
    const [e] = await since(before);
    expect(JSON.parse(e.before ?? "{}")).toMatchObject({ role: "member", permissions: [] });
    expect(JSON.parse(e.after ?? "{}")).toMatchObject({ role: "member", permissions: ["viewAudit"] });
  });

  it("a role or a team given keeps what it was and what it became; a lead made in Teams too", async () => {
    const admin = await account("admin");
    const member = await account("member");
    const [auditor] = await q<{ id: number }>("SELECT id FROM roles WHERE key = 'auditor'");
    const team = await admin.caller.teams.create({ name: `Audited ${Date.now()}` });
    let before = await lastId();
    await admin.caller.users.setAccess({ id: member.id, roleId: auditor.id, permissions: [], modules: [], teams: [{ teamId: team.id, lead: false }] });
    const [e] = await since(before);
    expect([e.action, e.outcome]).toEqual(["users.setAccess", "ok"]);
    expect(JSON.parse(e.before ?? "{}")).toMatchObject({ role: "member", permissions: [], teams: [] });
    expect(JSON.parse(e.after ?? "{}")).toMatchObject({ role: "auditor", permissions: ["viewAudit", "exportAudit"], teams: [team.name] });
    before = await lastId();
    await admin.caller.teams.setMember({ teamId: team.id, userId: member.id, role: "lead" });
    const [lead] = await since(before);
    expect([lead.action, lead.outcome, lead.actor_user_id]).toEqual(["teams.setMember", "ok", admin.id]);
    expect(JSON.parse(lead.before ?? "{}")).toMatchObject({ role: "member" });
    expect(JSON.parse(lead.after ?? "{}")).toMatchObject({ role: "lead" });
  });
});

describe("every sign-in writes exactly one event", () => {
  const anonymous = async (headers: Record<string, string> = {}) => {
    const { appRouter } = await import("./router");
    const resHeaders = new Headers();
    return { resHeaders, caller: appRouter.createCaller({ req: new Request("http://localhost/", { headers }), resHeaders, user: null, sessionId: null, deviceId: "dev-anon" }) };
  };

  it("a password sign-in, and each way one fails", async () => {
    const { hashPassword } = await import("./lib/password");
    const hash = await hashPassword("correct horse battery");
    const ann = await account("member", [], hash);
    const off = await account("member", [], hash);
    await q("UPDATE users SET disabled_at = 1 WHERE id = ?", off.id);
    const cases: [string, { username: string; password: string }, [string, string, number | null]][] = [
      ["right password", { username: ann.username, password: "correct horse battery" }, ["auth.signIn", "ok", ann.id]],
      ["wrong password", { username: ann.username, password: "SECRET-wrong" }, ["auth.signInFailed", "failed", ann.id]],
      ["unknown account", { username: "nobody-here", password: "SECRET-wrong" }, ["auth.signInFailed", "failed", null]],
      ["account turned off", { username: off.username, password: "correct horse battery" }, ["auth.signInFailed", "failed", off.id]],
    ];
    for (const [what, input, expected] of cases) {
      const before = await lastId();
      await run(async () => (await anonymous()).caller.auth.login(input));
      const events = await since(before);
      expect.soft(events.map((e) => [e.action, e.outcome, e.actor_user_id]), what).toEqual([expected]);
      expect.soft(JSON.stringify(events), what).not.toContain("SECRET");
    }
    // A name no account has may be a password typed in the wrong field: never kept.
    const before = await lastId();
    await run(async () => (await anonymous()).caller.auth.login({ username: "SECRET-typed-here", password: "x" }));
    expect(JSON.stringify(await q("SELECT * FROM audit_events WHERE id > ?", before))).not.toContain("SECRET");
  });

  it("a remembered device resuming, and one the server no longer knows", async () => {
    const { hashPassword } = await import("./lib/password");
    const bea = await account("member", [], await hashPassword("correct horse battery"));
    const first = await anonymous();
    await first.caller.auth.login({ username: bea.username, password: "correct horse battery" });
    const cookies = first.resHeaders.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    let before = await lastId();
    await (await anonymous({ cookie: cookies })).caller.auth.resume();
    expect((await since(before)).map((e) => [e.action, e.outcome, e.actor_user_id, (JSON.parse(e.after ?? "{}") as { method?: string }).method])).toEqual([["auth.signIn", "ok", bea.id, "remembered"]]);
    // The same token again: taken by the resume above.
    before = await lastId();
    expect(await run(async () => (await anonymous({ cookie: cookies })).caller.auth.resume())).toBe("UNAUTHORIZED");
    expect((await since(before)).map((e) => [e.action, e.outcome])).toEqual([["auth.signInFailed", "failed"]]);
  });

  it("an invite accepted signs in once", async () => {
    const admin = await account("admin");
    const { link } = await admin.caller.users.invite({ role: "member", permissions: [], modules: [], username: "invitee", displayName: "Invitee" });
    const before = await lastId();
    await (await anonymous()).caller.auth.acceptInvite({ token: link.split("/").at(-1)!, password: "a long enough password" });
    expect((await since(before)).map((e) => [e.action, (JSON.parse(e.after ?? "{}") as { method?: string }).method])).toEqual([["auth.signIn", "invite"]]);
  });
});

describe("other people's time read", () => {
  it("a team report read is one event per reader and range (refetches write none)", async () => {
    const lead = await account("member", ["viewTeamTime"]);
    const before = await lastId();
    await lead.caller.team.overview({ from: "2026-11-01", to: "2026-11-30" });
    await lead.caller.team.overview({ from: "2026-11-01", to: "2026-11-30" });
    expect((await since(before)).map((e) => [e.action, e.actor_user_id])).toEqual([["team.overview", lead.id]]);
  });
});

