import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { eq, gt, and, isNull } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { sessions, users, type User } from "@db/schema";
import { hashSessionId } from "./lib/security";
import { readSessionCookie, sessionCookie } from "./lib/session";
import { env } from "./lib/env";
import { holds, withAccess, type Account } from "./queries/accounts";
import type { Permission } from "@contracts/accounts";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  user: User | null;
  /** Hashed session id, as stored in the sessions table */
  sessionId: string | null;
  /** Socket address of the client (Node server only; absent in tests) */
  remoteAddress?: string;
  /** The device asking (x-device-id): what it remembers for itself, its active bucket */
  deviceId?: string;
  /** This page load (x-client-id): which of the user's open pages acted. */
  clientId?: string;
};

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, idx).trim()] = raw;
    }
  }
  return out;
}

/** Session user for a raw request (cookie → hashed session id). */
export async function userFromRequest(
  req: Request,
): Promise<{ user: User | null; sessionId: string | null; expiresAt?: Date; cookie?: string }> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const cookie = readSessionCookie(req, cookies);
  const sessionId = cookie ? hashSessionId(cookie) : null;
  if (!sessionId) return { user: null, sessionId: null };
  const rows = await getDb()
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date()), isNull(users.disabledAt)))
    .limit(1);
  return { user: rows[0]?.user ?? null, sessionId, expiresAt: rows[0]?.expiresAt, cookie };
}

/**
 * The account behind a REST route (files, uploads, media), held to what
 * tRPC holds it to: signed in, its password set (a forced change opens
 * nothing else), and the permission when the route needs one.
 */
export async function restUser(req: Request, permission?: Permission): Promise<{ user: Account } | { status: 401 | 403; error: string }> {
  const { user: found } = await userFromRequest(req);
  if (!found) return { status: 401, error: "Not logged in" };
  if (found.mustChangePassword) return { status: 403, error: "PASSWORD_CHANGE_REQUIRED" };
  // The same resolver as tRPC's permProcedure.
  const user = await withAccess(found);
  if (permission && !holds(user, permission)) return { status: 403, error: "Not allowed" };
  return { user };
}

/**
 * A session in use doesn't run out: past half its life it is extended to a
 * full one again (cookie too). Only an idle one expires.
 */
export async function renewIfHalfSpent(
  opts: Pick<FetchCreateContextFnOptions, "req" | "resHeaders">,
  sessionId: string,
  cookie: string,
  expiresAt: Date,
): Promise<Date | null> {
  const lifeMs = env.sessionDays * 24 * 3600 * 1000;
  if (expiresAt.getTime() - Date.now() > lifeMs / 2) return null;
  const renewed = new Date(Date.now() + lifeMs);
  await getDb()
    .update(sessions)
    .set({ expiresAt: renewed })
    .where(eq(sessions.id, sessionId));
  opts.resHeaders.append("Set-Cookie", sessionCookie(opts.req, cookie, lifeMs / 1000));
  return renewed;
}

export async function createContext(
  opts: FetchCreateContextFnOptions,
  remoteAddress?: string,
): Promise<TrpcContext> {
  const { user, sessionId, expiresAt, cookie } = await userFromRequest(opts.req);
  if (user && sessionId && cookie && expiresAt) {
    await renewIfHalfSpent(opts, sessionId, cookie, expiresAt);
  }
  const device = idHeader(opts.req, "x-device-id");
  return {
    req: opts.req,
    resHeaders: opts.resHeaders,
    user,
    sessionId,
    remoteAddress,
    deviceId: device,
    clientId: idHeader(opts.req, "x-client-id"),
  };
}

/** A device's or page's id from its header (x-device-id, x-client-id), when well formed. */
export function idHeader(req: Request, name: string): string | undefined {
  const v = req.headers.get(name)?.trim();
  return v && /^[\w-]{8,64}$/.test(v) ? v : undefined;
}
