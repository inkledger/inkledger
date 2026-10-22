import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { createRouter, publicQuery, signedInProcedure } from "../middleware";
import { parseCookies, type TrpcContext } from "../context";
import { getDb } from "../queries/connection";
import { connections, users, sessions, rememberedDevices, type User } from "@db/schema";
import { storeSecret } from "../providers/connections";
import { newSessionId } from "../lib/crypto";
import { env } from "../lib/env";
import { createRateLimiter, hashSessionId } from "../lib/security";
import { clearedSessionCookies, clientIp, readRememberCookie, rememberCookie, sessionCookie } from "../lib/session";
import { normalizeSiteUrl } from "../lib/siteUrl";
import { decoyHash, hashPassword, verifyPassword } from "../lib/password";
import { confirmJiraLogin, jiraLoginInput } from "../lib/jiraLogin";
import { consumeInvite, inviteUser, permissionsOf, roleOf, signOutEverywhere, userByUsername } from "../queries/accounts";
import { PASSWORD_MIN_LENGTH, USERNAME_RE } from "@contracts/accounts";
import { t } from "@contracts/i18n";

export { normalizeSiteUrl };

/** 10 sign-in attempts per account every 5 minutes. */
const loginLimiter = createRateLimiter(10, 5 * 60 * 1000);
/** 30 sign-in attempts per client address every 5 minutes (any account). */
const ipLimiter = createRateLimiter(30, 5 * 60 * 1000);

/** A remembered device signs in again without the password for this long (renewed on use). */
const REMEMBER_DAYS = 180;

type Ctx = Pick<TrpcContext, "req" | "resHeaders" | "remoteAddress">;

/** Bounded, so a huge "password" can't cost the server more than a normal one. */
const passwordInput = z.string().min(1).max(1024);

export function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    role: roleOf(u),
    permissions: permissionsOf(u),
    mustChangePassword: Boolean(u.mustChangePassword),
    email: u.email,
  };
}

function throttle(ctx: Ctx, accountKey?: string) {
  const wait = Math.max(ipLimiter.hit(clientIp(ctx.req, ctx.remoteAddress)), accountKey ? loginLimiter.hit(accountKey) : 0);
  if (wait > 0) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: t("server.auth.tooManyAttempts", { count: wait }) });
  }
}

export function assertNewPassword(password: string) {
  if ([...password].length < PASSWORD_MIN_LENGTH) {
    throw new TRPCError({ code: "BAD_REQUEST", message: t("server.auth.passwordTooShort", { min: PASSWORD_MIN_LENGTH }) });
  }
}

export async function assertFreeUsername(username: string) {
  if (!USERNAME_RE.test(username)) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.auth.usernameInvalid") });
  if (await userByUsername(username)) throw new TRPCError({ code: "CONFLICT", message: t("server.auth.usernameTaken") });
}

async function startSession(ctx: Ctx, userId: number) {
  const sessionId = newSessionId();
  const maxAge = env.sessionDays * 24 * 3600;
  await getDb().insert(sessions).values({
    id: hashSessionId(sessionId),
    userId,
    expiresAt: new Date(Date.now() + maxAge * 1000),
  });
  ctx.resHeaders.append("Set-Cookie", sessionCookie(ctx.req, sessionId, maxAge));
}

/** A fresh remember token for this device (the old one, if any, is dropped). */
async function rememberDevice(ctx: Ctx, userId: number, previous?: string) {
  const db = getDb();
  if (previous) await db.delete(rememberedDevices).where(eq(rememberedDevices.id, previous));
  const token = newSessionId();
  const maxAge = REMEMBER_DAYS * 24 * 3600;
  await db.insert(rememberedDevices).values({
    id: hashSessionId(token),
    userId,
    expiresAt: new Date(Date.now() + maxAge * 1000),
  });
  ctx.resHeaders.append("Set-Cookie", rememberCookie(ctx.req, token, maxAge));
}

function forgetCookie(ctx: Ctx) {
  ctx.resHeaders.append("Set-Cookie", rememberCookie(ctx.req, "deleted", 0));
}

/** The user this device remembers (hashed token + user), if still valid and the account is on. */
async function rememberedUser(req: Request): Promise<{ id: string; user: User } | null> {
  const token = readRememberCookie(req, parseCookies(req.headers.get("cookie")));
  if (!token) return null;
  const id = hashSessionId(token);
  const [row] = await getDb()
    .select({ user: users })
    .from(rememberedDevices)
    .innerJoin(users, eq(rememberedDevices.userId, users.id))
    .where(and(eq(rememberedDevices.id, id), gt(rememberedDevices.expiresAt, new Date()), isNull(users.disabledAt)))
    .limit(1);
  return row ? { id, user: row.user } : null;
}

/** Signed in on this device: a session, and the device remembered for next time. */
async function signIn(ctx: Ctx, user: User) {
  await startSession(ctx, user.id);
  const previous = await rememberedUser(ctx.req);
  await rememberDevice(ctx, user.id, previous?.id);
  return publicUser(user);
}

export const authRouter = createRouter({
  /** inkledger's own sign-in: username and password. Trackers are never asked. */
  login: publicQuery
    .input(z.object({ username: z.string().min(1).max(64), password: passwordInput }))
    .mutation(async ({ input, ctx }) => {
      const key = input.username.toLowerCase();
      throttle(ctx, key);
      const user = await userByUsername(input.username);
      // A missing account costs the same time as a wrong password.
      const ok = await verifyPassword(input.password, user?.passwordHash ?? (await decoyHash()));
      if (!user?.passwordHash || !ok) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: t("server.auth.wrongPassword") });
      }
      if (user.disabledAt) throw new TRPCError({ code: "FORBIDDEN", message: t("server.auth.disabled") });
      loginLimiter.reset(key);
      return signIn(ctx, user);
    }),

  /**
   * An account from before local accounts activates itself: its Jira login,
   * confirmed live, proves who it is; then it picks a username and password,
   * and signs in with those from now on.
   */
  activate: publicQuery
    .input(jiraLoginInput.extend({ newUsername: z.string().min(1).max(64), newPassword: passwordInput }))
    .mutation(async ({ input, ctx }) => {
      throttle(ctx, `${input.siteUrl}|${input.username.toLowerCase()}`);
      assertNewPassword(input.newPassword);
      const identity = await confirmJiraLogin(input);
      // The account whose connection this Jira login is.
      const [found] = await getDb()
        .select({ user: users, connectionId: connections.id })
        .from(connections)
        .innerJoin(users, eq(users.id, connections.userId))
        .where(and(eq(connections.type, "jira"), eq(connections.baseUrl, identity.siteUrl), eq(connections.remoteAccountId, identity.accountId)))
        .orderBy(asc(connections.id))
        .limit(1);
      const user = found?.user;
      if (!found || !user || user.disabledAt) throw new TRPCError({ code: "NOT_FOUND", message: t("server.auth.noAccountToActivate") });
      if (user.passwordHash) throw new TRPCError({ code: "CONFLICT", message: t("server.auth.alreadyActivated") });
      const username = input.newUsername.trim().toLowerCase();
      await assertFreeUsername(username);
      const [activated] = await getDb()
        .update(users)
        .set({ displayName: identity.displayName, email: identity.email, avatarUrl: identity.avatarUrl, username, passwordHash: await hashPassword(input.newPassword), mustChangePassword: 0 })
        .where(eq(users.id, user.id))
        .returning();
      // The login just confirmed is the connection's credentials now.
      await storeSecret(found.connectionId, identity.secret);
      await getDb().update(connections).set({ status: "ok", archivedAt: null }).where(eq(connections.id, found.connectionId));
      return signIn(ctx, activated);
    }),

  /** Who an invite link is for (the page greets them and asks for a password). */
  invite: publicQuery.input(z.object({ token: z.string().min(1).max(128) })).query(async ({ input, ctx }) => {
    throttle(ctx);
    const found = await inviteUser(input.token);
    if (!found) throw new TRPCError({ code: "NOT_FOUND", message: t("server.auth.inviteInvalid") });
    return { username: found.user.username, displayName: found.user.displayName };
  }),

  /** Accepting an invite: the person sets their password and is signed in. */
  acceptInvite: publicQuery
    .input(z.object({ token: z.string().min(1).max(128), password: passwordInput }))
    .mutation(async ({ input, ctx }) => {
      throttle(ctx);
      assertNewPassword(input.password);
      // The slow part first: the link (its maker's rights, the account's access) is checked
      // right before the write, not before a hash that leaves time for either to change.
      const passwordHash = await hashPassword(input.password);
      const found = await inviteUser(input.token);
      if (!found || !(await consumeInvite(found.inviteId))) {
        throw new TRPCError({ code: "NOT_FOUND", message: t("server.auth.inviteInvalid") });
      }
      // The account as the link was checked against: changed since, it is no longer the link's to open.
      const [user] = await getDb()
        .update(users)
        .set({ passwordHash, mustChangePassword: 0 })
        .where(
          and(
            eq(users.id, found.user.id),
            isNull(users.passwordHash),
            eq(users.role, found.user.role),
            eq(users.permissions, found.user.permissions),
          ),
        )
        .returning();
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: t("server.auth.inviteInvalid") });
      await signOutEverywhere(user.id);
      return signIn(ctx, user);
    }),

  /**
   * A new password (required after the default one or a reset). Every other
   * session and remembered device of the account ends; this one stays.
   */
  changePassword: signedInProcedure
    .input(z.object({ current: passwordInput, next: passwordInput }))
    .mutation(async ({ input, ctx }) => {
      throttle(ctx, `change|${ctx.user.id}`);
      if (!ctx.user.passwordHash || !(await verifyPassword(input.current, ctx.user.passwordHash))) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: t("server.auth.wrongPassword") });
      }
      assertNewPassword(input.next);
      if (input.next === input.current || input.next === env.adminPassword) {
        throw new TRPCError({ code: "BAD_REQUEST", message: t("server.auth.passwordUnchanged") });
      }
      const [user] = await getDb()
        .update(users)
        .set({ passwordHash: await hashPassword(input.next), mustChangePassword: 0 })
        .where(eq(users.id, ctx.user.id))
        .returning();
      await signOutEverywhere(user.id, ctx.sessionId);
      await rememberDevice(ctx, user.id);
      return publicUser(user);
    }),

  /** Who this device can sign in as without the password (the login page offers it). */
  remembered: publicQuery.query(async ({ ctx }) => {
    const found = await rememberedUser(ctx.req);
    if (!found) return null;
    const u = found.user;
    return { displayName: u.displayName, username: u.username, email: u.email };
  }),

  /** Sign in again as the remembered user. No tracker is asked: inkledger's account is the account. */
  resume: publicQuery.mutation(async ({ ctx }) => {
    throttle(ctx);
    const found = await rememberedUser(ctx.req);
    if (!found) {
      forgetCookie(ctx);
      throw new TRPCError({ code: "UNAUTHORIZED", message: t("server.auth.signInWithCredentials") });
    }
    await startSession(ctx, found.user.id);
    await rememberDevice(ctx, found.user.id, found.id);
    return publicUser(found.user);
  }),

  /** This device stops remembering the user (the next sign-in asks for the password). */
  forget: publicQuery.mutation(async ({ ctx }) => {
    const found = await rememberedUser(ctx.req);
    if (found) await getDb().delete(rememberedDevices).where(eq(rememberedDevices.id, found.id));
    forgetCookie(ctx);
    return { ok: true };
  }),

  me: publicQuery.query(({ ctx }) => (ctx.user ? publicUser(ctx.user) : null)),

  /**
   * Public: works with an expired or missing session, always clears the
   * cookie. The device stays remembered: signing in again is one click.
   */
  logout: publicQuery.mutation(async ({ ctx }) => {
    if (ctx.sessionId) {
      await getDb().delete(sessions).where(eq(sessions.id, ctx.sessionId));
    }
    for (const c of clearedSessionCookies(ctx.req)) ctx.resHeaders.append("Set-Cookie", c);
    return { ok: true };
  }),
});
