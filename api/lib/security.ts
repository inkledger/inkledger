import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { sha256Hex } from "./hash";
import { t } from "@contracts/i18n";

/** Hash stored in the DB instead of the raw session id (cookie value). */
export function hashSessionId(sessionId: string): string {
  return sha256Hex(sessionId);
}

/**
 * Where a tracker may live: "public" for a service on the internet
 * (GitHub, Jira Cloud), "private" for a self-hosted one (Jira Server on the
 * company network), which may resolve to a private address.
 */
export type Network = "public" | "private";

/** Private and shared ranges (RFC 1918, CGNAT/tailnets, IPv6 ULA): only self-hosted trackers live there. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    // 198.18.0.0/15: the benchmark range, never a service on the internet.
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return v === 6 && (lower.startsWith("fc") || lower.startsWith("fd"));
}

/** An IPv6 address as its eight 16-bit groups (a dotted IPv4 tail as the last two); null when it isn't one. */
function ipv6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const tail = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) {
    const [a, b, c, d] = tail.slice(2).map(Number);
    s = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = s.split("::");
  const part = (p: string | undefined) => (p ? p.split(":").map((g) => parseInt(g, 16)) : []);
  const h = part(head);
  const r = part(rest);
  return rest === undefined ? h : [...h, ...Array<number>(8 - h.length - r.length).fill(0), ...r];
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Addresses a tracker must never resolve to: loopback, unspecified,
 * link-local (incl. cloud metadata 169.254.169.254), IETF protocol
 * assignments and multicast; for a service on the internet, private ranges
 * too. An IPv6 address that carries an IPv4 one (mapped, compatible, NAT64,
 * 6to4) is judged by the IPv4 address it reaches.
 */
export function isForbiddenAddress(ip: string, network: Network = "private"): boolean {
  const v = isIP(ip);
  if (network === "public" && v !== 0 && isPrivateAddress(ip)) return true;
  if (v === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return a === 0 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 0 && c === 0) || a >= 224;
  }
  const g = ipv6Groups(ip);
  if (g) {
    // ::a.b.c.d (compatible, incl. :: and ::1) and ::ffff:a.b.c.d (mapped).
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return isForbiddenAddress(v4Of(g[6], g[7]), network);
    // NAT64: 64:ff9b::/96 and the local-use 64:ff9b:1::/48, the IPv4 address in the last 32 bits.
    if (g[0] === 0x64 && g[1] === 0xff9b) return isForbiddenAddress(v4Of(g[6], g[7]), network);
    // 6to4: 2002:AABB:CCDD::/48.
    if (g[0] === 0x2002) return isForbiddenAddress(v4Of(g[1], g[2]), network);
    // fe80::/10 link-local, fec0::/10 site-local; ff00::/8 multicast.
    return (g[0] & 0xff80) === 0xfe80 || g[0] >> 8 === 0xff;
  }
  return true;
}

/** The server's own neighbours, never a tracker: localhost and the compose services. */
const RESERVED_HOSTS = new Set(["localhost", "db", "inkledger", "inkledger-db", "postgres"]);

/** A host name that only reaches the server itself or its containers. */
export function isReservedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return RESERVED_HOSTS.has(h) || h.endsWith(".localhost");
}

export class UnsafeUrlError extends Error {}

/**
 * Validate a user-supplied tracker URL before the server calls it.
 * `allowedHosts` (REMOTE_ALLOWED_HOSTS) restricts self-hosted hosts when non-empty.
 */
export async function assertSafeUrl(
  raw: string,
  opts: { allowedHosts?: string[]; network?: Network; resolve?: (host: string) => Promise<string[]> } = {},
): Promise<void> {
  const { allowedHosts = [], network = "private", resolve = async (host: string) => (await lookup(host, { all: true })).map((r) => r.address) } = opts;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(t("server.url.invalid"));
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError(t("server.url.httpOnly"));
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError(t("server.url.noCredentials"));
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isReservedHost(host) || (allowedHosts.length > 0 && !allowedHosts.includes(host))) {
    throw new UnsafeUrlError(t("server.url.hostNotAllowed", { host }));
  }
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new UnsafeUrlError(t("server.url.cannotResolve", { host }));
  }
  if (addresses.length === 0 || addresses.some((a) => isForbiddenAddress(a, network))) {
    throw new UnsafeUrlError(t("server.url.hostNotAllowed", { host }));
  }
}

/** Jira's sign-in URL check (self-hosted allowed: Jira Server lives on private networks). */
export async function assertSafeJiraUrl(
  raw: string,
  allowedHosts: string[],
  resolve?: (host: string) => Promise<string[]>,
): Promise<void> {
  return assertSafeUrl(raw, { allowedHosts, network: "private", ...(resolve ? { resolve } : {}) });
}

/**
 * Fixed-window in-memory rate limiter (single-process deployment), holding at
 * most `maxKeys` keys. Entries sit about in the order their windows end: a new
 * key drops expired ones from the front, then the oldest while still full, but
 * moves a blocked one behind instead (so a flood of new keys can't clear a block;
 * that order then bends a little, and an expired entry may wait further back).
 * Only when every entry is blocked does the oldest go anyway: memory and work
 * stay bounded however many keys come.
 */
export function createRateLimiter(limit: number, windowMs: number, o: { maxKeys?: number } = {}) {
  const maxKeys = o.maxKeys ?? 10_000;
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Returns seconds to wait when blocked, 0 when the hit is allowed. */
    hit(key: string, now = Date.now()): number {
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        // Behind the others: its window begins now.
        hits.delete(key);
        // Room: expired entries first, then the oldest, but never one still blocked
        // (a flood of new keys must not clear a key's block: an account's or an address's).
        let looked = hits.size;
        for (const [k, v] of hits) {
          if (v.resetAt > now && hits.size < maxKeys) break;
          if (looked-- <= 0) break;
          hits.delete(k);
          if (v.resetAt > now && v.count > limit) hits.set(k, v);
        }
        // Only blocked ones left and still full: the oldest goes all the same (memory stays bounded).
        if (hits.size >= maxKeys) {
          const oldest = hits.keys().next().value;
          if (oldest !== undefined) hits.delete(oldest);
        }
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return 0;
      }
      entry.count++;
      return entry.count > limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
    },
    reset(key: string) {
      hits.delete(key);
    },
    /** Keys held now. */
    size: () => hits.size,
  };
}

/**
 * DNS-rebinding guard: the Host header's name (port ignored) must be in
 * `allowed`; an empty list allows any host.
 */
export function isAllowedHost(hostHeader: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!hostHeader) return false;
  let name: string;
  try {
    name = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  return allowed.includes(name.replace(/^\[|\]$/g, "").toLowerCase());
}
