import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { TrpcContext } from "./context";
import { env } from "./lib/env";
import { serverBuild } from "./lib/appBuild";
import { APP_BUILD_CHANGED, APP_BUILD_HEADER } from "@contracts/appBuild";
import { JiraApiError } from "./jira/client";
import { ProviderError } from "./providers/core/errors";
import { providerTrpcError } from "./providers/trpc";
import { TimerConflictError } from "./lib/timerConflict";
import { StaleDraftError } from "./workspace/staleDraft";
import { t as tr } from "@contracts/i18n";
import type { Permission } from "@contracts/accounts";
import { can } from "./queries/accounts";
import { recordProcedure, UNAUDITED_PROCEDURES, type AuditDetails } from "./lib/audit";
import type { AuditAction } from "@contracts/audit";
import { markConnection, markJiraConnection } from "./providers/connections";
import { originOf } from "./providers/core/origin";
import { PROVIDER_NAMES } from "@contracts/providerNames";
import { guardCall, noteSignIn } from "./ops/rateLimits";
import type { ProviderType } from "@contracts/providers";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // A provider's refusal by field (a transition's fields): the form marks them.
    const fields = error.cause instanceof ProviderError ? error.cause.fields : undefined;
    if (fields) return { ...shape, data: { ...shape.data, fields } };
    // A timer held by another device, or changed meanwhile: who, since when, to say it and offer a take-over.
    if (error.cause instanceof TimerConflictError) return { ...shape, data: { ...shape.data, timer: error.cause.info } };
    // A layout draft made on an older layout: how many of its changes can be proposed again.
    if (error.cause instanceof StaleDraftError) return { ...shape, data: { ...shape.data, staleDraft: error.cause.info } };
    // Input the server refused: words for people, never the validator's JSON;
    // the fields it named go along for the form to mark.
    if (error.cause instanceof ZodError) {
      const named = Object.fromEntries(error.cause.issues.map((i) => [i.path.map(String).join(".") || "input", tr("server.input.invalidField")]));
      return { ...shape, message: tr("server.input.invalid"), data: { ...shape.data, fields: named } };
    }
    // Unexpected errors (SQLite, bugs) keep details in the server log only.
    if (error.code === "INTERNAL_SERVER_ERROR") {
      console.error(error.cause ?? error);
      if (env.isProduction) {
        return {
          ...shape,
          message: tr("server.internal.error"),
          data: { ...shape.data, stack: undefined },
        };
      }
    }
    return shape;
  },
});

export const createRouter = t.router;

/** A page from an older build talks to an API it doesn't know: it is told to reload (T9). Calls without a build (older apps) pass. */
const sameBuild = t.middleware(({ ctx, next }) => {
  const theirs = ctx.req.headers.get(APP_BUILD_HEADER);
  const ours = serverBuild();
  if (theirs && ours && theirs !== ours) throw new TRPCError({ code: "CONFLICT", message: APP_BUILD_CHANGED });
  return next();
});

/** The global rate limits (ops/rateLimits.ts), and sign-ins refused counted for /api/metrics. */
const limited = t.middleware(async ({ ctx, path, next }) => {
  guardCall(ctx);
  const result = await next();
  if (!result.ok) noteSignIn(path, result.error.code);
  return result;
});

export const publicQuery = t.procedure.use(sameBuild).use(limited);

/** Stored Jira secret that no longer decrypts (SESSION_SECRET changed). */
export class UnreadableCredentialsError extends Error {
  constructor() {
    super(tr("server.auth.credentialsUnreadable"));
    this.name = "UnreadableCredentialsError";
  }
}

/** Signed in, whatever the account still has to do (the password change itself runs here). */
export const signedInProcedure = publicQuery.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not logged in" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** The error an account gets for anything else until it sets a new password. */
export const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";

export const protectedProcedure = signedInProcedure.use(async ({ ctx, next }) => {
  // A default or reset password opens nothing but the change of password.
  if (ctx.user.mustChangePassword) {
    throw new TRPCError({ code: "FORBIDDEN", message: PASSWORD_CHANGE_REQUIRED });
  }
  const result = await next();
  if (!result.ok) {
    // A revoked tracker token or a secret that no longer decrypts is the
    // connection's problem, not the account's: it is marked to reconnect,
    // and the user stays signed in.
    const cause = result.error.cause;
    const refused = (cause instanceof JiraApiError && cause.status === 401) || (cause instanceof ProviderError && cause.kind === "auth");
    if (refused || cause instanceof UnreadableCredentialsError) {
      const status = refused ? "auth_failed" : "unreadable";
      // Only the connection that was refused waits to be reconnected.
      const from = originOf(cause);
      const type = from !== undefined ? await markConnection(ctx.user.id, from, status) : cause instanceof JiraApiError ? (await markJiraConnection(ctx.user.id, status), "jira") : null;
      const provider = type && type in PROVIDER_NAMES ? PROVIDER_NAMES[type as ProviderType] : tr("server.auth.aTracker");
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: tr("server.auth.reconnect", { provider }), cause });
    }
    // A tracker's error no router mapped (providerCall), answered as providerCall does: a
    // refusal in its words (a delete Plane can't do), no answer in the user's, a fault as one.
    if (cause instanceof ProviderError && result.error.code === "INTERNAL_SERVER_ERROR") throw providerTrpcError(cause);
  }
  return result;
});

/**
 * What a handler behind a permission tells its one audit event: the target, before and
 * after, another action name (a restore's is restore.completed). The middleware writes it.
 */
export type AuditScope = { set(details: AuditDetails & { action?: AuditAction }): void };

/** The fields of a call's raw input: what an event keeps when its handler said nothing (redacted per action). */
function inputFields(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * For what a permission covers (contracts/accounts.ts): an admin has them all. Every
 * mutation behind one writes exactly one audit event: done, failed or refused (input the
 * parser refused is no action). A handler adds its details through ctx.audit.
 */
export const permProcedure = (permission: Permission) =>
  protectedProcedure.use(async ({ ctx, next, type, path, getRawInput }) => {
    const audited = type === "mutation" && !(path in UNAUDITED_PROCEDURES);
    if (!can(ctx.user, permission)) {
      if (audited) await recordProcedure(ctx, path, { outcome: "denied" });
      throw new TRPCError({ code: "FORBIDDEN", message: tr("server.auth.notAllowed") });
    }
    let told: AuditDetails & { action?: AuditAction } = {};
    const audit: AuditScope = { set: (details) => (told = { ...told, ...details }) };
    const result = await next({ ctx: { audit } });
    if (!audited || (!result.ok && result.error.cause instanceof ZodError)) return result;
    const input = told.after === undefined ? inputFields(await getRawInput().catch(() => null)) : undefined;
    const id = input?.id;
    const target = told.target ?? (typeof id === "number" || typeof id === "string" ? { type: path.split(".")[0], id } : undefined);
    await recordProcedure(ctx, told.action ?? path, {
      ...told,
      target,
      after: told.after === undefined ? input : told.after,
      outcome: result.ok ? (told.outcome ?? "ok") : "failed",
    });
    return result;
  });
