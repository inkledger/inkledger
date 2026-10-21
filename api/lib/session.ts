import { SESSION_COOKIE } from "@contracts/types";

const REMEMBER_COOKIE = "ikl_remember";

/**
 * The request reached us over HTTPS (directly or through a TLS-terminating
 * proxy). Drives the cookie Secure flag: the Docker deployment serves plain
 * HTTP on 127.0.0.1, where a Secure cookie would never come back.
 */
export function isHttpsRequest(req: Request): boolean {
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
export function sessionCookieName(req: Request): string {
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
export function rememberCookieName(req: Request): string {
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

/**
 * Client address for rate limiting: the socket address. X-Forwarded-For is
 * spoofable, so it is used only behind a trusted proxy (TRUST_PROXY=1).
 */
export function clientIp(req: Request, remoteAddress?: string): string {
  if (process.env.TRUST_PROXY === "1") {
    const first = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (first) return first;
  }
  return remoteAddress || "unknown";
}
