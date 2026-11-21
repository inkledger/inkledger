import { isIP } from "node:net";
import { SESSION_COOKIE } from "@contracts/types";
import { isPrivateAddress } from "./security";

const REMEMBER_COOKIE = "ikl_remember";

/**
 * The request reached us over HTTPS (directly or through a TLS-terminating
 * proxy). Drives the cookie Secure flag: the Docker deployment serves plain
 * HTTP on 127.0.0.1, where a Secure cookie would never come back.
 */
function isHttpsRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
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

/** The session cookie of a request: this server's name, else the old plain one. */
export function readSessionCookie(req: Request, cookies: Record<string, string>): string | undefined {
  return cookies[sessionCookieName(req)] ?? cookies[SESSION_COOKIE];
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

/** The desktop app's LAN proxy (src-tauri lan.rs TLS_PORT): it copies the client's bytes, its headers too. */
const LAN_PROXY_PORT = "47843";

const loopback = (ip: string) => ip === "::1" || (isIP(ip) === 4 && ip.startsWith("127."));

/** One address as a limiter key: IPv4 as itself (mapped ones too), IPv6 by its /64 (one host holds a whole one). */
export function addressKey(raw: string): string {
  const ip = raw.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (isIP(ip) !== 6) return ip;
  const [head, tail] = ip.split("::");
  const width = (part: string | undefined) => (part ? part.split(":").reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0) : 0);
  const groups = tail === undefined ? head.split(":") : [...(head ? head.split(":") : []), ...Array<string>(8 - width(head) - width(tail)).fill("0"), ...(tail ? tail.split(":") : [])];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/**
 * Client address for rate limiting: the socket address, unless a trusted proxy
 * stands in front (TRUST_PROXY). Then the client is the last X-Forwarded-For
 * entry that proxy added (the ones before it are whatever the client sent).
 * TRUST_PROXY=1 trusts a proxy on this machine or the private network (Tailscale
 * serve, Docker's gateway); a comma-separated list trusts those addresses only.
 * Never for a request this server took over TLS itself (no proxy in front of it,
 * and Docker's NAT makes its clients look private) or through the LAN proxy.
 */
export function clientIp(req: Request, remoteAddress?: string): string {
  const peer = addressKey(remoteAddress ?? "");
  const trust = (process.env.TRUST_PROXY ?? "").trim();
  if (trust && trust !== "0" && !ownTlsOrLanProxy(req)) {
    const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    const listed = trust === "1" ? null : new Set(trust.split(",").map((a) => addressKey(a)).filter(Boolean));
    const raw = (remoteAddress ?? "").trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
    const trusted = listed ? listed.has(peer) : loopback(raw) || isPrivateAddress(raw);
    if (hops.length > 0 && trusted) {
      let i = hops.length - 1;
      while (listed && i > 0 && listed.has(addressKey(hops[i]))) i--;
      return addressKey(hops[i]);
    }
  }
  return peer || "unknown";
}

function ownTlsOrLanProxy(req: Request): boolean {
  try {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? url.host;
    return url.protocol === "https:" || /:(\d+)$/.exec(host)?.[1] === LAN_PROXY_PORT;
  } catch {
    return false;
  }
}
