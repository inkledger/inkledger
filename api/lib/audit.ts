// The audit log (contracts/audit.ts): one row per event, hash-chained, redacted per action,
// and copied to a JSONL file a day when the mirror is on. Restores always write their
// before/after records to that file: the database they rewind can't keep them.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, gt, gte, like, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { auditEvents, type AuditEvent, type User } from "@db/schema";
import {
  AUDIT_ACTIONS,
  AUDIT_GENESIS,
  AUDIT_RETENTION_DEFAULT_DAYS,
  AUDIT_RETENTION_MAX_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
  REDACTED,
  isAuditAction,
  type AuditAction,
  type AuditActorKind,
  type AuditEventView,
  type AuditOutcome,
  type AuditVerifyResult,
} from "@contracts/audit";
import { getDb } from "../queries/connection";
import { clientIp } from "./session";
import { env } from "./env";
import { getServerSetting } from "./serverSettings";
import { dayKey } from "@contracts/time";

/** Who acted, as a row keeps it. */
export type AuditActor = { kind: AuditActorKind; userId?: number | null; label?: string };

/** A request's context (a tRPC one, or a REST route's): who and from where. */
export type AuditRequest = { req: Request; remoteAddress?: string; user?: Pick<User, "id" | "username" | "displayName"> | null };

export type AuditTarget = { type: string; id?: string | number | null; ownerUserId?: number | null };

export type AuditDetails = {
  target?: AuditTarget;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  outcome?: AuditOutcome;
};

/** The longest string kept in a field: a long text says only that it was long. */
const MAX_STRING = 300;

function clip(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > MAX_STRING ? v.slice(0, MAX_STRING) + "…" : v;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clip(x, depth + 1));
  if (v && typeof v === "object") return depth > 2 ? REDACTED : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x, depth + 1)]));
  return v;
}

/**
 * Only the action's own fields kept as they are; any other field is there as "[redacted]"
 * (that it changed shows, never what it held). Unknown actions keep nothing.
 */
export function redact(action: string, data: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!data) return null;
  const allowed: readonly string[] = isAuditAction(action) ? AUDIT_ACTIONS[action] : [];
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, allowed.includes(k) ? clip(v) : REDACTED]),
  );
}

/** Keys sorted at every level: the same row always hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
  }
  return JSON.stringify(v ?? null);
}

type Hashed = Omit<AuditEvent, "id" | "hash" | "prevHash" | "pseudonymisedAt">;

/** sha256(prev_hash || canonical row): what each row's hash is, and what verify recomputes. */
export function hashOf(prevHash: string, row: Hashed): string {
  const body = {
    at: row.at,
    actorUserId: row.actorUserId,
    actorLabel: row.actorLabel,
    actorKind: row.actorKind,
    action: row.action,
    outcome: row.outcome,
    targetType: row.targetType,
    targetId: row.targetId,
    targetOwnerUserId: row.targetOwnerUserId,
    ip: row.ip,
    userAgentHash: row.userAgentHash,
    requestId: row.requestId,
    before: row.before,
    after: row.after,
  };
  return createHash("sha256").update(prevHash).update(canonical(body)).digest("hex");
}

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function fromRequest(r: AuditRequest): Pick<Hashed, "ip" | "userAgentHash" | "requestId"> {
  const ua = r.req.headers.get("user-agent");
  const rid = r.req.headers.get("x-request-id")?.trim();
  return {
    ip: clientIp(r.req, r.remoteAddress),
    userAgentHash: ua ? shortHash(ua) : null,
    requestId: rid && /^[\w.-]{1,64}$/.test(rid) ? rid : randomUUID(),
  };
}

const userLabel = (u: Pick<User, "username" | "displayName">) => u.username || u.displayName || "";

/**
 * Mutations behind a permission that write no event, with why: a module's own storage,
 * written as it plays (a row each would bury the log; the module and the account are known
 * from modules.setEnabled and the account's access).
 */
export const UNAUDITED_PROCEDURES: Record<string, string> = {
  "modules.storageSet": "a module's own per-user storage, written as it runs",
  "modules.storageSetIf": "a module's own per-user storage, written as it runs",
  "modules.storageDelete": "a module's own per-user storage, written as it runs",
  "modules.filePut": "a module's own per-user files, written as it runs",
  "modules.fileDelete": "a module's own per-user files, written as it runs",
  "modules.claimClosures": "a module marking closures it has shown, per user",
};

/** The rows written so far are awaited by flushAudit (tests, shutdown). */
const inFlight = new Set<Promise<unknown>>();

/**
 * One event, chained after the last one: the chain is read and extended under one lock,
 * so two events at once never point at the same predecessor. Never throws: an event that
 * can't be written is said in the server's log (the action it records already happened).
 */
async function write(actor: AuditActor, action: string, details: AuditDetails, from: Partial<Pick<Hashed, "ip" | "userAgentHash" | "requestId">> = {}): Promise<AuditEvent | null> {
  const before = redact(action, details.before);
  const after = redact(action, details.after);
  const row: Hashed = {
    at: Date.now(),
    actorUserId: actor.userId ?? null,
    actorLabel: actor.label ?? "",
    actorKind: actor.kind,
    action,
    outcome: details.outcome ?? "ok",
    targetType: details.target?.type ?? null,
    targetId: details.target?.id === undefined || details.target.id === null ? null : String(details.target.id),
    targetOwnerUserId: details.target?.ownerUserId ?? null,
    ip: from.ip ?? null,
    userAgentHash: from.userAgentHash ?? null,
    requestId: from.requestId ?? null,
    before: before ? JSON.stringify(before) : null,
    after: after ? JSON.stringify(after) : null,
  };
  const p = (async () => {
    try {
      const saved = await getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('audit-chain'))`);
        const [last] = await tx.select({ hash: auditEvents.hash }).from(auditEvents).orderBy(desc(auditEvents.id)).limit(1);
        const prevHash = last?.hash ?? AUDIT_GENESIS;
        const [inserted] = await tx.insert(auditEvents).values({ ...row, prevHash, hash: hashOf(prevHash, row) }).returning();
        return inserted;
      });
      if (env.auditFileMirror) appendFile(saved);
      return saved;
    } catch (e) {
      console.error(`[audit] ${action}: ${String(e)}`);
      return null;
    }
  })();
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return p;
}

/** An event by whoever made the request (a signed-in user, or nobody yet: a failed sign-in). */
export function record(who: AuditRequest, action: AuditAction, details: AuditDetails = {}): Promise<AuditEvent | null> {
  const actor: AuditActor = who.user ? { kind: "user", userId: who.user.id, label: userLabel(who.user) } : { kind: "user", userId: null, label: "" };
  return write(actor, action, details, fromRequest(who));
}

/** The last time each read was recorded: a page refetching the same report writes one event, not one per refetch. */
const reads = new Map<string, number>();
const READ_EVERY_MS = 10 * 60_000;

/** A read of someone else's data (team time): once per reader, report and range every ten minutes. */
export async function recordRead(who: AuditRequest, action: AuditAction, details: AuditDetails): Promise<void> {
  const key = `${who.user?.id ?? 0}|${action}|${JSON.stringify(details.after ?? {})}`;
  const now = Date.now();
  if ((reads.get(key) ?? 0) > now - READ_EVERY_MS) return;
  if (reads.size > 5000) for (const [k, at] of reads) if (at <= now - READ_EVERY_MS) reads.delete(k);
  reads.set(key, now);
  await record(who, action, details);
}

/** An event with no request behind it: a schedule, a sync pass, the command line. */
export function recordSystem(actor: AuditActor, action: AuditAction, details: AuditDetails = {}): Promise<AuditEvent | null> {
  return write(actor, action, details);
}

/** The generic middleware's write: the procedure's path is its action (checked by the meta-test). */
export function recordProcedure(who: AuditRequest, action: string, details: AuditDetails): Promise<AuditEvent | null> {
  const actor: AuditActor = who.user ? { kind: "user", userId: who.user.id, label: userLabel(who.user) } : { kind: "user" };
  return write(actor, action, details, fromRequest(who));
}

/**
 * A sign-in, its success or its failure, by any method: the password form, a remembered
 * device, an invite or an activation today; an identity provider (SSO) or provisioning
 * (SCIM) through the same call when they come. The typed password is never passed.
 */
export function recordSignIn(
  who: AuditRequest,
  outcome: { ok: true; user: Pick<User, "id" | "username" | "displayName">; method: "password" | "remembered" | "invite" | "activation" | "sso" | "scim" } | { ok: false; username: string; method: "password" | "remembered" | "activation" | "sso" | "scim"; reason: string; userId?: number | null },
): Promise<AuditEvent | null> {
  if (outcome.ok) {
    return record({ ...who, user: outcome.user }, "auth.signIn", { target: { type: "user", id: outcome.user.id, ownerUserId: outcome.user.id }, after: { method: outcome.method, username: outcome.user.username } });
  }
  const username = outcome.username.slice(0, 64);
  const actor: AuditActor = { kind: outcome.method === "scim" ? "scim" : "user", userId: outcome.userId ?? null, label: username };
  return write(actor, "auth.signInFailed", { outcome: "failed", target: { type: "user", id: outcome.userId ?? null }, after: { method: outcome.method, ...(username ? { username } : {}), reason: outcome.reason } }, fromRequest(who));
}

/** Every event under way written (tests read the table right after a call). */
export async function flushAudit(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

// ---------------------------------------------------------------------------
// The file copy: /app/data/audit/audit-YYYY-MM-DD.jsonl, one line per event.

export function auditFile(day = new Date()): string {
  return path.join(env.auditDir, `audit-${dayKey(day)}.jsonl`);
}

/** One line appended to today's file; a folder that can't be written is said, never fatal. */
export function appendAuditLine(line: Record<string, unknown>): void {
  try {
    fs.mkdirSync(env.auditDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(auditFile(), JSON.stringify(line) + "\n", { mode: 0o600 });
  } catch (e) {
    console.error(`[audit] file copy: ${String(e)}`);
  }
}

function appendFile(e: AuditEvent): void {
  appendAuditLine({ ...e, before: e.before ? (JSON.parse(e.before) as unknown) : null, after: e.after ? (JSON.parse(e.after) as unknown) : null });
}

/** The newest event's hash (a restore keeps it to say what came before it). */
export async function lastAuditHash(): Promise<string> {
  const [last] = await getDb().select({ hash: auditEvents.hash }).from(auditEvents).orderBy(desc(auditEvents.id)).limit(1);
  return last?.hash ?? AUDIT_GENESIS;
}

/**
 * A restore's own record in the file, before and after the database is replaced (whatever
 * the mirror setting): the replaced database rewinds the log, the file doesn't.
 */
export function recordRestoreFile(phase: "before" | "after", details: { name: string; actorUserId: number | null; actorLabel: string; lastHash: string; outcome?: AuditOutcome; safety?: string; error?: string }): void {
  appendAuditLine({ at: Date.now(), action: "backup.restore", phase, outcome: details.outcome ?? "ok", actorKind: "user", actorUserId: details.actorUserId, actorLabel: details.actorLabel, name: details.name, safety: details.safety ?? null, lastHash: details.lastHash, error: details.error ?? null });
}

// ---------------------------------------------------------------------------
// Reading, verifying, purging.

export type AuditFilters = {
  actorUserId?: number;
  action?: string;
  targetType?: string;
  targetId?: string;
  outcome?: AuditOutcome;
  from?: number;
  to?: number;
};

function where(f: AuditFilters, cursor?: number): SQL | undefined {
  const parts: SQL[] = [];
  if (cursor !== undefined) parts.push(lt(auditEvents.id, cursor));
  if (f.actorUserId !== undefined) parts.push(eq(auditEvents.actorUserId, f.actorUserId));
  if (f.action) parts.push(f.action.endsWith(".") ? like(auditEvents.action, f.action.replace(/[%_\\]/g, "\\$&") + "%") : eq(auditEvents.action, f.action));
  if (f.targetType) parts.push(eq(auditEvents.targetType, f.targetType));
  if (f.targetId) parts.push(eq(auditEvents.targetId, f.targetId));
  if (f.outcome) parts.push(eq(auditEvents.outcome, f.outcome));
  if (f.from !== undefined) parts.push(gte(auditEvents.at, f.from));
  if (f.to !== undefined) parts.push(lte(auditEvents.at, f.to));
  return parts.length ? and(...parts) : undefined;
}

const parse = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export function viewOf(e: AuditEvent): AuditEventView {
  return {
    id: e.id,
    at: e.at,
    actorUserId: e.actorUserId,
    actorLabel: e.actorLabel,
    actorKind: e.actorKind as AuditEventView["actorKind"],
    action: e.action,
    outcome: e.outcome as AuditOutcome,
    targetType: e.targetType,
    targetId: e.targetId,
    targetOwnerUserId: e.targetOwnerUserId,
    ip: e.ip,
    before: parse(e.before),
    after: parse(e.after),
  };
}

/** Newest first, a page at a time: `cursor` is the last id of the page before. */
export async function listAudit(f: AuditFilters, limit: number, cursor?: number): Promise<{ items: AuditEventView[]; nextCursor: number | null }> {
  const rows = await getDb().select().from(auditEvents).where(where(f, cursor)).orderBy(desc(auditEvents.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(viewOf), nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}

/** Every matching event, newest first, page by page (the export streams these). */
export async function* auditPages(f: AuditFilters, pageSize = 500): AsyncGenerator<AuditEventView[]> {
  let cursor: number | undefined;
  for (;;) {
    const { items, nextCursor } = await listAudit(f, pageSize, cursor);
    if (items.length) yield items;
    if (nextCursor === null) return;
    cursor = nextCursor;
  }
}

/**
 * The chain walked from its oldest row: each hash recomputed, each row pointing at the one
 * before. The oldest row left after a purge points at a removed one: it anchors the walk.
 */
export async function verifyAudit(pageSize = 1000): Promise<AuditVerifyResult> {
  let checked = 0;
  let prev: string | null = null;
  let anchored = false;
  let after = 0;
  for (;;) {
    const rows = await getDb().select().from(auditEvents).where(gt(auditEvents.id, after)).orderBy(asc(auditEvents.id)).limit(pageSize);
    for (const r of rows) {
      if (prev === null) anchored = r.prevHash !== AUDIT_GENESIS;
      else if (r.prevHash !== prev) return { ok: false, checked, badId: r.id, reason: "link" };
      // A row an erasure pseudonymised keeps its hash and its link, not the content it hashed.
      if (r.pseudonymisedAt === null && hashOf(r.prevHash, r) !== r.hash) return { ok: false, checked, badId: r.id, reason: "hash" };
      prev = r.hash;
      checked++;
      after = r.id;
    }
    if (rows.length < pageSize) return { ok: true, checked, anchored };
  }
}

/** What an erased account is called in the log from then on. */
export const erasedLabel = (userId: number) => `erased-user-${userId}`;

/** Strings equal to one of `names` replaced, at any depth. */
function scrub(v: unknown, names: ReadonlySet<string>, pseudonym: string): unknown {
  if (typeof v === "string") return names.has(v.trim().toLowerCase()) ? pseudonym : v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, names, pseudonym));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, names, pseudonym)]));
  return v;
}

const scrubJson = (s: string | null, names: ReadonlySet<string>, pseudonym: string): string | null => {
  if (!s || names.size === 0) return s;
  try {
    return JSON.stringify(scrub(JSON.parse(s), names, pseudonym));
  } catch {
    return s;
  }
};

/** LIKE's own characters taken literally. */
const likeLiteral = (s: string) => s.replace(/[%_\\]/g, "\\$&");

/**
 * The rows by or about an account: it acted, it owns the target, it is the target, or one of
 * its names is a value in before/after (a team change names its member only so).
 */
export function auditAbout(userId: number, names: readonly string[]): SQL {
  const byName = names
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .flatMap((n) => {
      const quoted = `%${likeLiteral(JSON.stringify(n))}%`;
      return [sql`${auditEvents.before} ILIKE ${quoted}`, sql`${auditEvents.after} ILIKE ${quoted}`];
    });
  return or(eq(auditEvents.actorUserId, userId), eq(auditEvents.targetOwnerUserId, userId), and(eq(auditEvents.targetType, "user"), eq(auditEvents.targetId, String(userId))), ...byName) ?? sql`false`;
}

type AuditTx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * An erased account's rows in the log pseudonymised, inside the erasure's transaction: the
 * ones it acted in lose its label (erased-user-<id>), client address and device hash; the
 * ones about it, and those, have its names in before/after replaced. Ids, actions, times and
 * the chain stay (the trigger lets nothing else through); each row is marked, so verify
 * still checks its link. Returns how many rows changed.
 */
export async function pseudonymiseAudit(tx: AuditTx, userId: number, names: readonly string[], now = Date.now()): Promise<number> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('audit-chain'))`);
  await tx.execute(sql`SELECT set_config('inkledger.audit_pseudonymise', 'on', true)`);
  const pseudonym = erasedLabel(userId);
  const known = new Set(names.map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0));
  const about = auditAbout(userId, names);
  let changed = 0;
  let after = 0;
  for (;;) {
    const rows = await tx.select().from(auditEvents).where(and(gt(auditEvents.id, after), about)).orderBy(asc(auditEvents.id)).limit(500);
    for (const r of rows) {
      const acted = r.actorUserId === userId;
      await tx
        .update(auditEvents)
        .set({
          actorLabel: acted ? pseudonym : r.actorLabel,
          ip: acted ? null : r.ip,
          userAgentHash: acted ? null : r.userAgentHash,
          before: scrubJson(r.before, known, pseudonym),
          after: scrubJson(r.after, known, pseudonym),
          pseudonymisedAt: now,
        })
        .where(eq(auditEvents.id, r.id));
      changed++;
      after = r.id;
    }
    if (rows.length < 500) return changed;
  }
}

export const RETENTION_KEY = "audit.retentionDays";

/** Days the log keeps events: as set, never under the minimum (a value set some other way included). */
export async function auditRetentionDays(): Promise<number> {
  const set = await getServerSetting<unknown>(RETENTION_KEY, AUDIT_RETENTION_DEFAULT_DAYS);
  const n = typeof set === "number" && Number.isFinite(set) ? Math.round(set) : AUDIT_RETENTION_DEFAULT_DAYS;
  return Math.min(AUDIT_RETENTION_MAX_DAYS, Math.max(AUDIT_RETENTION_MIN_DAYS, n));
}

/**
 * Events older than the retention removed: the only delete the table allows, under the
 * purge's own setting in its own transaction. What went is itself an event.
 */
export async function purgeAudit(now = Date.now()): Promise<number> {
  const days = await auditRetentionDays();
  const before = now - days * 86_400_000;
  const gone = await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('audit-chain'))`);
    await tx.execute(sql`SELECT set_config('inkledger.audit_purge', 'on', true)`);
    return tx.delete(auditEvents).where(lt(auditEvents.at, before)).returning({ id: auditEvents.id, hash: auditEvents.hash });
  });
  if (gone.length > 0) {
    const last = gone.reduce((a, b) => (b.id > a.id ? b : a));
    await recordSystem({ kind: "system", label: "retention" }, "audit.purge", { after: { deleted: gone.length, before: new Date(before).toISOString(), retentionDays: days, lastPurgedHash: last.hash } });
  }
  return gone.length;
}
