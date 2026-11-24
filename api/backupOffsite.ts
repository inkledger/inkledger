// Off-site copies of each backup (Settings → Backup): after runBackup() writes a dump,
// it and an archive of the data folder (instance key, modules, downloads) go to an
// S3-compatible bucket, encrypted here with BACKUP_KEY first, or to a restic
// repository (restic encrypts with RESTIC_PASSWORD). Opt-in: nothing leaves the
// server until an admin picks a kind. Old copies are thinned daily/weekly/monthly.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "./lib/env";
import { getServerSetting, setServerSetting, updateServerSetting } from "./lib/serverSettings";
import { openFor, sealFor } from "./lib/crypto";
import { assertSafeUrl } from "./lib/security";
import { backupDir, isRestoring, BACKUP_FILE } from "./backup";
import { currentBackupKey, backupKeySet, decryptToFile, encryptFile, BackupKeyError } from "./backupCrypto";
import { s3Client, type S3Client, type S3Transport } from "./backupS3";
import { raiseAlert, resolveAlert } from "./ops/alerts";
import { t } from "@contracts/i18n";

export const OFFSITE_KINDS = ["none", "s3", "restic"] as const;
export const LOCK_MODES = ["GOVERNANCE", "COMPLIANCE"] as const;

export const offsiteSettingsSchema = z.object({
  kind: z.enum(OFFSITE_KINDS),
  /** "https://s3.eu-central-1.amazonaws.com", a MinIO address… (empty for restic) */
  endpoint: z.string().trim().max(500),
  bucket: z
    .string()
    .trim()
    .max(63)
    .regex(/^[a-z0-9.-]*$/),
  /** Folder in the bucket ("inkledger/"); letters, digits, . _ - / only, never "..". */
  prefix: z
    .string()
    .trim()
    .max(200)
    .regex(/^(?!.*\.\.)[A-Za-z0-9._\-/]*$/),
  region: z
    .string()
    .trim()
    .max(40)
    .regex(/^[a-z0-9-]*$/),
  accessKeyId: z.string().trim().max(200),
  keepDaily: z.number().int().min(1).max(365),
  keepWeekly: z.number().int().min(0).max(520),
  keepMonthly: z.number().int().min(0).max(240),
  /** Object Lock retention for each copy (the bucket must have Object Lock on); 0: none. */
  objectLockDays: z.number().int().min(0).max(3650),
  objectLockMode: z.enum(LOCK_MODES),
});
export type OffsiteSettings = z.infer<typeof offsiteSettingsSchema>;
/** What Settings shows: never the secret, only whether there is one. */
export type OffsiteView = OffsiteSettings & { hasSecret: boolean };
type Stored = OffsiteSettings & { secret: string };

export const DEFAULT_OFFSITE: OffsiteSettings = {
  kind: "none",
  endpoint: "",
  bucket: "",
  prefix: "inkledger/",
  region: "us-east-1",
  accessKeyId: "",
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 6,
  objectLockDays: 0,
  objectLockMode: "GOVERNANCE",
};

export type OffsiteState = {
  lastOkAt: number | null;
  /** The backup last copied */
  lastName: string | null;
  lastBytes: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
};
const EMPTY_STATE: OffsiteState = { lastOkAt: null, lastName: null, lastBytes: null, lastError: null, lastErrorAt: null };

const SETTINGS_KEY = "backup.offsite";
const STATE_KEY = "backup.offsiteState";
export const OFFSITE_SCOPE = "backup:offsite";

/** A request about off-site copies that can't be (settings incomplete, no such copy). */
export class OffsiteError extends Error {
  readonly kind: "invalid" | "notFound";
  constructor(kind: "invalid" | "notFound", message: string) {
    super(message);
    this.kind = kind;
  }
}

/** For the tests: an in-memory S3 instead of the guarded network. */
export const offsiteDeps: { transport: S3Transport | null; resolve?: (host: string) => Promise<string[]> } = { transport: null };

async function readStored(): Promise<Stored> {
  const raw = await getServerSetting<unknown>(SETTINGS_KEY, {});
  const saved = offsiteSettingsSchema.partial().safeParse(raw);
  const secret = raw && typeof raw === "object" && "secret" in raw && typeof raw.secret === "string" ? raw.secret : "";
  return { ...DEFAULT_OFFSITE, ...(saved.success ? saved.data : {}), secret };
}

const view = ({ secret, ...s }: Stored): OffsiteView => ({ ...s, hasSecret: secret !== "" });

export async function getOffsite(): Promise<OffsiteView> {
  return view(await readStored());
}

export async function getOffsiteState(): Promise<OffsiteState> {
  return { ...EMPTY_STATE, ...(await getServerSetting<Partial<OffsiteState>>(STATE_KEY, {})) };
}

/**
 * Saves the off-site settings. The secret is sealed for "backup:offsite"; left out, the
 * saved one stays (an empty string removes it). An S3 endpoint is checked like every
 * outbound address: http(s), no credentials in it, never loopback or link-local.
 */
export async function setOffsite(patch: Partial<OffsiteSettings> & { secret?: string }): Promise<OffsiteView> {
  const { secret, ...rest } = patch;
  const current = await readStored();
  const next: Stored = { ...current, ...offsiteSettingsSchema.partial().parse(rest), secret: secret === undefined ? current.secret : secret ? sealFor(secret, OFFSITE_SCOPE) : "" };
  if (next.kind === "s3") {
    if (!next.endpoint || !next.bucket || !next.accessKeyId || !next.secret) throw new OffsiteError("invalid", t("server.backup.offsiteIncomplete"));
    await assertSafeUrl(next.endpoint, { network: "private", ...(offsiteDeps.resolve ? { resolve: offsiteDeps.resolve } : {}) });
  }
  await updateServerSetting<unknown>(SETTINGS_KEY, {}, () => next);
  return view(next);
}

// ── Names and retention ────────────────────────────────────────────────────

const STEM = /^inkledger-(\d{4})(\d{2})(\d{2})-\d{6}$/;
const stemOf = (name: string) => name.replace(/\.dump$/, "");
const dumpObject = (prefix: string, name: string) => `${prefix}${name}.enc`;
const dataObject = (prefix: string, name: string) => `${prefix}${stemOf(name)}.data.tar.gz.enc`;
/** The data archive's name beside a dump ("inkledger-20261124-020000.data.tar.gz"). */
export const dataArchiveName = (name: string) => `${stemOf(name)}.data.tar.gz`;

/** ISO week of a local date, as "YYYY-Www". */
function isoWeek(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Which backups stay off-site: the newest of each of the last `keepDaily` days,
 * `keepWeekly` weeks and `keepMonthly` months that have one (as restic's
 * forget does); the newest backup always.
 */
export function toKeep(names: string[], keep: Pick<OffsiteSettings, "keepDaily" | "keepWeekly" | "keepMonthly">): Set<string> {
  const ours = names.filter((n) => BACKUP_FILE.test(n)).sort().reverse();
  const kept = new Set<string>(ours.slice(0, 1));
  const pick = (bucket: (y: number, m: number, d: number) => string, count: number) => {
    const seen = new Set<string>();
    for (const n of ours) {
      if (seen.size >= count) break;
      const [, y, m, d] = STEM.exec(stemOf(n))!.map(Number);
      const b = bucket(y, m, d);
      if (seen.has(b)) continue;
      seen.add(b);
      kept.add(n);
    }
  };
  pick((y, m, d) => `${y}-${m}-${d}`, keep.keepDaily);
  pick(isoWeek, keep.keepWeekly);
  pick((y, m) => `${y}-${m}`, keep.keepMonthly);
  return kept;
}

// ── The data folder ────────────────────────────────────────────────────────

/** /app/data in the image: the instance key, modules, downloads, the audit file copy. */
export function dataRoot(): string {
  return process.env.DATA_DIR || path.dirname(env.instanceKeyPath);
}

function run(bin: string, args: string[], opts: { cwd?: string; stdout?: string; okCodes?: number[] } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const out = opts.stdout ? fs.openSync(opts.stdout, "w", 0o600) : null;
    const p = spawn(bin, args, { stdio: ["ignore", out ?? "pipe", "pipe"], env: process.env, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    let text = "";
    let err = "";
    p.stdout?.on("data", (d) => (text += String(d)));
    p.stderr?.on("data", (d) => (err += String(d)));
    p.on("error", (e) => {
      if (out !== null) fs.closeSync(out);
      reject(e);
    });
    p.on("close", (code) => {
      if (out !== null) fs.closeSync(out);
      if (code !== null && (opts.okCodes ?? [0]).includes(code)) resolve(text);
      else reject(new Error((err.trim() || `${path.basename(bin)} exited with ${code ?? "?"}`).slice(0, 500)));
    });
  });
}

/** The data folder as a .tar.gz at `file` (the backups folder left out when it lies inside); null when there is none. */
export async function archiveData(file: string): Promise<string | null> {
  const root = dataRoot();
  if (!fs.existsSync(root)) return null;
  const args = ["-czf", file, "-C", root];
  const rel = path.relative(root, backupDir());
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) args.push(`--exclude=./${rel}`, `--exclude=${rel}`);
  fs.closeSync(fs.openSync(file, "w", 0o600));
  // GNU tar exits 1 when a file changed while it was read (the audit file copy is appended to
  // as the server runs): the archive is whole all the same, only that file is as it was then.
  await run(process.env.TAR_BIN ?? "tar", [...args, "."], { okCodes: [0, 1] });
  fs.chmodSync(file, 0o600);
  return file;
}

// ── S3 ─────────────────────────────────────────────────────────────────────

function clientOf(s: Stored): S3Client {
  let secretAccessKey: string;
  try {
    secretAccessKey = openFor(s.secret, OFFSITE_SCOPE);
  } catch {
    throw new Error(t("server.backup.offsiteSecretUnreadable"));
  }
  const cfg = { endpoint: s.endpoint, bucket: s.bucket, region: s.region || "us-east-1", accessKeyId: s.accessKeyId, secretAccessKey };
  return offsiteDeps.transport ? s3Client(cfg, offsiteDeps.transport) : s3Client(cfg);
}

async function uploadS3(s: Stored, name: string, dump: string, archive: () => Promise<string | null>): Promise<number> {
  if (!backupKeySet()) throw new BackupKeyError(t("server.backup.noBackupKey"));
  const key = currentBackupKey();
  const client = clientOf(s);
  const lock = s.objectLockDays > 0 ? { mode: s.objectLockMode, until: new Date(Date.now() + s.objectLockDays * 86_400_000) } : undefined;
  let bytes = 0;
  const send = async (src: string, object: string) => {
    const tmp = path.join(backupDir(), `.${path.basename(object)}.partial`);
    try {
      const digest = await encryptFile(src, tmp, key);
      await client.putFile(object, tmp, digest, lock);
      bytes += digest.size;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };
  // The dump first: an archive that fails never costs the database's copy.
  await send(dump, dumpObject(s.prefix, name));
  const data = await archive();
  if (data) await send(data, dataObject(s.prefix, name));
  // Thinned after the new copy is in: a failed upload never costs an old one.
  const objects = await client.list(s.prefix);
  const rel = (k: string) => k.slice(s.prefix.length);
  const dumps = objects.map((o) => rel(o.key)).filter((k) => /^inkledger-\d{8}-\d{6}\.dump\.enc$/.test(k)).map((k) => k.replace(/\.enc$/, ""));
  const kept = toKeep(dumps, s);
  for (const o of objects) {
    const k = rel(o.key);
    const m = /^(inkledger-\d{8}-\d{6})\.(dump|data\.tar\.gz)\.enc$/.exec(k);
    if (!m || kept.has(`${m[1]}.dump`)) continue;
    // Under Object Lock a delete only hides the copy until its retention ends: never an error.
    await client.remove(o.key).catch((e: unknown) => console.warn(`[backup] off-site ${k} not removed: ${String(e)}`));
  }
  return bytes;
}

// ── restic ─────────────────────────────────────────────────────────────────

const resticBin = () => process.env.RESTIC_BIN ?? "restic";
/** restic reads its repository and password from the environment (never from the database, never on its command line). */
export const resticConfigured = () => !!process.env.RESTIC_REPOSITORY && !!(process.env.RESTIC_PASSWORD || process.env.RESTIC_PASSWORD_FILE);
const stageDir = () => path.join(backupDir(), ".restic-stage");
const RESTIC_HOST = "inkledger";

async function uploadRestic(s: Stored, name: string, dump: string, archive: () => Promise<string | null>): Promise<number> {
  if (!resticConfigured()) throw new Error(t("server.backup.resticMissing"));
  const data = await archive();
  // One snapshot per backup, from a folder of a fixed path: retention groups them by it.
  const stage = stageDir();
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    const put = (src: string, as: string) => {
      try {
        fs.linkSync(src, path.join(stage, as));
      } catch {
        fs.copyFileSync(src, path.join(stage, as));
      }
    };
    put(dump, name);
    if (data) put(data, dataArchiveName(name));
    await run(resticBin(), ["backup", "--host", RESTIC_HOST, "--tag", "inkledger", "--tag", stemOf(name), stage]);
    const bytes = fs.statSync(dump).size + (data ? fs.statSync(data).size : 0);
    await run(resticBin(), [
      "forget",
      "--host",
      RESTIC_HOST,
      "--tag",
      "inkledger",
      "--group-by",
      "host,paths",
      "--keep-last",
      "1",
      "--keep-daily",
      String(s.keepDaily),
      "--keep-weekly",
      String(s.keepWeekly),
      "--keep-monthly",
      String(s.keepMonthly),
      "--prune",
    ]);
    return bytes;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

type Snapshot = { id: string; time: string; tags?: string[]; paths?: string[] };

async function resticSnapshots(): Promise<Snapshot[]> {
  const out = await run(resticBin(), ["snapshots", "--json", "--host", RESTIC_HOST, "--tag", "inkledger"]);
  const parsed: unknown = JSON.parse(out || "[]");
  return Array.isArray(parsed) ? (parsed as Snapshot[]).filter((s) => typeof s?.id === "string") : [];
}

// ── Upload after each backup ───────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();

/** Copies a backup off-site, after the ones queued before it (never two at once). */
export function queueOffsite(name: string): Promise<OffsiteState | null> {
  const next = chain.then(() => uploadOffsite(name));
  chain = next.catch(() => undefined);
  return next;
}

/**
 * Copies one local backup (and the data folder) off-site, then thins the old copies.
 * Records the outcome; a failure raises the "offsite" alert, a success clears it.
 * Nothing when off, on a read-only server (a test server on a copied database), or
 * while a restore replaces the database.
 */
export async function uploadOffsite(name: string): Promise<OffsiteState | null> {
  const s = await readStored();
  if (s.kind === "none") return null;
  if (env.readOnly) {
    console.warn("[backup] off-site copy skipped: read-only server");
    return null;
  }
  if (isRestoring()) return null;
  const dump = path.join(backupDir(), name);
  const data = path.join(backupDir(), `.${dataArchiveName(name)}.partial`);
  try {
    if (!BACKUP_FILE.test(name) || !fs.existsSync(dump)) throw new OffsiteError("notFound", t("server.backup.notFound"));
    const archive = () => archiveData(data);
    const bytes = s.kind === "s3" ? await uploadS3(s, name, dump, archive) : await uploadRestic(s, name, dump, archive);
    const state: OffsiteState = { ...(await getOffsiteState()), lastOkAt: Date.now(), lastName: name, lastBytes: bytes };
    await setServerSetting(STATE_KEY, state);
    await resolveAlert("offsite").catch(() => undefined);
    return state;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    console.warn(`[backup] off-site copy of ${name} failed: ${msg}`);
    const state: OffsiteState = { ...(await getOffsiteState()), lastError: msg, lastErrorAt: Date.now() };
    await setServerSetting(STATE_KEY, state);
    await raiseAlert({ key: "offsite", kind: "offsite", name: s.kind });
    return state;
  } finally {
    fs.rmSync(data, { force: true });
  }
}

// ── Listing and bringing a copy back ───────────────────────────────────────

export type OffsiteCopy = { name: string; at: number; size: number | null };

/** The copies off-site, newest first. */
export async function listOffsite(): Promise<OffsiteCopy[]> {
  const s = await readStored();
  if (s.kind === "s3") {
    const objects = await clientOf(s).list(s.prefix);
    return objects
      .map((o) => ({ o, k: o.key.slice(s.prefix.length) }))
      .filter(({ k }) => /^inkledger-\d{8}-\d{6}\.dump\.enc$/.test(k))
      .map(({ o, k }) => ({ name: k.replace(/\.enc$/, ""), at: o.lastModified, size: o.size }))
      .sort((a, b) => b.name.localeCompare(a.name));
  }
  if (s.kind === "restic") {
    if (!resticConfigured()) return [];
    return (await resticSnapshots())
      .flatMap((snap) => {
        const stem = snap.tags?.find((t) => STEM.test(t));
        return stem ? [{ name: `${stem}.dump`, at: Date.parse(snap.time) || 0, size: null }] : [];
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }
  return [];
}

/**
 * Brings an off-site copy back into the backups folder (decrypted, verified to the last
 * byte before it is there), with its data archive beside it when there is one. The
 * dump is then restored like any local one (restoreBackup: safety copy first).
 */
export async function fetchOffsite(name: string): Promise<{ name: string; data: string | null }> {
  if (!BACKUP_FILE.test(name)) throw new OffsiteError("invalid", t("server.backup.invalid"));
  const s = await readStored();
  const dir = backupDir();
  const target = path.join(dir, name);
  const dataTarget = path.join(dir, dataArchiveName(name));
  if (s.kind === "s3") {
    const client = clientOf(s);
    if (!fs.existsSync(target)) await decryptToFile(await client.get(dumpObject(s.prefix, name)), target);
    let data: string | null = null;
    try {
      if (!fs.existsSync(dataTarget)) await decryptToFile(await client.get(dataObject(s.prefix, name)), dataTarget);
      data = path.basename(dataTarget);
    } catch (e) {
      console.warn(`[backup] no data archive for ${name}: ${String(e)}`);
    }
    return { name, data };
  }
  if (s.kind === "restic") {
    if (!resticConfigured()) throw new OffsiteError("invalid", t("server.backup.resticMissing"));
    const snap = (await resticSnapshots()).find((x) => x.tags?.includes(stemOf(name)));
    const from = snap?.paths?.[0];
    if (!snap || !from) throw new OffsiteError("notFound", t("server.backup.offsiteNotFound", { name }));
    const pull = async (file: string, to: string) => {
      const tmp = `${to}.partial`;
      try {
        await run(resticBin(), ["dump", snap.id, `${from}/${file}`], { stdout: tmp });
        fs.renameSync(tmp, to);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    };
    if (!fs.existsSync(target)) await pull(name, target);
    let data: string | null = null;
    try {
      if (!fs.existsSync(dataTarget)) await pull(dataArchiveName(name), dataTarget);
      data = path.basename(dataTarget);
    } catch (e) {
      console.warn(`[backup] no data archive for ${name}: ${String(e)}`);
    }
    return { name, data };
  }
  throw new OffsiteError("invalid", t("server.backup.offsiteOff"));
}

/** The newest local backup, copied off-site again now (Settings → Backup). */
export async function uploadNewest(newest: string | undefined): Promise<OffsiteState | null> {
  if (!newest) throw new OffsiteError("notFound", t("server.backup.noBackupYet"));
  return queueOffsite(newest);
}

