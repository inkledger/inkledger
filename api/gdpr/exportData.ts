// A person's data as files (users.exportData): their account, connections without
// secrets, every table api/gdpr/policy.ts says is theirs (JSON, and CSV for time and
// to-dos), and the audit events by or about them. Read one table at a time and handed to the
// ZIP stream as it goes. Tracker-side data is the tracker's to export.
import { and, asc, eq, getTableColumns, getTableName, gt, inArray, or } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { auditEvents, connections, users } from "@db/schema";
import { getDb } from "../queries/connection";
import { viewOf } from "../lib/audit";
import { csvField } from "../auditExport";
import type { ZipEntry } from "../lib/zip";
import { USER_DATA, columnOf, isSkipped, tableOf, type Exported } from "./policy";

/** The account's own fields an export carries (never its password hash). */
const ACCOUNT_FIELDS = ["id", "username", "displayName", "email", "avatarUrl", "role", "permissions", "moduleGrants", "mustChangePassword", "disabledAt", "createdAt"] as const;

/** Connection columns never exported: sealed secrets. */
const CONNECTION_OMIT = ["encrypted_secret", "webhook_secret"];

/** A value as JSON keeps it: times as ISO text, bytes as base64, big numbers as text. */
function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (typeof v === "bigint") return v.toString();
  return v;
}

/** A row's columns as SQL names, without the omitted ones. */
function rowOf(table: PgTable, row: Record<string, unknown>, omit: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (omit.includes(column.name)) continue;
    out[column.name] = plain(row[key]);
  }
  return out;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvField(r[c])).join(","))].join("\r\n") + "\r\n";
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** The person's rows of one table (theirs by user_id, or by a parent row of theirs). */
export async function rowsOf(name: string, userId: number): Promise<Record<string, unknown>[]> {
  const policy = USER_DATA[name];
  const table = tableOf(name);
  const db = getDb();
  if (policy?.kind === "user") {
    return db.select().from(table).where(eq(columnOf(table, "user_id").column, userId));
  }
  if (policy?.kind === "child") {
    const parent = tableOf(policy.parent);
    const owned = db.select({ id: columnOf(parent, "id").column }).from(parent).where(eq(columnOf(parent, "user_id").column, userId));
    return db.select().from(table).where(inArray(columnOf(table, policy.via).column, owned));
  }
  throw new Error(`gdpr: ${name} is not a person's table`);
}

/** Every audit event by or about the person, oldest first, a page at a time. */
async function auditOf(userId: number): Promise<unknown[]> {
  const out: unknown[] = [];
  let after = 0;
  for (;;) {
    const rows = await getDb()
      .select()
      .from(auditEvents)
      .where(and(gt(auditEvents.id, after), or(eq(auditEvents.actorUserId, userId), eq(auditEvents.targetOwnerUserId, userId))))
      .orderBy(asc(auditEvents.id))
      .limit(500);
    out.push(...rows.map(viewOf));
    if (rows.length < 500) return out;
    after = rows[rows.length - 1].id;
  }
}

/** What an export holds, file by file (manifest.json), and what it leaves out and why. */
export type ExportManifest = {
  format: "inkledger-user-export/1";
  userId: number;
  generatedAt: string;
  files: { name: string; rows: number }[];
  notExported: { table: string; reason: string }[];
  note: string;
};

/** The person's files, one table at a time; the manifest last, with what each file held. */
export async function* exportEntries(userId: number, now = new Date()): AsyncGenerator<ZipEntry> {
  const [user] = await getDb().select().from(users).where(eq(users.id, userId));
  if (!user) throw new Error("gdpr: no such account");
  const files: ExportManifest["files"] = [];
  const notExported: ExportManifest["notExported"] = [];

  const account = Object.fromEntries(ACCOUNT_FIELDS.map((k) => [k, plain(user[k])]));
  files.push({ name: "account.json", rows: 1 });
  yield { name: "account.json", data: json(account) };

  const conns = (await getDb().select().from(connections).where(eq(connections.userId, userId)).orderBy(asc(connections.id))).map((r) => rowOf(connections, r, CONNECTION_OMIT));
  files.push({ name: "connections.json", rows: conns.length });
  yield { name: "connections.json", data: json(conns) };

  for (const [name, policy] of Object.entries(USER_DATA).sort(([a], [b]) => a.localeCompare(b))) {
    if (policy.kind !== "user" && policy.kind !== "child") continue;
    if (isSkipped(policy.export)) {
      notExported.push({ table: name, reason: policy.export.skip });
      continue;
    }
    const exported: Exported = policy.export;
    const table = tableOf(name);
    const rows = (await rowsOf(name, userId)).map((r) => rowOf(table, r, exported.omit ?? []));
    files.push({ name: `data/${name}.json`, rows: rows.length });
    yield { name: `data/${name}.json`, data: json(rows) };
    if (exported.csv) {
      files.push({ name: `data/${name}.csv`, rows: rows.length });
      yield { name: `data/${name}.csv`, data: toCsv(rows) };
    }
  }

  const events = await auditOf(userId);
  files.push({ name: "audit_events.json", rows: events.length });
  yield { name: "audit_events.json", data: json(events) };

  const manifest: ExportManifest = {
    format: "inkledger-user-export/1",
    userId,
    generatedAt: now.toISOString(),
    files,
    notExported,
    note: "Secrets, sealed mail copies and binary file contents are not included. Time logged in a tracker is exported from the tracker.",
  };
  yield { name: "manifest.json", data: json(manifest) };
}

/** The tables an export reads (for the meta-test): every person's table not skipped. */
export const exportedTables = (): string[] =>
  Object.entries(USER_DATA)
    .filter(([, p]) => (p.kind === "user" || p.kind === "child") && !isSkipped(p.export))
    .map(([n]) => n)
    .concat(getTableName(connections), getTableName(users), getTableName(auditEvents));
