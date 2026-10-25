import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { t } from "@contracts/i18n";

/** Hash stored in the DB instead of the raw session id (cookie value). */
export function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

/**
 * Where a tracker may live: "public" for a service on the internet
 * (GitHub, Jira Cloud), "private" for a self-hosted one (Jira Server on the
 * company network), which may resolve to a private address.
 */
export type Network = "public" | "private";

/** Private and shared ranges (RFC 1918, CGNAT/tailnets, IPv6 ULA): only self-hosted trackers live there. */
function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return v === 6 && (lower.startsWith("fc") || lower.startsWith("fd"));
}

/**
 * Addresses a tracker must never resolve to: loopback, unspecified,
 * link-local (incl. cloud metadata 169.254.169.254) and multicast; for a
 * service on the internet, private ranges too.
 */
export function isForbiddenAddress(ip: string, network: Network = "private"): boolean {
  const v = isIP(ip);
  if (network === "public" && v !== 0 && isPrivateAddress(ip)) return true;
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower.startsWith("::ffff:")) return isForbiddenAddress(lower.slice(7), network);
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb") ||
      lower.startsWith("ff")
    );
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
 * most `maxKeys` keys: every window has the same length, so entries kept in
 * the order their windows began are also in the order they end. A new key
 * drops the expired ones from the front (only those), then the oldest while
 * the limiter is still full: memory and work stay bounded however many keys come.
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
        for (const [k, v] of hits) {
          if (v.resetAt > now && hits.size < maxKeys) break;
          hits.delete(k);
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
