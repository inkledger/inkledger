// Accounts on this server, for whoever may manage them: invite people with
// what they may do, reset a password, turn an account off. Nobody sees
// anyone else's connections or time from here.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { connections, users, type User } from "@db/schema";
import { PERMISSIONS } from "@contracts/accounts";
import { t } from "@contracts/i18n";
import { createRouter, permProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { createInvite, permissionsOf, roleOf, signOutEverywhere, storedPermissions, userById, within } from "../queries/accounts";
import { hashPassword, temporaryPassword } from "../lib/password";
import { assertFreeUsername } from "./auth";

const manage = permProcedure("manageUsers");

const access = z.object({
  role: z.enum(["admin", "member"]),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
});

const row = (u: User) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  role: roleOf(u),
  permissions: permissionsOf(u),
  /** Hasn't set a password yet (invite pending, or an account from before local accounts) */
  pending: !u.passwordHash,
  mustChangePassword: Boolean(u.mustChangePassword),
  disabled: Boolean(u.disabledAt),
  createdAt: u.createdAt,
});

const notAllowed = () => new TRPCError({ code: "FORBIDDEN", message: t("server.auth.notAllowed") });

/**
 * Within what `me` holds: an admin may anything; anyone else (an account manager
 * by permission) never an admin, nor a power it hasn't itself. Otherwise it could
 * hand one to an account it controls, or take over a bigger one (a reset, a link).
 */
function assertWithin(me: User, granted: { role: string; permissions: readonly string[] }) {
  if (!within(me, granted)) throw notAllowed();
}

async function target(id: number, me: User): Promise<User> {
  if (id === me.id) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.auth.notYourself") });
  const user = await userById(id);
  if (!user) throw new TRPCError({ code: "NOT_FOUND" });
  assertWithin(me, { role: roleOf(user), permissions: permissionsOf(user) });
  return user;
}

/**
 * The account as `target` checked it: a write by a manager matches it only if
 * nobody changed its access meanwhile (else it may be beyond the manager now).
 */
function asChecked(user: User, me: User) {
  if (roleOf(me) === "admin") return eq(users.id, user.id);
  return and(eq(users.id, user.id), eq(users.role, user.role), eq(users.permissions, user.permissions));
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * A write to account `id`, which may stop it being an active admin (`removing`): then
 * only while another one stays. The active admins are locked first (in one order), so
 * two admins turning each other off at once can't both pass and leave none.
 */
async function writeAccount<T>(id: number, removing: boolean, write: (db: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    if (removing) {
      const admins = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), isNull(users.disabledAt)))
        .orderBy(asc(users.id))
        .for("update");
      if (!admins.some((a) => a.id !== id)) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.auth.lastAdmin") });
    }
    return write(tx);
  });
}

const inviteLink = (token: string) => `/invite/${token}`;

export const usersRouter = createRouter({
  /** Every account; of their trackers only how many (T6: never which, or what they hold). */
  list: manage.query(async () => {
    const counts = new Map(
      (
        await getDb()
          .select({ userId: connections.userId, n: sql<number>`count(*)::int` })
          .from(connections)
          .where(isNull(connections.archivedAt))
          .groupBy(connections.userId)
      ).map((c) => [c.userId, c.n]),
    );
    return (await getDb().select().from(users).orderBy(asc(users.id))).map((u) => ({ ...row(u), connections: counts.get(u.id) ?? 0 }));
  }),

  /** A new account and its one-time invite link (no mail leaves the server: the admin hands it over). */
  invite: manage
    .input(access.extend({ username: z.string().min(1).max(64), displayName: z.string().trim().min(1).max(80) }))
    .mutation(async ({ input, ctx }) => {
      assertWithin(ctx.user, input);
      const username = input.username.trim().toLowerCase();
      await assertFreeUsername(username);
      const [user] = await getDb()
        .insert(users)
        .values({ username, displayName: input.displayName, role: input.role, permissions: storedPermissions(input.permissions) })
        .returning();
      const { token, expiresAt } = await createInvite(user.id, ctx.user.id);
      return { user: row(user), link: inviteLink(token), expiresAt };
    }),

  /** A new invite link for an account that hasn't set its password yet (the old link stops working). */
  reinvite: manage.input(z.object({ id: z.number().int() })).mutation(async ({ input, ctx }) => {
    const user = await target(input.id, ctx.user);
    // A link sets the password: for an account that has one, it would be a takeover.
    if (user.passwordHash) throw notAllowed();
    const { token, expiresAt } = await createInvite(user.id, ctx.user.id);
    return { link: inviteLink(token), expiresAt };
  }),

  setAccess: manage.input(access.extend({ id: z.number().int() })).mutation(async ({ input, ctx }) => {
    const user = await target(input.id, ctx.user);
    assertWithin(ctx.user, input);
    const [updated] = await writeAccount(user.id, user.role === "admin" && input.role !== "admin", (db) =>
      db
        .update(users)
        .set({ role: input.role, permissions: storedPermissions(input.permissions) })
        .where(asChecked(user, ctx.user))
        .returning(),
    );
    if (!updated) throw notAllowed();
    return row(updated);
  }),

  /** A temporary password, shown once; the account must change it at its next sign-in, and is signed out everywhere. */
  resetPassword: manage.input(z.object({ id: z.number().int() })).mutation(async ({ input, ctx }) => {
    const user = await target(input.id, ctx.user);
    const password = temporaryPassword();
    const done = await getDb()
      .update(users)
      .set({ passwordHash: await hashPassword(password), mustChangePassword: 1 })
      .where(asChecked(user, ctx.user))
      .returning({ id: users.id });
    if (done.length === 0) throw notAllowed();
    await signOutEverywhere(user.id);
    return { password };
  }),

  /** Turns an account off (signed out everywhere, no sign-in) or on again. Its data stays. */
  setDisabled: manage.input(z.object({ id: z.number().int(), disabled: z.boolean() })).mutation(async ({ input, ctx }) => {
    const user = await target(input.id, ctx.user);
    const [updated] = await writeAccount(user.id, input.disabled && user.role === "admin", (db) =>
      db
        .update(users)
        .set({ disabledAt: input.disabled ? new Date() : null })
        .where(asChecked(user, ctx.user))
        .returning(),
    );
    if (!updated) throw notAllowed();
    if (input.disabled) await signOutEverywhere(user.id);
    return row(updated);
  }),
});
