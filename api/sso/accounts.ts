// Who a single sign-on brings: the account linked to the provider's subject (never by
// address), one SCIM provisioned for it, or a new one made just in time. Access comes from
// the provider's group map, else its default; never an owner unless a group explicitly maps
// to the owner role. Accounts made by single sign-on get it again at every sign-in.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { scimTokens, teamMembers, teams, userIdentities, users, type IdentityProvider, type User } from "@db/schema";
import { OWNER_ONLY_PERMISSIONS, USERNAME_RE, type Permission } from "@contracts/accounts";
import type { GroupMapEntry, SsoAccess, SsoFailure } from "@contracts/sso";
import { getDb, uniqueViolation } from "../queries/connection";
import { assertOwnerStays, lockOwners, OwnerLockError, permissionsOf, roleById, roleByKey, storedPermissions, withAccess, type Tx } from "../queries/accounts";
import { record, type AuditRequest } from "../lib/audit";
import { defaultAccessOf, groupMapOf, ssoEnforced } from "./store";

/** What a provider says about the person, read through its claim map. */
export type Identity = { subject: string; username: string; email: string; name: string; groups: string[] };

/** Access as resolved for an account: the owner role only when a group explicitly maps to it. */
export type Resolved = { owner: boolean; roleId: number | null; permissions: Permission[]; teamIds: number[] };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The access a provider hands to someone in `groups` (pure). The matching entries of the
 * group map, together; none matching, the default access, clamped: never the owner role
 * nor a power only an owner hands out (an unmapped group must not make an admin).
 */
export function resolveAccess(groupMap: readonly GroupMapEntry[], defaults: SsoAccess, groups: readonly string[], ownerRoleId: number | null): Resolved {
  const matched = groupMap.filter((e) => groups.some((g) => same(g, e.group)));
  if (matched.length === 0) {
    const roleId = defaults.roleId != null && defaults.roleId !== ownerRoleId ? defaults.roleId : null;
    const permissions = defaults.permissions.filter((p) => !OWNER_ONLY_PERMISSIONS.includes(p));
    return { owner: false, roleId, permissions: [...new Set(permissions)], teamIds: [...new Set(defaults.teamIds)].sort((a, b) => a - b) };
  }
  const owner = ownerRoleId !== null && matched.some((e) => e.roleId === ownerRoleId);
  const roleId = owner ? ownerRoleId : (matched.find((e) => e.roleId != null)?.roleId ?? null);
  return {
    owner,
    roleId,
    permissions: [...new Set(matched.flatMap((e) => e.permissions))],
    teamIds: [...new Set(matched.flatMap((e) => e.teamIds))].sort((a, b) => a - b),
  };
}

/** The teams a provider manages membership of: those its group map or default access names. */
export function managedTeams(groupMap: readonly GroupMapEntry[], defaults: SsoAccess): number[] {
  return [...new Set([...groupMap.flatMap((e) => e.teamIds), ...defaults.teamIds])];
}

/** A username from what the provider sent: lowercase, the allowed characters only, at most 32. */
export function usernameFrom(identity: Pick<Identity, "username" | "email" | "subject">): string {
  const raw = (identity.username || identity.email.split("@")[0] || identity.subject).toLowerCase();
  let name = raw.replace(/@.*$/, "").replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 32);
  if (name.length < 2) name = `user-${name}`.slice(0, 32);
  return USERNAME_RE.test(name) ? name : "user";
}

/** The n-th candidate for a username taken already: "mario", "mario-2", "mario-3"… within 32 characters. */
const candidate = (base: string, n: number) => (n === 1 ? base : `${base.slice(0, 32 - String(n).length - 1)}-${n}`);

/** Access as written to the account (users.role and its role together; teams within the managed ones). */
export async function writeAccess(tx: Tx, userId: number, access: Resolved, managed: readonly number[]): Promise<void> {
  await tx
    .update(users)
    .set({ role: access.owner ? "admin" : "member", roleId: access.roleId, permissions: storedPermissions(access.permissions) })
    .where(eq(users.id, userId));
  if (managed.length === 0) return;
  const known = access.teamIds.length ? (await tx.select({ id: teams.id }).from(teams).where(inArray(teams.id, access.teamIds))).map((r) => r.id) : [];
  const leave = managed.filter((id) => !known.includes(id));
  // Places it leads are left alone (an admin made it lead): only plain membership follows the provider.
  if (leave.length) await tx.delete(teamMembers).where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, leave), eq(teamMembers.role, "member")));
  if (known.length) await tx.insert(teamMembers).values(known.map((teamId) => ({ teamId, userId, role: "member" }))).onConflictDoNothing();
}

/** A role id that still is a server-wide role (one removed since the map was saved counts as none). */
async function liveRole(access: Resolved): Promise<Resolved> {
  if (access.roleId === null) return access;
  const role = await roleById(access.roleId);
  return role && role.scope === "server" ? access : { ...access, roleId: null, owner: false };
}

/** The access this provider hands to these groups, with the roles as they are now. */
export async function accessFor(provider: IdentityProvider, groups: readonly string[]): Promise<Resolved> {
  const owner = await roleByKey("owner");
  return liveRole(resolveAccess(groupMapOf(provider), defaultAccessOf(provider), groups, owner?.id ?? null));
}

const viewOfAccess = (a: Resolved) => ({ role: a.owner ? "owner" : a.roleId, permissions: a.permissions, teams: a.teamIds });

/** An account SCIM provisioned for this provider, by the userName both sides know, not yet linked. */
async function provisioned(provider: IdentityProvider, identity: Identity): Promise<User | undefined> {
  if (!identity.username) return undefined;
  const [token] = await getDb().select({ id: scimTokens.id }).from(scimTokens).where(eq(scimTokens.providerId, provider.id)).limit(1);
  if (!token) return undefined;
  const [found] = await getDb()
    .select({ user: users })
    .from(users)
    .leftJoin(userIdentities, eq(userIdentities.userId, users.id))
    .where(and(eq(users.scimManaged, 1), sql`lower(${users.scimUserName}) = ${identity.username.toLowerCase()}`, isNull(userIdentities.id)))
    .limit(1);
  return found?.user;
}

/** Links an account to the provider's subject (a second link of the same subject at once loses: the first one stays). */
async function link(providerId: number, userId: number, identity: Identity): Promise<void> {
  await getDb().insert(userIdentities).values({ providerId, userId, subject: identity.subject, emailAtLink: identity.email }).onConflictDoNothing();
}

async function linked(providerId: number, subject: string): Promise<User | undefined> {
  const [row] = await getDb()
    .select({ user: users })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.providerId, providerId), eq(userIdentities.subject, subject)))
    .limit(1);
  return row?.user;
}

/**
 * A new account for someone the provider vouches for, and its link, in one transaction: two
 * callbacks of the same person at once make one account (the link's unique key on provider
 * and subject turns the second away, whose account goes with its transaction).
 */
async function makeAccount(provider: IdentityProvider, identity: Identity, who: AuditRequest): Promise<User> {
  const access = await accessFor(provider, identity.groups);
  const managed = managedTeams(groupMapOf(provider), defaultAccessOf(provider));
  const base = usernameFrom(identity);
  for (let n = 1; n <= 50; n++) {
    try {
      const made = await getDb().transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ username: candidate(base, n), displayName: identity.name || identity.username || base, email: identity.email, authSource: "sso", passwordHash: null })
          .returning();
        await tx.insert(userIdentities).values({ providerId: provider.id, userId: user.id, subject: identity.subject, emailAtLink: identity.email, lastLoginAt: new Date() });
        await writeAccess(tx, user.id, access, managed);
        const [now] = await tx.select().from(users).where(eq(users.id, user.id));
        return now;
      });
      await record(who, "sso.accountCreated", { target: { type: "user", id: made.id, ownerUserId: made.id }, after: { username: made.username, provider: provider.name, ...viewOfAccess(access) } });
      return made;
    } catch (e) {
      if (!uniqueViolation(e)) throw e;
      // Linked meanwhile by another callback of the same person: that account is the one.
      const other = await linked(provider.id, identity.subject);
      if (other) return other;
      // Else the username was taken: the next candidate.
    }
  }
  throw new Error("no free username");
}

/**
 * Access again from the groups, for an account single sign-on made. Taking the owner role
 * away from the last owner (or the last break-glass one while enforcing) is skipped: the
 * server must keep someone who can sign in and fix the mapping.
 */
async function refreshAccess(provider: IdentityProvider, user: User, identity: Identity, who: AuditRequest): Promise<User> {
  const access = await accessFor(provider, identity.groups);
  const managed = managedTeams(groupMapOf(provider), defaultAccessOf(provider));
  const before = await withAccess(user);
  const enforced = await ssoEnforced();
  const updated = await getDb().transaction(async (tx) => {
    const owners = await lockOwners(tx);
    let wanted = access;
    try {
      await assertOwnerStays(tx, owners, user.id, !access.owner, enforced);
    } catch (e) {
      if (!(e instanceof OwnerLockError)) throw e;
      wanted = { ...access, owner: true, roleId: before.roleId };
    }
    await writeAccess(tx, user.id, wanted, managed);
    const [now] = await tx.select().from(users).where(eq(users.id, user.id));
    return now;
  });
  const after = await withAccess(updated);
  const was = { owner: before.access.owner, permissions: permissionsOf(before) };
  const is = { owner: after.access.owner, permissions: permissionsOf(after) };
  if (JSON.stringify(was) !== JSON.stringify(is) || before.roleId !== after.roleId) {
    await record(who, "sso.accessSynced", { target: { type: "user", id: user.id, ownerUserId: user.id }, before: { username: user.username, role: was.owner ? "owner" : before.roleId, permissions: was.permissions }, after: { username: user.username, provider: provider.name, ...viewOfAccess(access) } });
  }
  return updated;
}

/** The account a verified identity signs in as, or why there is none. */
export async function accountFor(provider: IdentityProvider, identity: Identity, who: AuditRequest): Promise<{ user: User } | { failure: SsoFailure; userId?: number }> {
  let user = await linked(provider.id, identity.subject);
  if (!user) {
    const scim = await provisioned(provider, identity);
    if (scim) {
      await link(provider.id, scim.id, identity);
      user = await linked(provider.id, identity.subject);
    }
  }
  if (!user) {
    if (provider.jitEnabled !== 1) return { failure: "notProvisioned" };
    user = await makeAccount(provider, identity, who);
  } else if (user.authSource === "sso" && !user.disabledAt) {
    user = await refreshAccess(provider, user, identity, who);
  }
  if (user.disabledAt) return { failure: "disabled", userId: user.id };
  await getDb()
    .update(userIdentities)
    .set({ lastLoginAt: new Date() })
    .where(and(eq(userIdentities.providerId, provider.id), eq(userIdentities.subject, identity.subject)));
  return { user };
}

/** Accounts linked to a provider (Settings shows how many). */
export async function linkedCount(providerId: number): Promise<number> {
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(userIdentities).where(eq(userIdentities.providerId, providerId));
  return row?.n ?? 0;
}

