// inkledger's own accounts: who exists on this server, what they may do, how they
// get in (password, invite link), and turning access off again.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { invites, rememberedDevices, sessions, users, type User } from "@db/schema";
import { DEFAULT_ADMIN, INVITE_DAYS, PERMISSIONS, type Permission, type Role } from "@contracts/accounts";
import { env } from "../lib/env";
import { hashPassword } from "../lib/password";
import { getDb } from "./connection";

const isPermission = (x: unknown): x is Permission => typeof x === "string" && (PERMISSIONS as readonly string[]).includes(x);

/** What the user may do on the server: everything for an admin, what was granted otherwise. */
export function permissionsOf(user: Pick<User, "role" | "permissions">): Permission[] {
  if (user.role === "admin") return [...PERMISSIONS];
  try {
    const granted = JSON.parse(user.permissions) as unknown;
    return Array.isArray(granted) ? PERMISSIONS.filter((p) => granted.includes(p)) : [];
  } catch {
    return [];
  }
}

export const can = (user: Pick<User, "role" | "permissions">, permission: Permission) => permissionsOf(user).includes(permission);

/** `granted` is within what `by` holds: an admin holds anything; anyone else never admin, nor a power it lacks. */
export function within(by: Pick<User, "role" | "permissions">, granted: { role: string; permissions: readonly string[] }): boolean {
  if (roleOf(by) === "admin") return true;
  const mine: readonly string[] = permissionsOf(by);
  return granted.role !== "admin" && granted.permissions.every((p) => mine.includes(p));
}

/** Permissions as stored: known ones only, in a stable order. */
export const storedPermissions = (granted: readonly unknown[]) => JSON.stringify(PERMISSIONS.filter((p) => granted.some((g) => isPermission(g) && g === p)));

export const roleOf = (user: Pick<User, "role">): Role => (user.role === "admin" ? "admin" : "member");

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

/**
 * A new server starts with one admin, "admin", whose password (INKLEDGER_ADMIN_PASSWORD,
 * else "admin") must be changed at the first sign-in. Nothing happens once
 * any admin exists: an upgraded server keeps the people it had, who activate
 * their own accounts. Returns whether it made the admin.
 */
export async function ensureAdmin(): Promise<boolean> {
  const db = getDb();
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
  if (admin) return false;
  await db.insert(users).values({
    username: DEFAULT_ADMIN,
    displayName: "Admin",
    role: "admin",
    passwordHash: await hashPassword(env.adminPassword),
    mustChangePassword: 1,
  });
  return true;
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
  const db = getDb();
  await db.delete(rememberedDevices).where(eq(rememberedDevices.userId, userId));
  // One statement, however many sessions.
  await db.delete(sessions).where(and(eq(sessions.userId, userId), ...(keepSessionId ? [ne(sessions.id, keepSessionId)] : [])));
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

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
  const maker = row.createdBy === null ? null : await userById(row.createdBy);
  // Its maker must still be able to make it: on, managing accounts, holding what the account has.
  if (maker && (maker.disabledAt || !can(maker, "manageUsers") || !within(maker, { role: roleOf(row.user), permissions: permissionsOf(row.user) }))) return null;
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
