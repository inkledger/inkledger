// The global rate limits: every tRPC call, per signed-in account and per client
// address, generous enough that nobody working meets them, only a runaway script
// or a flood. In memory, per process: one replica (docs/self-hosting.md). The
// sign-in, shared-link and module limits stay where they are, stricter.
import { TRPCError } from "@trpc/server";
import type { Context, MiddlewareHandler } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { createRateLimiter } from "../lib/security";
import { clientIp } from "../lib/session";
import { sha256Hex } from "../lib/hash";
import { t } from "@contracts/i18n";
import { opsConfig } from "./config";
import { noteLoginFailure } from "./metrics";

type Limits = typeof opsConfig.rateLimit;

export function makeLimiters(l: Limits = opsConfig.rateLimit) {
  return {
    user: createRateLimiter(l.perUser, l.windowMs, { name: "trpc_user" }),
    ip: createRateLimiter(l.perIp, l.windowMs, { name: "trpc_ip" }),
    /** Single sign-on starts and callbacks, per address. */
    sso: createRateLimiter(l.sso, l.windowMs, { name: "sso" }),
    /** SCIM provisioning, per token. */
    scim: createRateLimiter(l.scim, l.windowMs, { name: "scim" }),
    /** Exports (audit log, personal data), per account (exportWait). */
    export: createRateLimiter(l.export, l.windowMs, { name: "export" }),
  };
}

const g = globalThis as { __iklLimiters?: ReturnType<typeof makeLimiters> };
/** One set per process (the dev server evaluates modules again on each change). */
export const limiters = () => (g.__iklLimiters ??= makeLimiters());

/** For an export route: seconds to wait, 0 when allowed. */
export const exportWait = (userId: number): number => limiters().export.hit(`u:${userId}`);

type CallCtx = { user: { id: number } | null; req: Request; remoteAddress?: string; resHeaders: Headers };

/**
 * One tRPC call against the global limits: refused with TOO_MANY_REQUESTS (429,
 * Retry-After set) past either. A call whose address can't be told (no socket:
 * the tests' app.request) is limited by its account only, never all in one bucket.
 */
export function guardCall(ctx: CallCtx, o: { enabled?: boolean; set?: ReturnType<typeof makeLimiters> } = {}): void {
  if (!(o.enabled ?? opsConfig.rateLimit.enabled)) return;
  const set = o.set ?? limiters();
  const ip = ctx.remoteAddress ? clientIp(ctx.req, ctx.remoteAddress) : "unknown";
  const ipWait = ip !== "unknown" ? set.ip.hit(ip) : 0;
  const wait = ipWait > 0 ? ipWait : ctx.user ? set.user.hit(`u:${ctx.user.id}`) : 0;
  if (wait > 0) {
    ctx.resHeaders.set("Retry-After", String(wait));
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: t("server.rateLimit.tooMany", { count: wait }) });
  }
}

/** A sign-in refused (wrong credentials) or held back (too many attempts), for /api/metrics. */
export function noteSignIn(path: string, code: string | undefined): void {
  if (path !== "auth.login" || code === undefined) return;
  if (code === "UNAUTHORIZED") noteLoginFailure("refused");
  else if (code === "TOO_MANY_REQUESTS") noteLoginFailure("throttled");
}

/** A REST route limited by `key` (null: not limited); 429 with Retry-After past it. */
export function limitRoute(
  limiter: () => ReturnType<typeof createRateLimiter>,
  key: (c: Context<{ Bindings: HttpBindings }>) => string | null,
): MiddlewareHandler<{ Bindings: HttpBindings }> {
  return async (c, next) => {
    const k = key(c);
    const wait = k ? limiter().hit(k) : 0;
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ error: t("server.rateLimit.tooMany", { count: wait }) }, 429);
    }
    await next();
  };
}

/** The address a REST request comes from, as the limits count it (null when unknown). */
export function addressOf(c: Context<{ Bindings: HttpBindings }>): string | null {
  const remote = (c.env as HttpBindings | undefined)?.incoming?.socket?.remoteAddress;
  return remote ? clientIp(c.req.raw, remote) : null;
}

/** A bearer token as a limiter key (hashed: the token itself is never held). */
export function bearerKey(c: Context): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
  return m ? `t:${sha256Hex(m[1]).slice(0, 32)}` : null;
}
