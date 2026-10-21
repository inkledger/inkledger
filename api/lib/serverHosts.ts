import { z } from "zod";
import { serverHosts } from "@db/schema";
import { getDb } from "../queries/connection";
import { env } from "./env";
import { getServerSetting, setServerSetting } from "./serverSettings";
import { t } from "@contracts/i18n";

/**
 * A name a phone on the Wi-Fi uses for this Mac: a Bonjour ".local" name or a
 * private IPv4 address. Never a public name: those come from the access settings.
 */
export const lanHostInput = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (h) =>
      /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/.test(h) ||
      /^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/.test(h),
    { error: () => t("server.hosts.lanOnly") },
  );

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/** The Mac's name in a tailnet: "my-mac.tail1234.ts.net". */
export const tailscaleHostInput = z
  .string()
  .trim()
  .toLowerCase()
  .transform((h) => h.replace(/\.$/, ""))
  .refine((h) => new RegExp(`^${LABEL}\\.${LABEL}\\.ts\\.net$`).test(h), { error: () => t("server.hosts.tailscaleInvalid") });

/** A name on the user's own DNS pointing at this Mac ("ikl.casa", "ikl.ufficio.lan"). */
export const dnsHostInput = z
  .string()
  .trim()
  .toLowerCase()
  .transform((h) => h.replace(/\.$/, ""))
  .refine((h) => new RegExp(`^(${LABEL}\\.)+[a-z][a-z0-9-]{1,62}$`).test(h) && !h.endsWith(".ts.net"), { error: () => t("server.hosts.networkNameInvalid") });

/** How other devices reach this server (set from the app, Settings → Dispositivi). */
export type Access = {
  tailscaleHost: string | null;
  /** The https port Tailscale publishes this server on (same as its local port). */
  tailscalePort: number | null;
  customHosts: string[];
};
const ACCESS_KEY = "access";
const NO_ACCESS: Access = { tailscaleHost: null, tailscalePort: null, customHosts: [] };

let lanCache: string[] | null = null;
let accessCache: Access | null = null;

/** LAN names added at runtime by the desktop app's local sharing. */
export async function extraHosts(): Promise<string[]> {
  lanCache ??= (await getDb().select({ host: serverHosts.host }).from(serverHosts)).map((r) => r.host);
  return lanCache;
}

export async function addHosts(hosts: string[]) {
  const db = getDb();
  for (const host of hosts) await db.insert(serverHosts).values({ host }).onConflictDoNothing();
  lanCache = null;
}

export async function getAccess(): Promise<Access> {
  accessCache ??= { ...NO_ACCESS, ...(await getServerSetting<Partial<Access>>(ACCESS_KEY, {})) };
  return accessCache;
}

export async function setAccess(patch: Partial<Access>): Promise<Access> {
  const next = { ...(await getAccess()), ...patch };
  next.customHosts = [...new Set(next.customHosts)].sort();
  await setServerSetting(ACCESS_KEY, next);
  accessCache = null;
  return getAccess();
}

/** Tailscale names: from ALLOWED_HOSTS and from the app's settings. */
export async function tailnetHosts(): Promise<string[]> {
  const set = new Set(env.allowedHosts.filter((h) => h.endsWith(".ts.net")));
  const t = (await getAccess()).tailscaleHost;
  if (t) set.add(t);
  return [...set];
}

/**
 * Where a phone opens this server on the tailnet: "https://<name>[:port]".
 * The name set from the app carries its port; names from ALLOWED_HOSTS are
 * on the default one.
 */
export async function tailnetOrigins(): Promise<string[]> {
  const a = await getAccess();
  const withPort = (host: string, port: number | null) =>
    `https://${host}${port && port !== 443 ? `:${port}` : ""}`;
  return (await tailnetHosts()).map((h) =>
    withPort(h, h === a.tailscaleHost ? a.tailscalePort : null),
  );
}

/** Hosts the server answers to now: ALLOWED_HOSTS plus the runtime ones ([] = any). */
export async function allowedHostsNow(): Promise<string[]> {
  if (env.allowedHosts.length === 0) return [];
  const a = await getAccess();
  return [...env.allowedHosts, ...(await extraHosts()), ...(a.tailscaleHost ? [a.tailscaleHost] : []), ...a.customHosts];
}

/** For tests that reset the database. */
export function resetServerHostsCache() {
  lanCache = null;
  accessCache = null;
}
