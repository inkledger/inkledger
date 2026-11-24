import { describe, it, expect, beforeAll } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

process.env.DATABASE_URL = ":memory:";

/**
 * E6 (GDPR): a person's data exported (users.exportData) and erased (users.erase). The
 * seeding is driven by the schema, not by the policy map: every table the map calls a
 * person's gets a row for Ann (exported, then erased) and one for Bob (never touched).
 */

type Row = Record<string, unknown>;
const q = async <T = Row>(text: string, ...params: unknown[]): Promise<T[]> => (await import("../queries/connection")).q<T>(text, ...params);
const one = async <T = Row>(text: string, ...params: unknown[]): Promise<T> => (await q<T>(text, ...params))[0];

/** A string seeded into a person's row, findable in an export (and never in another's). */
const mark = (uid: number) => `<<u${uid}>>`;
/** A secret seeded into a column that must never leave in an export (every one kept, to look for). */
const sentinels: string[] = [];
const sentinel = (uid: number, t: string, c: string) => {
  const s = `SENTINEL-${uid}-${t}-${c}`;
  sentinels.push(s);
  return s;
};

/** Column values a table's constraints need (the generic values break a CHECK). */
const desktop = { device_class: "desktop" };
const OVERRIDES: Record<string, Row> = {
  decisions: { state: "open" },
  ideas: { state: "raw" },
  issue_history_reads: { state: "pending" },
  mail_copies: { mode: "body", source: "eml" },
  mail_copy_reads: { via: "view" },
  mails: { source: "eml" },
  markdown_note_versions: { origin: "auto" },
  markdown_notes: { kind: "note" },
  planned_entries: { kind: "travel", starts_at: 1, ends_at: 2 },
  team_members: { role: "member" },
  workspace_descriptors: desktop,
  workspace_discovery: desktop,
  workspace_drafts: { ...desktop, status: "editing" },
  workspace_flow_aggregates: { ...desktop, origin: "local" },
  workspace_flow_events: desktop,
  workspace_flow_feedback: { status: "unconfirmed" },
  workspace_flow_imports: desktop,
  workspace_imports: desktop,
  workspace_operations: desktop,
  workspace_prepared: desktop,
  workspace_presentations: { ...desktop, status: "stable" },
  workspace_revisions: { ...desktop, status: "committed" },
};

type Column = { column_name: string; data_type: string; is_nullable: "YES" | "NO"; column_default: string | null };

let annId = 0;
let bobId = 0;
let rootId = 0;
/** Rows of the server's own tables a person's rows point at (a team, a role). */
const globals = new Map<string, Row>();
/** Seeded rows: table -> user id -> the row. */
const seeded = new Map<string, Map<number, Row>>();

async function columnsOf(table: string): Promise<Column[]> {
  return q<Column>("SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position", table);
}

function valueFor(c: Column, table: string, uid: number): unknown {
  switch (c.data_type) {
    case "integer":
    case "bigint":
    case "smallint":
    case "numeric":
    case "real":
    case "double precision":
      return 1;
    case "boolean":
      return true;
    case "bytea":
      return Buffer.from(mark(uid));
    case "json":
    case "jsonb":
      return "{}";
    case "uuid":
      return randomUUID();
    case "date":
      return "2026-01-01";
    default:
      if (c.data_type.startsWith("timestamp")) return new Date();
      return `${table}.${c.column_name}.${mark(uid)}`;
  }
}

/** The tables to seed, parents first: every person's table, the connections, and their parents. */
async function seedOrder(): Promise<string[]> {
  const { USER_DATA } = await import("./policy");
  const want = new Set(Object.entries(USER_DATA).filter(([, p]) => p.kind === "user" || p.kind === "child").map(([n]) => n));
  want.add("connections");
  const { tableOf } = await import("./policy");
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const fk of getTableConfig(tableOf(n)).foreignKeys) {
      const target = getTableName(fk.reference().foreignTable);
      if (target !== n && want.has(target)) visit(target);
    }
    out.push(n);
  };
  for (const n of [...want].sort()) visit(n);
  return out;
}

/** One row of `table` for account `uid`: every FK to a seeded row of theirs, secrets as sentinels. */
async function seedRow(table: string, uid: number): Promise<void> {
  const { tableOf, SECRET_LIKE } = await import("./policy");
  const cols = await columnsOf(table);
  const values: Row = {};
  const fkCols = new Set<string>();
  for (const fk of getTableConfig(tableOf(table)).foreignKeys) {
    const ref = fk.reference();
    const target = getTableName(ref.foreignTable);
    if (target === table) continue;
    const parent = target === "users" ? { id: uid } : (seeded.get(target)?.get(uid) ?? globals.get(target));
    if (!parent) continue;
    ref.columns.forEach((c, i) => {
      fkCols.add(c.name);
      // created_by and the like point at the account itself.
      values[c.name] = c.name === "user_id" ? uid : parent[ref.foreignColumns[i].name];
    });
  }
  for (const c of cols) {
    if (c.column_name in values) continue;
    if (c.column_name === "user_id") values.user_id = uid;
    else if (SECRET_LIKE.test(c.column_name) && c.data_type === "text") values[c.column_name] = sentinel(uid, table, c.column_name);
    else if (SECRET_LIKE.test(c.column_name) && c.data_type === "bytea") values[c.column_name] = Buffer.from(sentinel(uid, table, c.column_name));
    else if (c.is_nullable === "NO" && c.column_default === null) values[c.column_name] = valueFor(c, table, uid);
  }
  Object.assign(values, OVERRIDES[table] ?? {});
  const names = Object.keys(values);
  try {
    const row = await one(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")}) RETURNING *`, ...names.map((n) => values[n]));
    if (!seeded.has(table)) seeded.set(table, new Map());
    seeded.get(table)!.set(uid, row);
  } catch (e) {
    // Some rows come by themselves (a trigger, a default per account): that one is theirs.
    const keys = Object.keys(values).filter((k) => k === "user_id" || fkCols.has(k));
    const [existing] = /duplicate key/.test(String(e)) && keys.length > 0 ? await q(`SELECT * FROM "${table}" WHERE ${keys.map((k) => `"${k}" = ?`).join(" AND ")}`, ...keys.map((k) => values[k])) : [];
    if (!existing) throw new Error(`seeding ${table}: ${String(e)} with ${JSON.stringify(values)}`);
    if (!seeded.has(table)) seeded.set(table, new Map());
    seeded.get(table)!.set(uid, existing);
  }
}

async function account(username: string, displayName: string, role: "admin" | "member", permissions: string[] = [], roleKey?: string): Promise<number> {
  const [r] = roleKey ? await q<{ id: number }>("SELECT id FROM roles WHERE key = ?", roleKey) : [];
  return (await one<{ id: number }>("INSERT INTO users (username, display_name, email, role, role_id, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id", username, displayName, username + "@example.com", role, r?.id ?? null, JSON.stringify(permissions))).id;
}

async function cookieOf(id: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", createHash("sha256").update(token).digest("hex"), id, Date.now() + 3_600_000, Date.now());
  const { sessionCookie } = await import("../lib/session");
  return sessionCookie(new Request("http://localhost/"), token, 3600).split(";")[0];
}

async function callerOf(id: number) {
  const { appRouter } = await import("../router");
  const { getDb } = await import("../queries/connection");
  const { users } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const [user] = await getDb().select().from(users).where(eq(users.id, id));
  return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null, deviceId: "dev-" + String(id) });
}

let app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> };
const exportOf = (cookie: string, id: number) => app.request(`http://localhost/api/users/${id}/export`, { headers: { cookie } });

async function unzip(res: Response): Promise<Map<string, string>> {
  const { readZip } = await import("../lib/zip");
  return new Map(readZip(new Uint8Array(await res.arrayBuffer())).map((e) => [e.name, e.data.toString("utf8")]));
}

beforeAll(async () => {
  await (await import("../queries/connection")).resetDbForTests();
  rootId = await account("root", "Root Owner", "admin", [], "owner");
  annId = await account("ann", "Ann Example", "member");
  bobId = await account("bob", "Bob Other", "member");
  globals.set("teams", await one("INSERT INTO teams (name, created_at) VALUES ('Team', 1) RETURNING *"));
  globals.set("roles", await one("SELECT * FROM roles WHERE key = 'auditor'"));
  for (const t of await seedOrder()) {
    await seedRow(t, annId);
    await seedRow(t, bobId);
  }
  const { record, recordSystem, flushAudit } = await import("../lib/audit");
  const req = new Request("http://localhost/", { headers: { "user-agent": "test", "x-forwarded-for": "203.0.113.7" } });
  await record({ req, remoteAddress: "203.0.113.7", user: { id: annId, username: "ann", displayName: "Ann Example" } }, "auth.signIn", { target: { type: "user", id: annId, ownerUserId: annId }, after: { method: "password", username: "ann" } });
  await record({ req, remoteAddress: "198.51.100.9", user: { id: rootId, username: "root", displayName: "Root Owner" } }, "users.rename", { target: { type: "user", id: annId, ownerUserId: annId }, before: { username: "ann", displayName: "Ann Example" }, after: { username: "ann", displayName: "Ann Example" } });
  await record({ req, user: { id: bobId, username: "bob", displayName: "Bob Other" } }, "auth.signIn", { target: { type: "user", id: bobId, ownerUserId: bobId }, after: { method: "password", username: "bob" } });
  await recordSystem({ kind: "system", label: "retention" }, "audit.purge", { after: { deleted: 0 } });
  // Through the real procedures: a failed sign-in, and a team change naming Ann only by username.
  const { appRouter } = await import("../router");
  const anonymous = appRouter.createCaller({ req, resHeaders: new Headers(), user: null, sessionId: null, deviceId: "dev-anon" });
  await anonymous.auth.login({ username: "ann", password: "a wrong password, long enough" }).catch(() => undefined);
  await (await callerOf(rootId)).teams.setMember({ teamId: Number(globals.get("teams")!.id), userId: annId, role: "lead" });
  await flushAudit();
  const { Hono } = await import("hono");
  const { registerUserDataRoutes } = await import("./routes");
  const hono = new Hono<{ Bindings: HttpBindings }>();
  registerUserDataRoutes(hono);
  app = hono;
}, 120_000);

describe("the map of a person's data", () => {
  it("places every table of the schema", async () => {
    const { USER_DATA, TABLES } = await import("./policy");
    expect(Object.keys(USER_DATA).sort()).toEqual([...TABLES.keys()].sort());
  });

  it("calls every table with a user_id column a person's (users and connections apart)", async () => {
    const { USER_DATA, TABLES } = await import("./policy");
    const wrong = [...TABLES].filter(([n, t]) => getTableConfig(t).columns.some((c) => c.name === "user_id") && n !== "connections" && USER_DATA[n]?.kind !== "user").map(([n]) => n);
    expect(wrong).toEqual([]);
  });

  it("knows every other reference to an account or a connection", async () => {
    const { USER_DATA, TABLES } = await import("./policy");
    const odd: string[] = [];
    for (const [n, t] of TABLES) {
      for (const fk of getTableConfig(t).foreignKeys) {
        const target = getTableName(fk.reference().foreignTable);
        const cols = fk.reference().columns.map((c) => c.name);
        const p = USER_DATA[n];
        if (target === "users" && !cols.includes("user_id") && fk.onDelete !== "set null") odd.push(`${n}.${cols.join("+")} -> users`);
        // A connection reference that doesn't cascade must sit in a person's table (emptied before the connections go).
        if (target === "connections" && fk.onDelete !== "cascade" && fk.onDelete !== "set null" && p?.kind !== "user") odd.push(`${n}.${cols.join("+")} -> connections`);
      }
    }
    expect(odd).toEqual([]);
    // A child goes with its parent: the reference it is reached by cascades.
    for (const [n, p] of Object.entries(USER_DATA)) {
      if (p.kind !== "child") continue;
      const fk = getTableConfig(TABLES.get(n)!).foreignKeys.find((f) => getTableName(f.reference().foreignTable) === p.parent && f.reference().columns.some((c) => c.name === p.via));
      expect.soft(fk?.onDelete, n).toBe("cascade");
      expect.soft(USER_DATA[p.parent]?.kind === "user" || p.parent === "connections", n).toBe(true);
    }
  });

  it("never exports a column that may hold a secret", async () => {
    const { USER_DATA, TABLES, SECRET_LIKE, isSkipped } = await import("./policy");
    const leaks: string[] = [];
    for (const [n, p] of Object.entries(USER_DATA)) {
      if ((p.kind !== "user" && p.kind !== "child") || isSkipped(p.export)) continue;
      const omit = p.export.omit ?? [];
      for (const c of getTableConfig(TABLES.get(n)!).columns) if (SECRET_LIKE.test(c.name) && !omit.includes(c.name)) leaks.push(`${n}.${c.name}`);
    }
    expect(leaks).toEqual([]);
  });

  it("empties a table before the ones it points at without cascading", async () => {
    const { USER_DATA } = await import("./policy");
    const { eraseOrder } = await import("./erase");
    const order = eraseOrder();
    expect([...order].sort()).toEqual(Object.entries(USER_DATA).filter(([, p]) => p.kind === "user").map(([n]) => n).sort());
    const { tableOf } = await import("./policy");
    const late: string[] = [];
    for (const n of order) {
      for (const fk of getTableConfig(tableOf(n)).foreignKeys) {
        const target = getTableName(fk.reference().foreignTable);
        const blocking = fk.onDelete === undefined || fk.onDelete === "no action" || fk.onDelete === "restrict";
        if (blocking && target !== n && order.includes(target) && order.indexOf(n) > order.indexOf(target)) late.push(`${n} -> ${target}`);
      }
    }
    expect(late).toEqual([]);
  });
});

describe("exporting a person's data", () => {
  it("is a ZIP of every table of theirs, their rows only, without secrets", async () => {
    const res = await exportOf(await cookieOf(annId), annId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const files = await unzip(res);
    const manifest = JSON.parse(files.get("manifest.json")!) as { files: { name: string; rows: number }[]; notExported: { table: string }[] };
    // The snapshot names every file and how many rows it held (Ann's: one each, two role assignments as a lead too).
    expect({ files: manifest.files, notExported: manifest.notExported.map((x) => x.table) }).toMatchSnapshot();
    const { USER_DATA, isSkipped } = await import("./policy");
    for (const [n, p] of Object.entries(USER_DATA)) {
      if ((p.kind !== "user" && p.kind !== "child") || isSkipped(p.export)) continue;
      const rows = JSON.parse(files.get(`data/${n}.json`) ?? "null") as Row[] | null;
      expect.soft(rows?.length ?? 0, n).toBeGreaterThanOrEqual(1);
      if (p.kind === "user") expect.soft(rows?.[0]?.user_id, n).toBe(annId);
    }
    const all = [...files.values()].join("\n");
    expect(all).toContain(mark(annId));
    expect(all).not.toContain(mark(bobId));
    expect(sentinels.length).toBeGreaterThan(3);
    for (const s of sentinels) {
      expect.soft(all).not.toContain(s);
      expect.soft(all).not.toContain(Buffer.from(s).toString("base64"));
    }
    expect(all).not.toContain("password_hash");
    const account = JSON.parse(files.get("account.json")!) as Row;
    expect(account).toMatchObject({ id: annId, username: "ann", displayName: "Ann Example" });
    expect(account).not.toHaveProperty("passwordHash");
    const conns = JSON.parse(files.get("connections.json")!) as Row[];
    expect(conns).toHaveLength(1);
    expect(conns[0]).not.toHaveProperty("encrypted_secret");
    const events = JSON.parse(files.get("audit_events.json")!) as { action: string; actorUserId: number | null; ip: string | null }[];
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["auth.signIn", "auth.signInFailed", "users.rename", "teams.setMember"]));
    // Someone else's address is the audit log's (viewAudit), not the person's.
    expect(events.filter((e) => e.actorUserId !== annId).map((e) => e.ip)).toEqual(events.filter((e) => e.actorUserId !== annId).map(() => null));
    expect(events.find((e) => e.action === "auth.signIn")?.ip).toBe("203.0.113.7");
    expect(files.get("data/worklogs.csv")).toMatch(/^id,uuid,user_id/);
  });

  it("is anyone's own; someone else's takes exportUserData, and every one is recorded", async () => {
    const { flushAudit } = await import("../lib/audit");
    expect((await exportOf(await cookieOf(bobId), annId)).status).toBe(403);
    expect((await exportOf(await cookieOf(await account("ita", "IT", "member", [], "it-admin")), annId)).status).toBe(403);
    expect((await exportOf("nope=1", annId)).status).toBe(401);
    const dpo = await account("dpo", "Data Officer", "member", ["exportUserData"]);
    expect((await exportOf(await cookieOf(dpo), annId)).status).toBe(200);
    expect((await exportOf(await cookieOf(dpo), 999_999)).status).toBe(404);
    await flushAudit();
    const rows = await q<{ actor_user_id: number; outcome: string; target_owner_user_id: number }>("SELECT actor_user_id, outcome, target_owner_user_id FROM audit_events WHERE action = 'users.exportData' ORDER BY id");
    expect(rows).toEqual(
      expect.arrayContaining([
        { actor_user_id: annId, outcome: "ok", target_owner_user_id: annId },
        { actor_user_id: bobId, outcome: "denied", target_owner_user_id: annId },
        { actor_user_id: dpo, outcome: "ok", target_owner_user_id: annId },
      ]),
    );
  });
});

describe("erasing a person's data", () => {
  it("takes eraseUserData, an owner, the username typed, and never one's own account", async () => {
    const plain = await callerOf(bobId);
    await expect(plain.users.erase({ id: annId, confirmUsername: "ann" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const holder = await callerOf(await account("eraser", "Eraser", "member", ["eraseUserData"]));
    await expect(holder.users.erase({ id: annId, confirmUsername: "ann" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const root = await callerOf(rootId);
    await expect(root.users.erase({ id: annId, confirmUsername: "bob" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(root.users.erase({ id: rootId, confirmUsername: "root" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await q("SELECT id FROM users WHERE id = ?", annId)).toHaveLength(1);
  });

  it("is refused for the last active owner", async () => {
    // An owner by role alone (users.role member): the only owner the lock counts is the target.
    const byRole = await account("byrole", "Owner By Role", "member", [], "owner");
    const others = await q<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND id <> ? AND disabled_at IS NULL", rootId);
    await q("UPDATE users SET disabled_at = 1 WHERE id = ANY(?)", others.map((o) => o.id));
    try {
      await expect((await callerOf(byRole)).users.erase({ id: rootId, confirmUsername: "root" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/owner/i) });
      expect(await q("SELECT id FROM users WHERE id = ?", rootId)).toHaveLength(1);
    } finally {
      await q("UPDATE users SET disabled_at = NULL WHERE id = ANY(?)", others.map((o) => o.id));
    }
  });

  it("leaves no row pointing at the account or its connections, and Bob's rows as they were", async () => {
    const { USER_DATA, TABLES } = await import("./policy");
    const annConnections = (await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ?", annId)).map((r) => r.id);
    expect(annConnections.length).toBeGreaterThan(0);
    // Every person's table held a row of Ann's (else "nothing left" proves nothing).
    for (const [n, p] of Object.entries(USER_DATA)) if (p.kind === "user") expect.soft((await q(`SELECT 1 FROM "${n}" WHERE user_id = ?`, annId)).length, n).toBeGreaterThanOrEqual(1);
    const bobBefore = new Map<string, string>();
    for (const [n] of TABLES) bobBefore.set(n, JSON.stringify(await bobsRows(n)));

    const out = await (await callerOf(rootId)).users.erase({ id: annId, confirmUsername: "ANN" });
    expect(out).toMatchObject({ erased: `erased-user-${annId}`, connections: 1 });

    const left: string[] = [];
    for (const [n, t] of TABLES) {
      const cfg = getTableConfig(t);
      for (const c of cfg.columns) {
        const pointsAtUser = ["user_id", "created_by", "actor_user_id", "target_owner_user_id"].includes(c.name) || cfg.foreignKeys.some((f) => getTableName(f.reference().foreignTable) === "users" && f.reference().columns.some((x) => x.name === c.name));
        // The audit log keeps the id (pseudonymised rows): checked below.
        if (n === "audit_events") continue;
        if (pointsAtUser && (await q(`SELECT 1 FROM "${n}" WHERE "${c.name}" = ?`, annId)).length > 0) left.push(`${n}.${c.name}`);
        if (/connection_id$/.test(c.name) && (await q(`SELECT 1 FROM "${n}" WHERE "${c.name}" = ANY(?)`, annConnections)).length > 0) left.push(`${n}.${c.name}`);
      }
    }
    expect(left).toEqual([]);
    expect(await q("SELECT id FROM users WHERE id = ?", annId)).toEqual([]);
    for (const [n] of TABLES) if (n !== "audit_events") expect.soft(JSON.stringify(await bobsRows(n)), n).toBe(bobBefore.get(n));
  });

  it("pseudonymises the audit rows by or about the person, and the chain still verifies", async () => {
    const { flushAudit, verifyAudit } = await import("../lib/audit");
    await flushAudit();
    const rows = await q<{ actor_user_id: number | null; actor_label: string; ip: string | null; before: string | null; after: string | null; pseudonymised_at: number | null; action: string }>(
      "SELECT actor_user_id, actor_label, ip, before, after, pseudonymised_at, action FROM audit_events WHERE actor_user_id = ? OR target_owner_user_id = ? ORDER BY id",
      annId,
      annId,
    );
    const theirs = rows.filter((r) => r.action !== "users.erase");
    expect(theirs.length).toBeGreaterThan(2);
    for (const r of theirs) expect.soft(r.pseudonymised_at).not.toBeNull();
    for (const r of theirs.filter((x) => x.actor_user_id === annId)) expect.soft([r.actor_label, r.ip]).toEqual([`erased-user-${annId}`, null]);
    // Nowhere in the log, whichever row named her (a team change names its member by username only).
    const text = JSON.stringify(await q("SELECT actor_label, before, after FROM audit_events"));
    expect(text).not.toMatch(/\\"ann\\"|"ann"|Ann Example|ann@example\.com/);
    expect(await q("SELECT 1 FROM audit_events WHERE actor_label = 'root'")).not.toHaveLength(0);
    const erase = rows.find((r) => r.action === "users.erase");
    expect(erase?.pseudonymised_at).toBeNull();
    expect(JSON.parse(erase!.after!)).toMatchObject({ erased: `erased-user-${annId}` });
    expect(await verifyAudit()).toMatchObject({ ok: true });
    // Bob's own events are untouched.
    expect(await q("SELECT actor_label FROM audit_events WHERE actor_user_id = ? AND pseudonymised_at IS NULL", bobId)).not.toHaveLength(0);
  });

  it("lets no other change through, even under the erasure's setting", async () => {
    const { getDb } = await import("../queries/connection");
    const { sql } = await import("drizzle-orm");
    const [{ id }] = await q<{ id: number }>("SELECT id FROM audit_events WHERE actor_user_id = ? LIMIT 1", bobId);
    const attempt = (set: string) =>
      getDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('inkledger.audit_pseudonymise', 'on', true)`);
        await tx.execute(sql.raw(`UPDATE audit_events SET ${set} WHERE id = ${id}`));
      });
    await expect(attempt("action = 'auth.signOut', pseudonymised_at = 1")).rejects.toThrow();
    await expect(attempt("hash = 'x', pseudonymised_at = 1")).rejects.toThrow();
    await expect(attempt("actor_label = 'x'")).rejects.toThrow();
    await expect(q("UPDATE audit_events SET actor_label = 'x', pseudonymised_at = 1 WHERE id = ?", id)).rejects.toThrow();
    await expect(q("DELETE FROM audit_events WHERE id = ?", id)).rejects.toThrow();
  });

  it("still finds an edited row that no erasure touched", async () => {
    const { verifyAudit } = await import("../lib/audit");
    const [{ id }] = await q<{ id: number }>("SELECT id FROM audit_events WHERE actor_user_id = ? AND pseudonymised_at IS NULL LIMIT 1", bobId);
    await q("ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only");
    await q("UPDATE audit_events SET actor_label = 'mallory' WHERE id = ?", id);
    await q("ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only");
    expect(await verifyAudit()).toMatchObject({ ok: false, badId: id, reason: "hash" });
  });
});

/** Bob's rows of a table: his by user_id, or by a parent row of his. */
async function bobsRows(n: string): Promise<Row[]> {
  const { USER_DATA } = await import("./policy");
  const p = USER_DATA[n];
  if (n === "users") return q("SELECT * FROM users WHERE id = ?", bobId);
  if (n === "connections" || p?.kind === "user") return q(`SELECT * FROM "${n}" WHERE user_id = ? ORDER BY 1`, bobId);
  if (p?.kind === "child") return q(`SELECT * FROM "${n}" WHERE "${p.via}" IN (SELECT id FROM "${p.parent}" WHERE user_id = ?) ORDER BY 1`, bobId);
  return q(`SELECT * FROM "${n}" ORDER BY 1`);
}
