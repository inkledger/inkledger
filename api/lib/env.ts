// Loads .env, then pins TZ before anything creates a Date.
import "./tz";
import path from "node:path";

const DEV_SECRET = "ikl-dev-secret-change-me";
const isProduction = process.env.NODE_ENV === "production";

function resolveSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret !== DEV_SECRET && secret !== "change-me-with-a-random-string") {
    return secret;
  }
  if (isProduction) {
    throw new Error(
      "SESSION_SECRET must be set to a random value in production (e.g. `openssl rand -hex 32`).",
    );
  }
  return DEV_SECRET;
}

/** Positive finite number from the environment, else `fallback`. */
export function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** Lower-cased host names (no port); empty list = any host. */
export function parseAllowedHosts(raw: string | undefined, production: boolean): string[] {
  if (raw === undefined || raw.trim() === "") return production ? LOOPBACK_HOSTS : [];
  if (raw.trim() === "*") return [];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** The inkledger OAuth App on GitHub (public: device flow needs no secret). */
const GITHUB_CLIENT_ID = "Ov23liv6ivYsJX6Cqoh8";
const DEFAULT_STORE_URL = "https://inkledger-store.lorenzomusche.workers.dev";

/** An http(s) origin without trailing slash, or null for "off" / unusable values. */
export function storeUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v || v === "off") return null;
  try {
    const u = new URL(v);
    return /^https?:$/.test(u.protocol) ? u.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

export const env = {
  isProduction,
  serveBuild: !isProduction && process.env.SERVE_BUILD === "1",
  /** HTTP port for the production server */
  port: Number(process.env.PORT || 3000),
  /** SQLite file path, or ":memory:" for tests */
  databaseUrl: process.env.DATABASE_URL || "postgres://inkledger:inkledger@127.0.0.1:54329/inkledger",
  /** Secret used to encrypt Jira API tokens at rest and sign nothing else */
  sessionSecret: resolveSessionSecret(),
  /**
   * The key tracker credentials are sealed with (64 hex chars, or any
   * passphrase); unset, it is derived from SESSION_SECRET. The _OLD one still
   * opens what it sealed, and the next start seals it again with the new one.
   */
  credentialsKey: process.env.CREDENTIALS_KEY?.trim() || null,
  credentialsKeyOld: process.env.CREDENTIALS_KEY_OLD?.trim() || null,
  /** Self-hosted tracker hosts accepted (REMOTE_ALLOWED_HOSTS; JIRA_ALLOWED_HOSTS still read); empty = any. Services on the internet are never limited by it. */
  remoteAllowedHosts: (process.env.REMOTE_ALLOWED_HOSTS ?? process.env.JIRA_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  /** Minutes between background Jira syncs (0 disables) */
  syncIntervalMin: Math.max(0, Number(process.env.SYNC_INTERVAL_MIN ?? 5) || 0),
  /**
   * Refuse every call that may change something on a tracker (test servers on
   * a copied DB). PROVIDERS_READ_ONLY, or its older name JIRA_READ_ONLY.
   */
  readOnly: [process.env.PROVIDERS_READ_ONLY, process.env.JIRA_READ_ONLY].some((v) =>
    ["1", "true", "yes"].includes((v ?? "").trim().toLowerCase()),
  ),
  /**
   * Host names the server answers to (DNS-rebinding guard). ALLOWED_HOSTS
   * overrides; "*" disables. Production defaults to loopback only.
   */
  allowedHosts: parseAllowedHosts(process.env.ALLOWED_HOSTS, isProduction),
  /** Published app builds for new devices (APK + manifest.json) */
  downloadsDir:
    process.env.DOWNLOADS_DIR ||
    path.join(path.dirname(process.env.DATABASE_URL || "./data/app.db"), "downloads"),
  /** Installed add-on modules (signed folders); /app/data/modules in Docker */
  modulesDir: process.env.MODULES_DIR || path.resolve("data/modules"),
  /** This server's own Ed25519 key (WP-19: licences are activated per instance); made once, never in the database. */
  instanceKeyPath: process.env.INSTANCE_KEY_PATH || path.resolve("data/instance.key"),
  /**
   * The module store Worker (catalog, licence requests, checkout); "off"
   * disables Settings → Store. Off under the unit tests: they never reach it.
   */
  storeUrl: storeUrl(process.env.STORE_URL ?? (process.env.VITEST ? "off" : DEFAULT_STORE_URL)),
  /** Real weather for add-on modules (Open-Meteo, server-side). "off" turns it off. */
  weather: (process.env.WEATHER ?? (process.env.VITEST ? "off" : "on")).trim() !== "off",
  /**
   * Lets a non-production process apply migrations to a database a production
   * server has marked as its own (normally refused: dev uses its own database).
   */
  allowMigrateProductionDb: ["1", "true", "yes"].includes(
    (process.env.ALLOW_MIGRATE_PRODUCTION_DB ?? "").trim().toLowerCase(),
  ),
  /**
   * The first admin's password on a new server (INKLEDGER_ADMIN_PASSWORD): it must be
   * changed at the first sign-in either way. Unset, production makes a random one
   * (ensureAdmin), anything else uses "admin".
   */
  adminPassword: process.env.INKLEDGER_ADMIN_PASSWORD || null,
  /**
   * The GitHub OAuth App users sign in to GitHub with (device flow): the
   * inkledger app on the inkledger organisation. A client id is public, not
   * a secret; GITHUB_CLIENT_ID points a server at its own app instead.
   */
  githubClientId: (process.env.GITHUB_CLIENT_ID ?? "").trim() || GITHUB_CLIENT_ID,
  /**
   * The Microsoft Entra app users sign in to their mailbox with (device code,
   * Mail.Read): registered by whoever runs the server (docs/outlook.md). Unset,
   * the mailbox search is off; pasting, dropping and the add-in still work.
   */
  microsoftClientId: (process.env.MS_CLIENT_ID ?? "").trim() || null,
  /** The tenant to sign in on: its id or domain, or "organizations" (any work account). */
  microsoftTenant: (process.env.MS_TENANT ?? "").trim() || "organizations",
  /** Tests only: an in-memory Microsoft (api/mail/simulator.ts) instead of the real one. */
  mailSimulator: process.env.MAIL_SIMULATOR === "1",
  /** Session lifetime in days */
  sessionDays: positiveNumber(process.env.SESSION_DAYS, 30),
};
