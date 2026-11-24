// GET /api/ready: whether this server can do its work now, beyond being alive
// (/api/health). Each check says ok, failed or skipped (its feature is off here);
// any failed check answers 503. Booleans and ages only: no path, no error text.
import fs from "node:fs";
import { sql } from "drizzle-orm";
import { getDb, newestMigration, pingDb } from "../queries/connection";
import { backupDir, backupSchedulerOn, getBackupSettings, getBackupState, type BackupSettings } from "../backup";
import { schedulerHeartbeat } from "../syncScheduler";
import { opsConfig } from "./config";

export type Check = { status: "ok" | "failed" | "skipped" } & Record<string, string | number | boolean | null>;
export type Readiness = { status: "ok" | "failed"; checks: Record<"database" | "migrations" | "disk" | "backup" | "scheduler", Check> };

const HOUR = 3600_000;

/** How old the last good backup may be for its schedule (one missed run is tolerated, not two). */
export function backupMaxAgeMs(s: Pick<BackupSettings, "schedule">): number | null {
  switch (s.schedule) {
    case "hourly":
      return 3 * HOUR;
    case "daily":
      return 49 * HOUR;
    case "weekly":
      return 8 * 24 * HOUR + HOUR;
    default:
      return null;
  }
}

/** The newest migration this build ships is applied to the database. */
async function migrationsApplied(): Promise<boolean> {
  const result = (await getDb().execute(sql`SELECT coalesce(max(created_at), 0)::bigint AS newest FROM drizzle.__drizzle_migrations`)) as { rows: { newest: number | string }[] };
  return Number(result.rows[0]?.newest ?? 0) >= newestMigration();
}

function freeMb(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Math.floor((s.bavail * s.bsize) / (1024 * 1024));
  } catch {
    return null;
  }
}

type Inputs = {
  now?: number;
  /** Seconds since the process started (a new server has no backup yet). */
  uptimeSec?: number;
  backupOn?: boolean;
  heartbeat?: ReturnType<typeof schedulerHeartbeat>;
  free?: (dir: string) => number | null;
};

export async function readiness(o: Inputs = {}): Promise<Readiness> {
  const now = o.now ?? Date.now();
  const uptimeMs = (o.uptimeSec ?? process.uptime()) * 1000;
  const db = await pingDb();
  const checks: Readiness["checks"] = {
    database: { status: db ? "ok" : "failed" },
    migrations: { status: "skipped" },
    disk: { status: "skipped" },
    backup: { status: "skipped" },
    scheduler: { status: "skipped" },
  };
  if (db) {
    checks.migrations = { status: (await migrationsApplied().catch(() => false)) ? "ok" : "failed" };
  }
  const backupOn = o.backupOn ?? backupSchedulerOn();
  // Where backups go: a disk that fills stops them (and the database's own disk is often the same).
  const free = (o.free ?? freeMb)(backupDir());
  if (free !== null) checks.disk = { status: free >= opsConfig.readyMinFreeMb ? "ok" : "failed", freeMb: free, minFreeMb: opsConfig.readyMinFreeMb };
  else if (backupOn) checks.disk = { status: "failed", freeMb: null };
  if (backupOn && db) {
    const [settings, state] = await Promise.all([getBackupSettings(), getBackupState()]);
    const maxAge = backupMaxAgeMs(settings);
    if (maxAge !== null) {
      const age = state.lastOkAt !== null ? now - state.lastOkAt : null;
      // None yet: fine while the server is younger than one period.
      const ok = age !== null ? age <= maxAge : uptimeMs <= maxAge;
      checks.backup = { status: ok ? "ok" : "failed", ageSeconds: age === null ? null : Math.round(age / 1000), maxAgeSeconds: maxAge / 1000 };
    }
  }
  const beat = o.heartbeat !== undefined ? o.heartbeat : schedulerHeartbeat();
  if (beat) {
    // A pass may run long (many accounts, slow trackers): alive while within twice its interval, at least half an hour.
    const limit = Math.max(2 * beat.minutes * 60_000, 30 * 60_000) + 60_000;
    const age = now - beat.at;
    checks.scheduler = { status: age <= limit ? "ok" : "failed", ageSeconds: Math.round(age / 1000), running: beat.running };
  }
  const status = Object.values(checks).some((c) => c.status === "failed") ? "failed" : "ok";
  return { status, checks };
}
