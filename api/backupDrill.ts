// The restore drill (Settings → Backup, weekly and on demand): the newest backup is
// restored into a scratch database, never the live one, and read back: accounts,
// worklogs and connections counted, its migrations no newer than this build's, its
// sealed secrets opened with the keys configured now. Then the scratch database is
// dropped. A backup nobody ever restored is a hope; this makes it a fact each week.
import { sql } from "drizzle-orm";
import pg from "pg";
import { env } from "./lib/env";
import { getServerSetting, setServerSetting, updateServerSetting } from "./lib/serverSettings";
import { recordSystem } from "./lib/audit";
import { getDb, newestMigration, type Db } from "./queries/connection";
import { keysStatus } from "./queries/sealedValues";
import { backupDir, isRestoring, listBackups, pgTarget, restoreInto } from "./backup";
import { raiseAlert, resolveAlert } from "./ops/alerts";
import path from "node:path";

/** The scratch database's name: fixed, so a drill cut short is cleaned by the next. */
export const DRILL_DB = "inkledger_drill";
export const DRILL_EVERY_MS = 7 * 86_400_000;

export type DrillResult = {
  at: number;
  ok: boolean;
  /** The backup restored */
  dump: string | null;
  durationMs: number;
  users: number | null;
  worklogs: number | null;
  connections: number | null;
  /** The newest migration in the backup, and this build's (journal `when`) */
  migrationHead: number | null;
  buildHead: number;
  sealed: number | null;
  sealedUnreadable: number | null;
  error: string | null;
};
export type DrillSettings = { weekly: boolean };
export const DEFAULT_DRILL: DrillSettings = { weekly: true };

const SETTINGS_KEY = "backup.drill";
const STATE_KEY = "backup.drillState";

export async function getDrillSettings(): Promise<DrillSettings> {
  const s = await getServerSetting<Partial<DrillSettings>>(SETTINGS_KEY, {});
  return { weekly: typeof s?.weekly === "boolean" ? s.weekly : DEFAULT_DRILL.weekly };
}

export async function setDrillSettings(patch: Partial<DrillSettings>): Promise<DrillSettings> {
  return updateServerSetting<DrillSettings>(SETTINGS_KEY, DEFAULT_DRILL, (cur) => ({ weekly: patch.weekly ?? (typeof cur?.weekly === "boolean" ? cur.weekly : DEFAULT_DRILL.weekly) }));
}

export async function getLastDrill(): Promise<DrillResult | null> {
  return getServerSetting<DrillResult | null>(STATE_KEY, null);
}

type Rows = { rows: Record<string, unknown>[] };

/** Where a drill restores: Postgres beside the live database in the server, a second PGlite in tests. */
export type DrillTarget = {
  /** Clears what a drill cut short left, then makes the empty scratch database. */
  prepare(): Promise<void>;
  restore(file: string): Promise<void>;
  open(): Promise<{ db: Db; query: (text: string) => Promise<Rows>; close: () => Promise<void> }>;
  drop(): Promise<void>;
};

/** The scratch database's address: the live one's server and user, the drill's name. Refuses the live database. */
export function drillUrl(liveUrl: string): string {
  const u = new URL(liveUrl);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("The drill needs a Postgres database (DATABASE_URL).");
  const live = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!live || live === DRILL_DB) throw new Error(`The live database is named ${DRILL_DB}: the drill would replace it, so it does not run.`);
  u.pathname = `/${DRILL_DB}`;
  return u.toString();
}

/** The drill on Postgres: CREATE DATABASE (the server's role needs CREATEDB), the dump restored by the same path a restore takes. */
export function pgDrillTarget(): DrillTarget {
  const full = drillUrl(env.databaseUrl);
  const live = pgTarget();
  const target = { url: drillUrl(live.url), env: live.env };
  const admin = (text: string) => getDb().execute(sql.raw(text));
  return {
    prepare: async () => {
      await admin(`DROP DATABASE IF EXISTS "${DRILL_DB}" WITH (FORCE)`);
      await admin(`CREATE DATABASE "${DRILL_DB}"`);
    },
    restore: (file) => restoreInto(target, file),
    open: async () => {
      const pool = new pg.Pool({ connectionString: full, max: 2 });
      const { drizzle } = await import("drizzle-orm/node-postgres");
      return { db: drizzle(pool) as unknown as Db, query: (text) => pool.query(text), close: () => pool.end() };
    },
    drop: async () => {
      await admin(`DROP DATABASE IF EXISTS "${DRILL_DB}" WITH (FORCE)`);
    },
  };
}

const count = async (query: (t: string) => Promise<Rows>, table: string) => Number((await query(`SELECT count(*) AS n FROM public."${table}"`)).rows[0]?.n ?? 0);

let running: Promise<DrillResult> | null = null;

export type DrillActor = { scheduled: boolean };

/**
 * One drill now (never two at once): the newest backup restored into the scratch
 * database, checked, dropped. Records the result; a failure raises the "drill"
 * alert, a success clears it. A scheduled one writes its own audit event (one asked
 * for in Settings is the procedure's).
 */
export function runDrill(opts: { target?: DrillTarget; scheduled?: boolean } = {}): Promise<DrillResult> {
  running ??= (async () => {
    const started = Date.now();
    const buildHead = newestMigration();
    const result: DrillResult = {
      at: started,
      ok: false,
      dump: null,
      durationMs: 0,
      users: null,
      worklogs: null,
      connections: null,
      migrationHead: null,
      buildHead,
      sealed: null,
      sealedUnreadable: null,
      error: null,
    };
    let target: DrillTarget | null = null;
    let prepared = false;
    try {
      if (isRestoring()) throw new Error("A restore is under way: the drill waits for the next time.");
      const newest = listBackups()[0];
      if (!newest) throw new Error("There is no backup to restore yet.");
      result.dump = newest.name;
      target = opts.target ?? pgDrillTarget();
      await target.prepare();
      prepared = true;
      await target.restore(path.join(backupDir(), newest.name));
      const scratch = await target.open();
      try {
        result.users = await count(scratch.query, "users");
        result.worklogs = await count(scratch.query, "worklogs");
        result.connections = await count(scratch.query, "connections");
        const head = (await scratch.query("SELECT max(created_at) AS head FROM drizzle.__drizzle_migrations")).rows[0]?.head;
        result.migrationHead = head === null || head === undefined ? null : Number(head);
        const keys = await keysStatus(scratch.db);
        result.sealed = keys.columns.reduce((n, c) => n + c.total, 0);
        result.sealedUnreadable = keys.columns.reduce((n, c) => n + c.unreadable, 0);
      } finally {
        await scratch.close().catch(() => undefined);
      }
      const problems = [
        result.users === 0 ? "the backup holds no accounts" : null,
        result.migrationHead === null ? "the backup holds no migrations" : result.migrationHead > buildHead ? "the backup comes from a newer inkledger" : null,
        (result.sealedUnreadable ?? 0) > 0 ? `${result.sealedUnreadable} sealed value(s) don't open with the keys configured now (CREDENTIALS_KEY / CREDENTIALS_KEY_OLD)` : null,
      ].filter((p): p is string => p !== null);
      if (problems.length > 0) throw new Error(problems.join("; "));
      result.ok = true;
    } catch (e) {
      result.error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    } finally {
      if (prepared && target) {
        await target.drop().catch((e: unknown) => {
          result.ok = false;
          result.error = [result.error, `the scratch database ${DRILL_DB} was not dropped: ${e instanceof Error ? e.message : String(e)}`].filter(Boolean).join("; ").slice(0, 500);
        });
      }
    }
    result.durationMs = Date.now() - started;
    await setServerSetting(STATE_KEY, result);
    if (result.ok) await resolveAlert("drill").catch(() => undefined);
    else await raiseAlert({ key: "drill", kind: "drill", name: result.dump ?? "drill" });
    if (opts.scheduled) {
      await recordSystem({ kind: "system", label: "schedule" }, "backup.drill", {
        target: { type: "backup", id: result.dump ?? "" },
        after: drillAudit(result, true),
        outcome: result.ok ? "ok" : "failed",
      }).catch(() => undefined);
    }
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** What the audit log keeps of a drill (its own fields in contracts/audit.ts). */
export const drillAudit = (r: DrillResult, scheduled: boolean) => ({
  dump: r.dump,
  ok: r.ok,
  users: r.users,
  worklogs: r.worklogs,
  connections: r.connections,
  migrationHead: r.migrationHead,
  sealedUnreadable: r.sealedUnreadable,
  error: r.error,
  scheduled,
});

/** The weekly drill in the container: looked at hourly, run when the last one is a week old. Returns its stop. */
export function startDrillScheduler(): () => void {
  const tick = setInterval(() => void drillIfDue().catch((e: unknown) => console.warn(`[backup] drill: ${String(e)}`)), 3600_000);
  tick.unref();
  return () => clearInterval(tick);
}

/** The weekly drill, when it is due (looked at hourly by startDrillScheduler). */
export async function drillIfDue(now = Date.now(), target?: DrillTarget): Promise<DrillResult | null> {
  if (!(await getDrillSettings()).weekly || isRestoring() || listBackups().length === 0) return null;
  const last = await getLastDrill();
  if (last && now - last.at < DRILL_EVERY_MS) return null;
  return runDrill({ scheduled: true, ...(target ? { target } : {}) });
}
