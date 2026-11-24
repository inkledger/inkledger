// inkledger's own accounts: who exists on this server, what they may do, how they
// get in (password, invite link), and turning access off again.
import { randomBytes } from "node:crypto";
import { sha256Hex } from "../lib/hash";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { invites, rememberedDevices, roleAssignments, roles, sessions, teamMembers, teams, users, type RoleRow, type User } from "@db/schema";
import { DEFAULT_ADMIN, INVITE_DAYS, OWNER_ONLY_PERMISSIONS, PERMISSIONS, type Permission, type Role, type RoleScope, type TeamRole } from "@contracts/accounts";
import { moduleIdSchema } from "@contracts/modulesSchema";
import { env } from "../lib/env";
import { parseStringList } from "../lib/json";
import { hashPassword } from "../lib/password";
import { getDb, type Db } from "./connection";

const isPermission = (x: unknown): x is Permission => typeof x === "string" && (PERMISSIONS as readonly string[]).includes(x);

/** Known permissions out of stored JSON, in PERMISSIONS order. */
export const parsePermissions = (stored: string | null | undefined): Permission[] => {
  const granted = parseStringList(stored ?? "[]");
  return PERMISSIONS.filter((p) => granted.includes(p));
};

/** A role as access reads it. */
export type RoleAccess = { id: number; key: string; name: string; scope: RoleScope; system: boolean; permissions: Permission[] };

export const roleAccess = (r: RoleRow): RoleAccess => ({
  id: r.id,
  key: r.key,
  name: r.name,
  scope: r.scope === "team" ? "team" : "server",
  system: r.system === 1,
  // The owner holds every permission, whatever is stored (later ones too).
  permissions: r.key === "owner" ? [...PERMISSIONS] : parsePermissions(r.permissions),
});

/**
 * What an account holds besides its own grants: owner or not, its role (users.role_id),
 * other roles held server-wide, and roles held within a team (a lead's team-lead).
 */
export type Access = {
  owner: boolean;
  role: RoleAccess | null;
  extra: RoleAccess[];
  teams: { teamId: number; role: RoleAccess }[];
};

/** An account with its access read (withAccess): what the resolver below takes. */
export type Account = User & { access: Access };

/** The roles' table, by id (one read per call: access is read per request). */
/** Where access is read from: the database, or a transaction under way (never the other while one is open). */
export type Reader = Pick<Db, "select">;

async function rolesById(ids: number[], db: Reader = getDb()): Promise<Map<number, RoleAccess>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(roles).where(inArray(roles.id, ids));
  return new Map(rows.map((r) => [r.id, roleAccess(r)]));
}

/** The account's access, read now: its role, and the roles assigned to it (server-wide or per team). */
export async function withAccess(user: User, db: Reader = getDb()): Promise<Account> {
  const assigned = await db.select({ roleId: roleAssignments.roleId, teamId: roleAssignments.teamId }).from(roleAssignments).where(eq(roleAssignments.userId, user.id));
  const byId = await rolesById([...new Set([...(user.roleId === null ? [] : [user.roleId]), ...assigned.map((a) => a.roleId)])], db);
  const role = user.roleId === null ? null : (byId.get(user.roleId) ?? null);
  const extra: RoleAccess[] = [];
  const teams: Access["teams"] = [];
  for (const a of assigned) {
    const r = byId.get(a.roleId);
    if (!r) continue;
    if (a.teamId === null) extra.push(r);
    else teams.push({ teamId: a.teamId, role: r });
  }
  // users.role "admin" is the owner role (older rows, tests, the first admin); role_id names it too.
  const owner = user.role === "admin" || role?.key === "owner";
  return { ...user, access: { owner, role, extra, teams } };
}

/** Accounts with their access, for several at once. */
export const withAccessAll = (list: User[]): Promise<Account[]> => Promise.all(list.map((u) => withAccess(u)));

/**
 * The single resolver: what the account may do on the whole server. An owner, all of it;
 * anyone else its role's, the roles held server-wide, and its own grants. A role meant for
 * teams (team-lead) given as the account's role holds nothing server-wide.
 */
export function permissionsOf(user: Account): Permission[] {
  if (user.access.owner) return [...PERMISSIONS];
  const held = new Set<Permission>(parsePermissions(user.permissions));
  for (const r of [user.access.role, ...user.access.extra]) {
    if (r && (r.scope === "server" || user.access.extra.includes(r))) for (const p of r.permissions) held.add(p);
  }
  return PERMISSIONS.filter((p) => held.has(p));
}

export const can = (user: Account, permission: Permission) => permissionsOf(user).includes(permission);

/** Where the account holds a permission: the whole server, or these teams (none: nowhere). */
export function scopeOf(user: Account, permission: Permission): "all" | number[] {
  if (can(user, permission)) return "all";
  return [...new Set(user.access.teams.filter((t) => t.role.permissions.includes(permission)).map((t) => t.teamId))].sort((a, b) => a - b);
}

/** Holds it anywhere: server-wide or within a team (what a procedure's gate asks). */
export const holds = (user: Account, permission: Permission) => {
  const scope = scopeOf(user, permission);
  return scope === "all" || scope.length > 0;
};

/** Permissions held only within teams (a lead's viewTeamTime), for the client. */
export const scopedPermissionsOf = (user: Account): Permission[] => PERMISSIONS.filter((p) => !can(user, p) && holds(user, p));

/** The module ids granted to the account, as stored (an owner's don't matter: it runs every module). */
export function grantsOf(user: Pick<User, "moduleGrants">): string[] {
  return parseStringList(user.moduleGrants).filter((g) => moduleIdSchema.safeParse(g).success);
}

/** Whether the account runs this module: an owner runs every one; anyone else needs useModules and the module granted. */
export const mayRunModule = (user: Account, id: string) => user.access.owner || (can(user, "useModules") && grantsOf(user).includes(id));

/** Access as the escalation guard compares it: owner or not, the effective sets, per team too. */
export type Granted = {
  owner: boolean;
  permissions: readonly string[];
  teams: readonly { teamId: number; permissions: readonly string[] }[];
  modules: readonly string[];
};

/** What an account holds, as `Granted`. */
export const grantedOf = (user: Account): Granted => ({
  owner: user.access.owner,
  permissions: permissionsOf(user),
  teams: user.access.teams.map((t) => ({ teamId: t.teamId, permissions: t.role.permissions })),
  modules: grantsOf(user),
});

/**
 * `granted` is within what `by` holds: an owner holds anything; anyone else never
 * the owner role, nor a power it lacks (on the server, or in that team), nor a module it
 * doesn't run itself.
 */
export function within(by: Account, granted: Granted): boolean {
  if (by.access.owner) return true;
  const mine: readonly string[] = permissionsOf(by);
  return (
    !granted.owner &&
    granted.permissions.every((p) => mine.includes(p)) &&
    granted.teams.every((t) =>
      t.permissions.every((p) => {
        if (!isPermission(p)) return false;
        const scope = scopeOf(by, p);
        return scope === "all" || scope.includes(t.teamId);
      }),
    ) &&
    granted.modules.every((m) => mayRunModule(by, m))
  );
}

/** Holds a power only an owner hands out (OWNER_ONLY_PERMISSIONS), on the server or in a team. */
export const holdsOwnerOnly = (g: Granted) =>
  g.owner || g.permissions.some((p) => (OWNER_ONLY_PERMISSIONS as readonly string[]).includes(p)) || g.teams.some((t) => t.permissions.some((p) => (OWNER_ONLY_PERMISSIONS as readonly string[]).includes(p)));

/** Permissions as stored: known ones only, in a stable order. */
export const storedPermissions = (granted: readonly unknown[]) => JSON.stringify(PERMISSIONS.filter((p) => granted.some((g) => isPermission(g) && g === p)));

/** Module grants as stored: valid ids, once each, sorted. */
export const storedGrants = (granted: readonly string[]) =>
  JSON.stringify([...new Set(granted.filter((g) => moduleIdSchema.safeParse(g).success))].sort());

/** users.role as older builds read it: "admin" for an owner. */
export const roleOf = (user: Pick<User, "role">): Role => (user.role === "admin" ? "admin" : "member");

/** A role by its key (the system ones always exist: their migration seeds them). */
export async function roleByKey(key: string, db: Reader = getDb()): Promise<RoleAccess | undefined> {
  const [row] = await db.select().from(roles).where(eq(roles.key, key)).limit(1);
  return row ? roleAccess(row) : undefined;
}

export async function roleById(id: number, db: Reader = getDb()): Promise<RoleAccess | undefined> {
  return (await rolesById([id], db)).get(id);
}

/** Every role, system ones first. */
export async function listRoles(): Promise<RoleAccess[]> {
  const rows = await getDb().select().from(roles).orderBy(desc(roles.system), asc(roles.id));
  return rows.map(roleAccess);
}

/** The teams an account is in, with its place in each. */
export async function teamsOf(userIds: number[]): Promise<Map<number, { teamId: number; name: string; role: TeamRole }[]>> {
  const out = new Map<number, { teamId: number; name: string; role: TeamRole }[]>(userIds.map((id) => [id, []]));
  if (userIds.length === 0) return out;
  const rows = await getDb()
    .select({ userId: teamMembers.userId, teamId: teams.id, name: teams.name, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(inArray(teamMembers.userId, userIds))
    .orderBy(asc(teams.name));
  for (const r of rows) out.get(r.userId)?.push({ teamId: r.teamId, name: r.name, role: r.role === "lead" ? "lead" : "member" });
  return out;
}

/** The accounts in these teams. */
export async function membersOf(teamIds: readonly number[]): Promise<number[]> {
  if (teamIds.length === 0) return [];
  const rows = await getDb().selectDistinct({ userId: teamMembers.userId }).from(teamMembers).where(inArray(teamMembers.teamId, [...teamIds]));
  return rows.map((r) => r.userId);
}

export async function userByUsername(username: string): Promise<User | undefined> {
  const [row] = await getDb()
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
    .limit(1);
  return row;
}

export async function userById(id: number): Promise<User | undefined> {
  const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

/** Where a production server leaves its first admin's random password (INITIAL_ADMIN_PASSWORD_PATH, else data/). */
const initialAdminPasswordFile = () => process.env.INITIAL_ADMIN_PASSWORD_PATH || path.resolve("data/initial-admin-password");

/**
 * A new server starts with one admin, "admin", whose password must be changed
 * at the first sign-in: INKLEDGER_ADMIN_PASSWORD; unset, in production a random
 * one written to a file only this server's user can read (whoever reaches the
 * server first could otherwise take it with a public default), "admin" in
 * development. Nothing happens once any admin exists: an upgraded server keeps
 * the people it had, who activate their own accounts. Returns whether it made the admin.
 */
export async function ensureAdmin(o: { production?: boolean; password?: string | null } = {}): Promise<boolean> {
  const db = getDb();
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  if (admin) return false;
  const given = o.password !== undefined ? o.password : env.adminPassword;
  let password = given ?? "admin";
  if (!given && (o.production ?? env.isProduction)) {
    password = randomBytes(18).toString("base64url");
    const file = initialAdminPasswordFile();
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${password}\n`, { mode: 0o600 });
    // A file already there keeps its mode on overwrite.
    chmodSync(file, 0o600);
    console.log(`[accounts] the "${DEFAULT_ADMIN}" account's first password is in ${file}: sign in and change it`);
  }
  const owner = await roleByKey("owner");
  await db.insert(users).values({
    username: DEFAULT_ADMIN,
    displayName: "Admin",
    role: "admin",
    roleId: owner?.id ?? null,
    passwordHash: await hashPassword(password),
    mustChangePassword: 1,
  });
  return true;
}

/** The first admin's random password, once changed: its file goes. */
export function forgetInitialAdminPassword() {
  rmSync(initialAdminPasswordFile(), { force: true });
}

/** True while the default admin still has the password it started with (the start log warns). */
export async function defaultAdminPending(): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(and(sql`lower(${users.username}) = ${DEFAULT_ADMIN}`, eq(users.mustChangePassword, 1), isNull(users.disabledAt)))
    .limit(1);
  return Boolean(row);
}

/** Every session and remembered device of a user ends (password changed, reset, disabled). */
export async function signOutEverywhere(userId: number, keepSessionId?: string | null) {
  // The account's row locked: a resume under way (which holds it) lands before this or not at all.
  await getDb().transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    await tx.delete(rememberedDevices).where(eq(rememberedDevices.userId, userId));
    // One statement, however many sessions.
    await tx.delete(sessions).where(and(eq(sessions.userId, userId), ...(keepSessionId ? [ne(sessions.id, keepSessionId)] : [])));
  });
}

/** Remembered devices and invite links past their date: nothing opens with them any more, so they go (with the sessions' purge). */
export async function purgeExpiredAccess(now = Date.now()): Promise<{ devices: number; invites: number }> {
  const db = getDb();
  const devices = await db.delete(rememberedDevices).where(sql`${rememberedDevices.expiresAt} <= ${now}`).returning({ id: rememberedDevices.id });
  const links = await db.delete(invites).where(sql`${invites.expiresAt} <= ${now}`).returning({ id: invites.id });
  return { devices: devices.length, invites: links.length };
}

const hashToken = (token: string) => sha256Hex(token);

/** A one-time invite link token for a user (earlier unused ones stop working). Only its hash is kept. */
export async function createInvite(userId: number, createdBy: number | null): Promise<{ token: string; expiresAt: Date }> {
  const db = getDb();
  await db.delete(invites).where(and(eq(invites.userId, userId), isNull(invites.usedAt)));
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  await db.insert(invites).values({ id: hashToken(token), userId, createdBy, expiresAt });
  return { token, expiresAt };
}

/**
 * The user an invite token is for, while unused and unexpired; and only while the link
 * still does what it was made for: the account has no password yet, and whoever made
 * the link could still make it (on, managing accounts) and give it the access it has
 * now (else a manager's link, kept, would open an account promoted since).
 */
export async function inviteUser(token: string): Promise<{ inviteId: string; user: User } | null> {
  const id = hashToken(token);
  const [row] = await getDb()
    .select({ user: users, createdBy: invites.createdBy })
    .from(invites)
    .innerJoin(users, eq(invites.userId, users.id))
    .where(and(eq(invites.id, id), isNull(invites.usedAt), gt(invites.expiresAt, new Date()), isNull(users.disabledAt), isNull(users.passwordHash)))
    .limit(1);
  if (!row) return null;
  const found = row.createdBy === null ? undefined : await userById(row.createdBy);
  const maker = found ? await withAccess(found) : null;
  // Its maker must still be able to make it: on, managing accounts, holding what the account has.
  if (maker && (maker.disabledAt || !can(maker, "manageUsers") || !within(maker, grantedOf(await withAccess(row.user))))) return null;
  return { inviteId: id, user: row.user };
}

/** Uses up an invite: true only for the first caller (two tabs can't both set a password). */
export async function consumeInvite(inviteId: string): Promise<boolean> {
  const done = await getDb()
    .update(invites)
    .set({ usedAt: new Date() })
    .where(and(eq(invites.id, inviteId), isNull(invites.usedAt)))
    .returning({ id: invites.id });
  return done.length === 1;
}
