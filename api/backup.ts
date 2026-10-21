import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "./lib/env";
import { getServerSetting, setServerSetting } from "./lib/serverSettings";
import { migrateDb } from "./queries/connection";
import { t } from "@contracts/i18n";

/**
 * Database backups (pg_dump, custom format) into a folder outside the
 * container (docker-compose mounts ~/Backups/inkledger on /backups).
 * Scheduled from Settings → Backup; the newest N are kept.
 */
export const backupSettingsSchema = z.object({
  schedule: z.enum(["off", "hourly", "daily", "weekly"]),
  /** "HH:MM", local time (daily / weekly) */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** 1 = Monday … 7 = Sunday (weekly) */
  weekday: z.number().int().min(1).max(7),
  keep: z.number().int().min(1).max(365),
});
export type BackupSettings = z.infer<typeof backupSettingsSchema>;
export const DEFAULT_BACKUP: BackupSettings = { schedule: "daily", time: "02:00", weekday: 1, keep: 14 };

export type BackupState = { lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null };
const SETTINGS_KEY = "backup";
const STATE_KEY = "backup.state";

export const BACKUP_FILE = /^inkledger-\d{8}-\d{6}\.dump$/;

export function backupDir(): string {
  return process.env.BACKUP_DIR ?? (env.isProduction ? "/backups" : path.join(process.cwd(), "data/backups"));
}

/** "inkledger-20261016-020000.dump" (local time: matches what the user sees). */
export function backupName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `inkledger-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.dump`;
}

/** Next scheduled run strictly after `now`, or null when off. */
export function nextRun(s: BackupSettings, now: Date): Date | null {
  if (s.schedule === "off") return null;
  if (s.schedule === "hourly") {
    const d = new Date(now);
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d;
  }
  const [h, m] = s.time.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (s.schedule === "daily") {
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  // weekly: JS getDay() is 0 = Sunday
  const want = s.weekday % 7;
  let add = (want - d.getDay() + 7) % 7;
  if (add === 0 && d <= now) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}

/**
 * Which files go: all but the newest `keep` (names sort by time). The backup
 * being restored never goes, even when it is the oldest one.
 */
export function toPrune(files: string[], keep: number, spare: string | null = null): string[] {
  const ours = files.filter((f) => BACKUP_FILE.test(f)).sort();
  return ours.slice(0, Math.max(0, ours.length - keep)).filter((f) => f !== spare);
}

/** The backup a restore is reading right now (spared by pruning). */
let restoring: string | null = null;

export async function getBackupSettings(): Promise<BackupSettings> {
  const saved = backupSettingsSchema.partial().safeParse(await getServerSetting<unknown>(SETTINGS_KEY, {}));
  return { ...DEFAULT_BACKUP, ...(saved.success ? saved.data : {}) };
}

export async function setBackupSettings(patch: Partial<BackupSettings>): Promise<BackupSettings> {
  const next = backupSettingsSchema.parse({ ...(await getBackupSettings()), ...patch });
  await setServerSetting(SETTINGS_KEY, next);
  reschedule();
  return next;
}

export async function getBackupState(): Promise<BackupState> {
  return getServerSetting<BackupState>(STATE_KEY, { lastOkAt: null, lastError: null, lastErrorAt: null });
}

export function listBackups(dir = backupDir()): { name: string; size: number; at: number }[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => BACKUP_FILE.test(f))
      .map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, size: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

/** The folder exists and we can write there (a disk may be unplugged). */
export function backupDirWritable(dir = backupDir()): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The database URL without its password, which goes in PGPASSWORD instead:
 * on the command line anyone running `ps` in the container would read it.
 */
function pgTarget(): { url: string; env: NodeJS.ProcessEnv } {
  try {
    const u = new URL(env.databaseUrl);
    if (!u.password) return { url: env.databaseUrl, env: process.env };
    const password = decodeURIComponent(u.password);
    u.password = "";
    return { url: u.toString(), env: { ...process.env, PGPASSWORD: password } };
  } catch {
    return { url: env.databaseUrl, env: process.env };
  }
}

function run(bin: string, args: string[], childEnv: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], env: childEnv });
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || t("server.backup.exitedWith", { bin, code: code ?? "?" })))));
  });
}

let running: Promise<string> | null = null;

/** One backup now (never two at once); returns the file name. */
export function runBackup(): Promise<string> {
  running ??= (async () => {
    const dir = backupDir();
    const name = backupName(new Date());
    const tmp = path.join(dir, `.${name}.partial`);
    try {
      if (!backupDirWritable(dir)) throw new Error(t("server.backup.dirNotWritable", { dir }));
      const target = pgTarget();
      await run(process.env.PG_DUMP_BIN ?? "pg_dump", ["--format=custom", `--file=${tmp}`, target.url], target.env);
      fs.renameSync(tmp, path.join(dir, name));
      const { keep } = await getBackupSettings();
      for (const old of toPrune(fs.readdirSync(dir), keep, restoring)) fs.rmSync(path.join(dir, old), { force: true });
      const state = await getBackupState();
      await setServerSetting(STATE_KEY, { ...state, lastOkAt: Date.now() });
      return name;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      const msg = e instanceof Error ? e.message : String(e);
      const state = await getBackupState();
      await setServerSetting(STATE_KEY, { ...state, lastError: msg.slice(0, 500), lastErrorAt: Date.now() });
      throw e;
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/**
 * Replace the database with a backup. A safety backup of the current data
 * comes first, so a wrong pick can be undone.
 */
export async function restoreBackup(name: string): Promise<{ safety: string }> {
  if (!BACKUP_FILE.test(name)) throw new Error(t("server.backup.invalid"));
  const file = path.join(backupDir(), name);
  if (!fs.existsSync(file)) throw new Error(t("server.backup.notFound"));
  restoring = name;
  try {
    const safety = await runBackup();
    const target = pgTarget();
    await run(
      process.env.PG_RESTORE_BIN ?? "pg_restore",
      ["--clean", "--if-exists", "--no-owner", "--single-transaction", `--dbname=${target.url}`, file],
      target.env,
    );
    // A backup from an older version lacks the newest columns: bring it up to date.
    await migrateDb();
    return { safety };
  } finally {
    restoring = null;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let enabled = false;

/** (Re)arms the next scheduled backup from the saved settings. */
export function reschedule() {
  if (!enabled) return;
  clearTimeout(timer);
  void getBackupSettings().then((s) => {
    const at = nextRun(s, new Date());
    if (!at) return;
    // setTimeout caps at ~24.8 days; weekly fits.
    timer = setTimeout(() => {
      void runBackup()
        .catch((e: unknown) => console.warn(`[backup] ${String(e)}`))
        .finally(reschedule);
    }, at.getTime() - Date.now());
    timer.unref();
  });
}

/** The container runs the schedule (the dev server shares the database: never twice). */
export function startBackupScheduler() {
  enabled = true;
  reschedule();
  return () => {
    enabled = false;
    clearTimeout(timer);
  };
}
