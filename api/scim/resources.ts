// SCIM 2.0 resources (RFC 7643/7644) as this server keeps them: Users are accounts
// provisioned by the identity provider (scim_managed), never hard-deleted (DELETE turns one
// off); Groups are teams that came from it (teams.external_id). Accounts made here any other
// way are invisible to SCIM: provisioning can't take over a local account.
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { teamMembers, teams, userIdentities, users, type IdentityProvider, type Team, type User } from "@db/schema";
import { getDb, uniqueViolation } from "../queries/connection";
import { assertOwnerStays, lockOwners, OwnerLockError, signOutEverywhere } from "../queries/accounts";
import { accessFor, managedTeams, usernameFrom, writeAccess } from "../sso/accounts";
import { defaultAccessOf, groupMapOf, ssoEnforced } from "../sso/store";
import { SCIM_BASE } from "@contracts/sso";

export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** A refusal SCIM says as such (RFC 7644 §3.12). */
export class ScimError extends Error {
  readonly status: number;
  readonly scimType?: string;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
    this.name = "ScimError";
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 256): string | undefined => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
/** SCIM booleans as identity providers send them: true, "True", "false"… */
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : typeof v === "string" && /^(true|false)$/i.test(v.trim()) ? v.trim().toLowerCase() === "true" : undefined);

// ---------------------------------------------------------------------------
// Filters: "attr eq "value"", the one form identity providers send to find a resource.

export function parseFilter(raw: string | undefined, allowed: readonly string[]): { attr: string; value: string } | null {
  if (!raw) return null;
  const m = /^\s*([\w.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw);
  const attr = m ? allowed.find((a) => a.toLowerCase() === m[1].toLowerCase()) : undefined;
  if (!m || !attr) throw new ScimError(400, "Only filters of the form attribute eq \"value\" are supported", "invalidFilter");
  return { attr, value: m[2].replace(/\\(.)/g, "$1") };
}

export function page(q: { startIndex?: string; count?: string }): { offset: number; limit: number; startIndex: number } {
  const startIndex = Math.max(1, Math.floor(Number(q.startIndex) || 1));
  const limit = Math.min(200, Math.max(0, Math.floor(q.count === undefined ? 100 : Number(q.count) || 0)));
  return { offset: startIndex - 1, limit, startIndex };
}

const listOf = (resources: Json[], total: number, startIndex: number) => ({ schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources });

// ---------------------------------------------------------------------------
// Users

const scimUser = eq(users.scimManaged, 1);

async function teamsOfUser(id: number): Promise<{ value: string; display: string }[]> {
  const rows = await getDb()
    .select({ id: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, id), isNotNull(teams.externalId)))
    .orderBy(asc(teams.id));
  return rows.map((r) => ({ value: String(r.id), display: r.name }));
}

export async function userResource(u: User): Promise<Json> {
  return {
    schemas: [USER_SCHEMA],
    id: String(u.id),
    ...(u.externalId ? { externalId: u.externalId } : {}),
    userName: u.scimUserName ?? u.username ?? "",
    name: { formatted: u.displayName },
    displayName: u.displayName,
    emails: u.email ? [{ value: u.email, type: "work", primary: true }] : [],
    active: !u.disabledAt,
    groups: await teamsOfUser(u.id),
    meta: { resourceType: "User", created: u.createdAt.toISOString(), location: `${SCIM_BASE}/Users/${u.id}` },
  };
}

export async function scimUserById(rawId: string): Promise<User> {
  const id = Number(rawId);
  const [u] = Number.isSafeInteger(id) && id > 0 ? await getDb().select().from(users).where(and(eq(users.id, id), scimUser)).limit(1) : [];
  if (!u) throw new ScimError(404, `User ${rawId} not found`);
  return u;
}

export async function listUsers(q: { filter?: string; startIndex?: string; count?: string }): Promise<Json> {
  const f = parseFilter(q.filter, ["userName", "externalId"]);
  const where = f
    ? and(scimUser, f.attr === "userName" ? sql`lower(${users.scimUserName}) = ${f.value.toLowerCase()}` : eq(users.externalId, f.value))
    : scimUser;
  const { offset, limit, startIndex } = page(q);
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(users).where(where);
  const rows = limit ? await getDb().select().from(users).where(where).orderBy(asc(users.id)).offset(offset).limit(limit) : [];
  return listOf(await Promise.all(rows.map(userResource)), n, startIndex);
}

/** What a User resource (POST, PUT, or a PATCH's value) sets, read leniently. */
type UserFields = { userName?: string; displayName?: string; email?: string; active?: boolean; externalId?: string | null };

function primaryEmail(v: unknown): string | undefined {
  if (!Array.isArray(v)) return str(v);
  const emails = v.filter(isObj);
  const chosen = emails.find((e) => e.primary === true || bool(e.primary)) ?? emails.find((e) => e.type === "work") ?? emails[0];
  return chosen ? str(chosen.value) : undefined;
}

function nameOf(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  return str(v.formatted) || [str(v.givenName), str(v.familyName)].filter(Boolean).join(" ") || undefined;
}

export function userFields(body: Json): UserFields {
  const out: UserFields = {};
  if (str(body.userName)) out.userName = str(body.userName);
  const display = str(body.displayName, 80) || nameOf(body.name)?.slice(0, 80);
  if (display) out.displayName = display;
  const email = primaryEmail(body.emails);
  if (email !== undefined) out.email = email;
  if (bool(body.active) !== undefined) out.active = bool(body.active);
  if (body.externalId === null) out.externalId = null;
  else if (str(body.externalId)) out.externalId = str(body.externalId);
  return out;
}

/** One PATCH operation on a User, as Entra ID ("Replace", path "active", "False") and Okta (no path, a value object) send them. */
export function userPatch(ops: unknown): UserFields {
  if (!Array.isArray(ops)) throw new ScimError(400, "Operations must be a list", "invalidSyntax");
  let out: UserFields = {};
  for (const op of ops) {
    if (!isObj(op)) throw new ScimError(400, "Bad operation", "invalidSyntax");
    const kind = str(op.op)?.toLowerCase();
    if (kind !== "add" && kind !== "replace" && kind !== "remove") throw new ScimError(400, `Unknown op ${String(op.op)}`, "invalidSyntax");
    const path = str(op.path);
    if (kind === "remove") {
      if (path?.toLowerCase() === "externalid") out = { ...out, externalId: null };
      continue;
    }
    if (!path) {
      if (isObj(op.value)) out = { ...out, ...userFields(op.value) };
      continue;
    }
    const p = path.toLowerCase();
    if (p === "active") out.active = bool(op.value) ?? out.active;
    else if (p === "username") out.userName = str(op.value) ?? out.userName;
    else if (p === "displayname") out.displayName = str(op.value, 80) ?? out.displayName;
    else if (p === "name.formatted") out.displayName = str(op.value, 80) ?? out.displayName;
    else if (p === "externalid") out.externalId = str(op.value) ?? out.externalId;
    else if (p === "emails" || p.startsWith("emails[")) out.email = (p.endsWith(".value") ? str(op.value) : primaryEmail(op.value)) ?? out.email;
    // Anything else (a department, a manager…) isn't kept here: ignored, as SCIM allows.
  }
  return out;
}

/** Where the token belongs, and who the request came from (the audit names both). */
export type ScimActor = { provider: IdentityProvider };

const takenName = () => new ScimError(409, "userName is taken", "uniqueness");

async function assertFreeUserName(userName: string, exceptId?: number) {
  const [holder] = await getDb().select({ id: users.id }).from(users).where(sql`lower(${users.scimUserName}) = ${userName.toLowerCase()}`).limit(1);
  if (holder && holder.id !== exceptId) throw takenName();
}

/** A new provisioned account (the provider's default access, never an owner), linked by its externalId when given. */
export async function createUser(actor: ScimActor, body: Json): Promise<User> {
  const f = userFields(body);
  if (!f.userName) throw new ScimError(400, "userName is required", "invalidValue");
  await assertFreeUserName(f.userName);
  const access = await accessFor(actor.provider, []);
  const managed = managedTeams(groupMapOf(actor.provider), defaultAccessOf(actor.provider));
  const base = usernameFrom({ username: f.userName, email: f.email ?? "", subject: f.externalId ?? "" });
  for (let n = 1; n <= 50; n++) {
    const username = n === 1 ? base : `${base.slice(0, 32 - String(n).length - 1)}-${n}`;
    try {
      return await getDb().transaction(async (tx) => {
        const [u] = await tx
          .insert(users)
          .values({
            username,
            displayName: f.displayName || f.userName || username,
            email: f.email ?? "",
            authSource: "scim",
            scimManaged: 1,
            scimUserName: f.userName,
            externalId: f.externalId ?? null,
            disabledAt: f.active === false ? new Date() : null,
          })
          .returning();
        if (f.externalId) await tx.insert(userIdentities).values({ providerId: actor.provider.id, userId: u.id, subject: f.externalId, emailAtLink: f.email ?? "" });
        await writeAccess(tx, u.id, access, managed);
        const [now] = await tx.select().from(users).where(eq(users.id, u.id));
        return now;
      });
    } catch (e) {
      if (!uniqueViolation(e)) throw e;
      await assertFreeUserName(f.userName);
    }
  }
  throw new ScimError(409, "No free username", "uniqueness");
}

/** Turns the account off: through the owner lock (never the last owner), then signed out everywhere. */
export async function deactivate(u: User): Promise<User> {
  const enforced = await ssoEnforced();
  let out: User;
  try {
    out = await getDb().transaction(async (tx) => {
      const owners = await lockOwners(tx);
      await assertOwnerStays(tx, owners, u.id, true, enforced);
      const [now] = await tx.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id)).returning();
      return now;
    });
  } catch (e) {
    if (e instanceof OwnerLockError) throw new ScimError(400, e.kind === "lastOwner" ? "The last owner can't be deactivated" : "The last break-glass owner can't be deactivated while single sign-on is enforced", "mutability");
    throw e;
  }
  await signOutEverywhere(u.id);
  return out;
}

/** Applies what a PUT or PATCH sets (active last: turning off goes through the lock). */
export async function updateUser(u: User, f: UserFields): Promise<{ user: User; deactivated: boolean; reactivated: boolean }> {
  if (f.userName && f.userName.toLowerCase() !== (u.scimUserName ?? "").toLowerCase()) await assertFreeUserName(f.userName, u.id);
  const values: Partial<typeof users.$inferInsert> = {};
  if (f.userName) values.scimUserName = f.userName;
  if (f.displayName) values.displayName = f.displayName;
  if (f.email !== undefined) values.email = f.email;
  if (f.externalId !== undefined) values.externalId = f.externalId;
  let user = u;
  if (Object.keys(values).length) {
    try {
      [user] = await getDb().update(users).set(values).where(eq(users.id, u.id)).returning();
    } catch (e) {
      if (uniqueViolation(e)) throw takenName();
      throw e;
    }
  }
  let deactivated = false;
  let reactivated = false;
  if (f.active === false && !user.disabledAt) {
    user = await deactivate(user);
    deactivated = true;
  } else if (f.active === true && user.disabledAt) {
    [user] = await getDb().update(users).set({ disabledAt: null }).where(eq(users.id, u.id)).returning();
    reactivated = true;
  }
  return { user, deactivated, reactivated };
}

// ---------------------------------------------------------------------------
// Groups (teams from the identity provider)

/** A team made by SCIM without an externalId gets one of its own (teams.external_id marks SCIM's teams). */
const OWN_MARK = "scim:";

export async function groupResource(t: Team): Promise<Json> {
  const members = await getDb()
    .select({ id: users.id, username: users.username })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(and(eq(teamMembers.teamId, t.id), eq(users.scimManaged, 1)))
    .orderBy(asc(users.id));
  return {
    schemas: [GROUP_SCHEMA],
    id: String(t.id),
    ...(t.externalId && !t.externalId.startsWith(OWN_MARK) ? { externalId: t.externalId } : {}),
    displayName: t.name,
    members: members.map((m) => ({ value: String(m.id), display: m.username ?? "" })),
    meta: { resourceType: "Group", created: t.createdAt.toISOString(), location: `${SCIM_BASE}/Groups/${t.id}` },
  };
}

export async function scimGroupById(rawId: string): Promise<Team> {
  const id = Number(rawId);
  const [t] = Number.isSafeInteger(id) && id > 0 ? await getDb().select().from(teams).where(and(eq(teams.id, id), isNotNull(teams.externalId))).limit(1) : [];
  if (!t) throw new ScimError(404, `Group ${rawId} not found`);
  return t;
}

export async function listGroups(q: { filter?: string; startIndex?: string; count?: string }): Promise<Json> {
  const f = parseFilter(q.filter, ["displayName", "externalId"]);
  const where = f
    ? and(isNotNull(teams.externalId), f.attr === "displayName" ? sql`lower(${teams.name}) = ${f.value.toLowerCase()}` : eq(teams.externalId, f.value))
    : isNotNull(teams.externalId);
  const { offset, limit, startIndex } = page(q);
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(teams).where(where);
  const rows = limit ? await getDb().select().from(teams).where(where).orderBy(asc(teams.id)).offset(offset).limit(limit) : [];
  return listOf(await Promise.all(rows.map(groupResource)), n, startIndex);
}

/** Member ids a request names, only accounts SCIM provisioned (others are not its to place). */
async function memberIds(v: unknown): Promise<number[]> {
  if (!Array.isArray(v)) return [];
  const ids = v.filter(isObj).map((m) => Number(m.value)).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (ids.length === 0) return [];
  const rows = await getDb().select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.scimManaged, 1)));
  return rows.map((r) => r.id);
}

async function addMembers(teamId: number, ids: number[]) {
  if (ids.length) await getDb().insert(teamMembers).values(ids.map((userId) => ({ teamId, userId, role: "member" }))).onConflictDoNothing();
}

async function removeMembers(teamId: number, ids: number[]) {
  if (ids.length) await getDb().delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), inArray(teamMembers.userId, ids), eq(teamMembers.role, "member")));
}

/** The SCIM members of the team become exactly `ids` (its leads, and accounts SCIM didn't make, stay). */
async function setMembers(teamId: number, ids: number[]) {
  const now = await getDb()
    .select({ id: users.id })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(and(eq(teamMembers.teamId, teamId), eq(users.scimManaged, 1)));
  await removeMembers(teamId, now.map((r) => r.id).filter((id) => !ids.includes(id)));
  await addMembers(teamId, ids);
}

const takenGroup = () => new ScimError(409, "A team with this name exists", "uniqueness");

async function renameTeam(t: Team, name: string | undefined, externalId: string | undefined): Promise<Team> {
  const values: Partial<typeof teams.$inferInsert> = {};
  if (name && name !== t.name) values.name = name;
  if (externalId && externalId !== t.externalId) values.externalId = externalId;
  if (!Object.keys(values).length) return t;
  try {
    const [out] = await getDb().update(teams).set(values).where(eq(teams.id, t.id)).returning();
    return out;
  } catch (e) {
    if (uniqueViolation(e)) throw takenGroup();
    throw e;
  }
}

export async function createGroup(body: Json): Promise<Team> {
  const name = str(body.displayName, 80);
  if (!name) throw new ScimError(400, "displayName is required", "invalidValue");
  let t: Team;
  try {
    [t] = await getDb().insert(teams).values({ name, externalId: str(body.externalId) || `${OWN_MARK}${randomUUID()}` }).returning();
  } catch (e) {
    if (uniqueViolation(e)) throw takenGroup();
    throw e;
  }
  await addMembers(t.id, await memberIds(body.members));
  return t;
}

export async function replaceGroup(t: Team, body: Json): Promise<Team> {
  const out = await renameTeam(t, str(body.displayName, 80), str(body.externalId));
  await setMembers(t.id, await memberIds(body.members));
  return out;
}

/** PATCH on a Group: members added, removed (by filter or list) or replaced; displayName replaced. */
export async function patchGroup(t: Team, ops: unknown): Promise<Team> {
  if (!Array.isArray(ops)) throw new ScimError(400, "Operations must be a list", "invalidSyntax");
  let team = t;
  for (const op of ops) {
    if (!isObj(op)) throw new ScimError(400, "Bad operation", "invalidSyntax");
    const kind = str(op.op)?.toLowerCase();
    const path = str(op.path) ?? "";
    const p = path.toLowerCase();
    const one = /^members\[value eq "([^"]+)"\]$/i.exec(path);
    if (kind === "add" && p === "members") await addMembers(t.id, await memberIds(op.value));
    else if (kind === "remove" && one) await removeMembers(t.id, (await memberIds([{ value: one[1] }])));
    else if (kind === "remove" && p === "members") {
      if (Array.isArray(op.value)) await removeMembers(t.id, await memberIds(op.value));
      else await setMembers(t.id, []);
    } else if (kind === "replace" && p === "members") await setMembers(t.id, await memberIds(op.value));
    else if ((kind === "replace" || kind === "add") && p === "displayname") team = await renameTeam(team, str(op.value, 80), undefined);
    else if ((kind === "replace" || kind === "add") && p === "externalid") team = await renameTeam(team, undefined, str(op.value));
    else if ((kind === "replace" || kind === "add") && !p && isObj(op.value)) {
      team = await renameTeam(team, str(op.value.displayName, 80), str(op.value.externalId));
      if (Array.isArray(op.value.members)) await (kind === "replace" ? setMembers(t.id, await memberIds(op.value.members)) : addMembers(t.id, await memberIds(op.value.members)));
    } else if (kind !== "add" && kind !== "replace" && kind !== "remove") throw new ScimError(400, `Unknown op ${String(op.op)}`, "invalidSyntax");
  }
  return team;
}

export async function deleteGroup(t: Team): Promise<void> {
  await getDb().delete(teams).where(eq(teams.id, t.id));
}
