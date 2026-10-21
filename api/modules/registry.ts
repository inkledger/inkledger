import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BUNDLE_MAX_BYTES,
  HOST_API_VERSION,
  LICENSE_CONTEXT,
  LICENSE_VERSION,
  MANIFEST_FILE,
  MODULES_PATH,
  PACKAGE_CONTEXT,
  SIGNATURE_FILE,
  licensePayloadSchema,
  moduleIdSchema,
  moduleManifestSchema,
  type LicensePayload,
  type ModuleListEntry,
  type ModuleManifest,
  type ModuleStatus,
} from "@contracts/modules";
import { canonicalJSON } from "../vendor/seal/canonical.ts";
import { verifyEnvelope } from "../vendor/seal/envelope.ts";
import { pathInside, sha256hex, verifyPackage } from "../vendor/seal/package.ts";
import { env } from "../lib/env";
import { getServerSetting, setServerSetting } from "../lib/serverSettings";
import { asPem, extraKey, LICENSE_ISSUERS, licenseKeys, packageKeys, type LicenseIssuer } from "./keys";
import { activationStates } from "./activation";

/**
 * Installed modules: one signed folder each under env.modulesDir. Everything is
 * verified again on every call (signature, hashes, licence), from bytes read
 * once: what is served is exactly what was hashed. Nothing throws from here;
 * a module that fails any check is reported and never served.
 */

const RESERVED = [MANIFEST_FILE, SIGNATURE_FILE];
const LICENSES_KEY = "modules.licenses";

type Files = Map<string, Buffer>;

/** Every file under `dir` by "/" path; a link or special file lands as "../name" (refused later). */
function readTree(dir: string): Files {
  const out: Files = new Map();
  const walk = (rel: string) => {
    for (const name of fs.readdirSync(rel ? path.join(dir, rel) : dir)) {
      const p = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(path.join(dir, p));
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.set(p, fs.readFileSync(path.join(dir, p)));
      else out.set(`../${p}`, Buffer.alloc(0));
    }
  };
  if (!fs.lstatSync(dir).isDirectory()) return new Map([["..", Buffer.alloc(0)]]);
  walk("");
  return out;
}

export type CheckedPackage =
  | { ok: true; manifest: ModuleManifest; files: Files; packageHash: string }
  | { ok: false; reason: string; id?: string; manifest?: ModuleManifest };

/** The full check of a package given as bytes (installed folder or upload). */
export function checkPackage(files: Files, signature: string): CheckedPackage {
  const rawManifest = files.get(MANIFEST_FILE);
  if (!rawManifest) return { ok: false, reason: "manifest-missing" };
  let json: unknown;
  try {
    json = JSON.parse(rawManifest.toString("utf8"));
  } catch {
    return { ok: false, reason: "manifest-unreadable" };
  }
  const parsed = moduleManifestSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "manifest-invalid" };
  const manifest = parsed.data;
  if (manifest.product !== `inkledger.${manifest.id}`) return { ok: false, reason: "manifest-invalid", manifest };
  if (!Object.hasOwn(manifest.files, manifest.entry)) return { ok: false, reason: "entry-undeclared", manifest };
  const computed = Object.fromEntries([...files].map(([p, b]) => [p, sha256hex(b)]));
  const r = verifyPackage({
    manifest: json,
    declared: manifest.files,
    signature,
    computed,
    context: PACKAGE_CONTEXT,
    keys: packageKeys(),
    reserved: RESERVED,
  });
  if (!r.ok) return { ok: false, reason: r.reason, manifest };
  return { ok: true, manifest, files, packageHash: sha256hex(Buffer.from(canonicalJSON(json))).slice(0, 32) };
}

function readInstalled(id: string): CheckedPackage {
  const dir = path.join(env.modulesDir, id);
  try {
    const files = readTree(dir);
    const signature = files.get(SIGNATURE_FILE)?.toString("utf8").trim() ?? "";
    const checked = checkPackage(files, signature);
    if (checked.ok && checked.manifest.id !== id) return { ok: false, reason: "id-mismatch", manifest: checked.manifest };
    return checked;
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

function installedIds(): string[] {
  try {
    return fs
      .readdirSync(env.modulesDir)
      .filter((d) => moduleIdSchema.safeParse(d).success)
      .sort();
  } catch {
    return [];
  }
}

// ---- Licences ----

export type LicenseCheck =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: "malformed" | "no-key" | "bad-signature" | "future-version" };

export function verifyLicense(text: string): LicenseCheck {
  const env_ = verifyEnvelope(text, { context: LICENSE_CONTEXT, keys: licenseKeys() });
  if (!env_.ok) return { ok: false, reason: env_.reason };
  let json: unknown;
  try {
    json = JSON.parse(env_.payload.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = licensePayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (parsed.data.v > LICENSE_VERSION) return { ok: false, reason: "future-version" };
  return { ok: true, payload: parsed.data };
}

/** Which key signed a valid licence: where it came from (beta, store, request). */
export function licenseIssuer(text: string): LicenseIssuer | null {
  for (const [name, key] of Object.entries(LICENSE_ISSUERS)) {
    if (verifyEnvelope(text, { context: LICENSE_CONTEXT, keys: [asPem(key)] }).ok) return name as LicenseIssuer;
  }
  const extra = extraKey();
  return extra && verifyEnvelope(text, { context: LICENSE_CONTEXT, keys: [extra] }).ok ? "dev" : null;
}

/** Stored licence texts (server-wide: every user of this server shares them). */
export const storedLicenses = () => getServerSetting<string[]>(LICENSES_KEY, []);
export const saveLicenses = (texts: string[]) => setServerSetting(LICENSES_KEY, texts);

/**
 * Verifies and stores a licence (one per licence id: a newer copy replaces the
 * old one). Used by Settings → Extras and by the store.
 */
export async function addLicense(text: string): Promise<LicenseCheck> {
  const l = verifyLicense(text);
  if (!l.ok) return l;
  const others = (await storedLicenses()).filter((x) => {
    const v = verifyLicense(x);
    return !v.ok || v.payload.id !== l.payload.id;
  });
  await saveLicenses([...others, text]);
  return l;
}

/** Valid stored licences, with their text. */
export async function validLicenses(): Promise<{ id: string; product: string; text: string }[]> {
  return (await storedLicenses()).flatMap((text) => {
    const l = verifyLicense(text);
    return l.ok ? [{ id: l.payload.id, product: l.payload.product, text }] : [];
  });
}

/** The products held by a valid licence, and those of them active on this server (WP-19). */
export async function licenseStates(): Promise<{ licensed: Set<string>; active: Set<string> }> {
  const valid = await validLicenses();
  const states = await activationStates(valid);
  return {
    licensed: new Set(valid.map((l) => l.product)),
    active: new Set(valid.filter((l) => states.get(l.id)?.state !== "missing").map((l) => l.product)),
  };
}

/** The products unlocked here: a valid licence, active on this server. */
export async function licensedProducts(): Promise<Set<string>> {
  return (await licenseStates()).active;
}

// ---- The list the page sees ----

function statusOf(checked: CheckedPackage, products: Set<string>, licensed?: Set<string>): ModuleStatus {
  if (!checked.ok) return { state: "invalid", reason: checked.reason };
  const { min, max } = checked.manifest.hostApi;
  if (HOST_API_VERSION < min || HOST_API_VERSION > max) return { state: "unsupported-host-api" };
  if (!products.has(checked.manifest.product)) return licensed?.has(checked.manifest.product) ? { state: "needs-activation" } : { state: "needs-license" };
  return { state: "active" };
}

const integrityOf = (b: Buffer) => `sha256-${createHash("sha256").update(b).digest("base64")}`;

export async function listModules(): Promise<ModuleListEntry[]> {
  const { active: products, licensed } = await licenseStates();
  return installedIds().map((id) => {
    const checked = readInstalled(id);
    const status = statusOf(checked, products, licensed);
    const m = checked.manifest;
    const active = checked.ok && status.state === "active";
    return {
      id,
      version: m?.version ?? "?",
      product: m?.product ?? "",
      name: m?.name ?? { en: id, it: id },
      slots: m?.slots ?? [],
      status,
      entryUrl: active ? `${MODULES_PATH}/${id}/${checked.packageHash}/${checked.manifest.entry}` : null,
      integrity: active ? integrityOf(checked.files.get(checked.manifest.entry) ?? Buffer.alloc(0)) : null,
    };
  });
}

/** Whether a module is installed, verified and licensed (gate for its storage). */
export async function isActive(id: string): Promise<boolean> {
  if (!moduleIdSchema.safeParse(id).success) return false;
  return statusOf(readInstalled(id), await licensedProducts()).state === "active";
}

/**
 * A file of an active module at its current package hash, or null. Only
 * declared .js/.mjs files: a module is code, its assets are inlined.
 */
export async function moduleFile(id: string, hash: string, file: string): Promise<Buffer | null> {
  if (!moduleIdSchema.safeParse(id).success || !/\.m?js$/.test(file) || !pathInside(file, RESERVED)) return null;
  const checked = readInstalled(id);
  if (!checked.ok || checked.packageHash !== hash) return null;
  if (statusOf(checked, await licensedProducts()).state !== "active") return null;
  if (!Object.hasOwn(checked.manifest.files, file)) return null;
  return checked.files.get(file) ?? null;
}

// ---- Install / uninstall ----

export type InstallResult =
  | { ok: true; id: string; version: string }
  | { ok: false; reason: string };

const semver = (v: string) => v.split(".").map(Number);
/** Whether semver `a` is older than `b`. */
export const older = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};

/**
 * Installs an uploaded bundle (seal pack): verified in memory first, then
 * written beside the modules and renamed into place, so a half-written module
 * never exists. An older version than the installed one is refused.
 */
export function installBundle(body: string, opts: { allowDowngrade?: boolean } = {}): InstallResult {
  if (Buffer.byteLength(body) > BUNDLE_MAX_BYTES) return { ok: false, reason: "too-large" };
  let bundle: unknown;
  try {
    bundle = JSON.parse(body);
  } catch {
    return { ok: false, reason: "bundle-unreadable" };
  }
  if (typeof bundle !== "object" || bundle === null) return { ok: false, reason: "bundle-unreadable" };
  const { format, manifest, signature, files } = bundle as Record<string, unknown>;
  if (format !== "seal-bundle-v1" || typeof signature !== "string" || typeof files !== "object" || files === null) {
    return { ok: false, reason: "bundle-unreadable" };
  }
  const tree: Files = new Map();
  for (const [p, b64] of Object.entries(files as Record<string, unknown>)) {
    if (typeof b64 !== "string" || !pathInside(p, RESERVED)) return { ok: false, reason: "outside" };
    tree.set(p, Buffer.from(b64, "base64"));
  }
  tree.set(MANIFEST_FILE, Buffer.from(JSON.stringify(manifest)));
  const checked = checkPackage(tree, signature);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const { id, version } = checked.manifest;
  const current = readInstalled(id);
  if (current.ok && older(version, current.manifest.version) && !opts.allowDowngrade) {
    return { ok: false, reason: "older-version" };
  }
  fs.mkdirSync(env.modulesDir, { recursive: true });
  const tmp = path.join(env.modulesDir, `.tmp-${randomBytes(6).toString("hex")}`);
  const old = path.join(env.modulesDir, `.old-${randomBytes(6).toString("hex")}`);
  const target = path.join(env.modulesDir, id);
  try {
    for (const [p, b] of tree) {
      fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true });
      fs.writeFileSync(path.join(tmp, p), b);
    }
    fs.writeFileSync(path.join(tmp, SIGNATURE_FILE), `${signature}\n`);
    const hadOne = fs.existsSync(target);
    if (hadOne) fs.renameSync(target, old);
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      // Put the installed version back.
      if (hadOne) fs.renameSync(old, target);
      throw e;
    }
    return { ok: true, id, version };
  } catch {
    return { ok: false, reason: "write-failed" };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
  }
}

export function uninstall(id: string): boolean {
  if (!moduleIdSchema.safeParse(id).success) return false;
  const target = path.join(env.modulesDir, id);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}
