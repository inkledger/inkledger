import { isIP } from "node:net";
import { SESSION_COOKIE } from "@contracts/types";

const REMEMBER_COOKIE = "ikl_remember";

/**
 * The request reached us over HTTPS (directly or through a TLS-terminating
 * proxy). Drives the cookie Secure flag: the Docker deployment serves plain
 * HTTP on 127.0.0.1, where a Secure cookie would never come back.
 */
function isHttpsRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  // Through the desktop app's LAN proxy (src-tauri lan.rs, :47843): TLS ended there and the
  // bytes come on as they are, so nothing says https but the port the browser used. A
  // client that writes that port only gets a Secure flag it didn't need.
  if (/:47843$/.test(req.headers.get("host") ?? "")) return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Session cookie name for this server. Browsers share cookies across the
 * ports of one host, so two servers on localhost:3000 and localhost:47823
 * (two profiles of the native app, two Jira) would log each other out: an
 * explicit port in Host goes into the name. Default ports keep the plain
 * name, as before.
 */
function sessionCookieName(req: Request): string {
  return portScoped(req, SESSION_COOKIE);
}

/** `base`, with the explicit port of the Host header appended (see above). */
function portScoped(req: Request, base: string): string {
  let host = req.headers.get("host");
  if (!host) {
    try {
      host = new URL(req.url).host;
    } catch {
      host = "";
    }
  }
  const port = /:(\d+)$/.exec(host)?.[1];
  return port ? `${base}_${port}` : base;
}

/**
 * The session cookie of a request, by this server's name only: on an explicit port the plain
 * name may come from another app on another port of the host (signed in as someone else).
 */
export function readSessionCookie(req: Request, cookies: Record<string, string>): string | undefined {
  return cookies[sessionCookieName(req)];
}

export function sessionCookie(req: Request, sessionId: string, maxAgeSeconds: number): string {
  return cookie(req, sessionCookieName(req), sessionId, maxAgeSeconds);
}

/**
 * The remembered-device cookie: lets this browser / app sign in again
 * without the Jira secret. Port-scoped like the session one, never shared
 * with the old plain name.
 */
function rememberCookieName(req: Request): string {
  return portScoped(req, REMEMBER_COOKIE);
}

export function rememberCookie(req: Request, token: string, maxAgeSeconds: number): string {
  return cookie(req, rememberCookieName(req), token, maxAgeSeconds);
}

export function readRememberCookie(req: Request, cookies: Record<string, string>): string | undefined {
  return cookies[rememberCookieName(req)];
}

function cookie(req: Request, name: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  // COOKIE_SECURE=1: behind a TLS proxy that doesn't send X-Forwarded-Proto.
  if (isHttpsRequest(req) || process.env.COOKIE_SECURE === "1") parts.push("Secure");
  return parts.join("; ");
}

/** Set-Cookie values that remove the session cookie (and the old plain one). */
export function clearedSessionCookies(req: Request): string[] {
  const current = sessionCookie(req, "deleted", 0);
  if (sessionCookieName(req) === SESSION_COOKIE) return [current];
  const plain = current.replace(`${sessionCookieName(req)}=`, `${SESSION_COOKIE}=`);
  return [current, plain];
}

/** An address written as one: no brackets, an IPv4-mapped IPv6 as its IPv4. */
const plainAddress = (raw: string) => raw.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");

/**
 * A proxy TRUST_PROXY=1 takes at its word: on this machine, or Docker's and home
 * networks (10/8, 172.16/12, 192.168/16). Not 100.64/10 nor fc00::/7: Tailscale
 * gives every device of the tailnet one of those, and a device is not a proxy.
 */
function localProxy(ip: string): boolean {
  if (ip === "::1") return true;
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * One address as a limiter key: IPv4 as itself (mapped ones too), a public IPv6
 * by its /64 (one subscriber holds a whole one, and picks any address in it).
 * Loopback, link-local and private IPv6 stay per host: they are the colleagues
 * on this network (Tailscale's too), who must not share one block.
 */
export function addressKey(raw: string): string {
  const ip = plainAddress(raw);
  if (isIP(ip) !== 6 || ip === "::1" || /^f[cd]|^fe[89ab]/.test(ip)) return ip;
  const [head, tail] = ip.split("::");
  const width = (part: string | undefined) => (part ? part.split(":").reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0) : 0);
  const groups = tail === undefined ? head.split(":") : [...(head ? head.split(":") : []), ...Array<string>(8 - width(head) - width(tail)).fill("0"), ...(tail ? tail.split(":") : [])];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/**
 * Client address for rate limiting: the socket address, unless a trusted proxy
 * stands in front (TRUST_PROXY). Then the client is the last X-Forwarded-For
 * entry that proxy added (the ones before it are whatever the client sent).
 * TRUST_PROXY=1 trusts a proxy on this machine or Docker's network (Tailscale
 * serve, Docker's gateway); a comma-separated list trusts those addresses only.
 * Never for a request this server took over TLS itself: no proxy stands in front
 * of it (and Docker's NAT makes its clients look local).
 */
export function clientIp(req: Request, remoteAddress?: string): string {
  const peer = plainAddress(remoteAddress ?? "");
  const trust = (process.env.TRUST_PROXY ?? "").trim();
  if (trust && trust !== "0" && !ownTls(req)) {
    const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((h) => plainAddress(h)).filter(Boolean);
    const listed = trust === "1" ? null : new Set(trust.split(",").map(plainAddress).filter(Boolean));
    const trusted = listed ? listed.has(peer) : localProxy(peer);
    if (hops.length > 0 && trusted) {
      let i = hops.length - 1;
      while (listed && i > 0 && listed.has(hops[i])) i--;
      return addressKey(hops[i]);
    }
  }
  return peer ? addressKey(peer) : "unknown";
}

function ownTls(req: Request): boolean {
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}
