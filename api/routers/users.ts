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
import { can, createInvite, permissionsOf, roleOf, signOutEverywhere, storedPermissions, userById, within } from "../queries/accounts";
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
 * A write to account `id`, which would take it out of the admins if it is one
 * (`takesAway`). The active admins are locked first (in one order), and whether it is
 * one is read then, not before: if so, the write goes only while another one stays. Two admins turning
 * each other off at once, or one promoted meanwhile, can't leave the server with none.
 */
/** Whoever acts, read now: on, and managing accounts (else nothing it asked is done). */
function assertActing(actor: User | undefined): asserts actor is User {
  if (!actor || actor.disabledAt || !can(actor, "manageUsers")) throw notAllowed();
}

/** The acting account as it is now, not as signed in (turned off or demoted meanwhile). */
async function actingNow(me: User): Promise<User> {
  const actor = await userById(me.id);
  assertActing(actor);
  return actor;
}

async function writeAccount<T>(me: User, target: User, takesAway: boolean, write: (db: Tx, me: User) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    const admins = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "admin"), isNull(users.disabledAt)))
      .orderBy(asc(users.id))
      .for("update");
    // Whoever acts, as now, not as signed in: still on, still managing accounts, still
    // above the account as it was checked (turned off or demoted meanwhile, it writes nothing).
    const [actor] = await tx.select().from(users).where(eq(users.id, me.id)).for("share");
    assertActing(actor);
    assertWithin(actor, { role: roleOf(target), permissions: permissionsOf(target) });
    const [now] = await tx.select({ role: users.role, disabledAt: users.disabledAt }).from(users).where(eq(users.id, target.id));
    const admin = now?.role === "admin" && !now.disabledAt;
    if (admin && takesAway && !admins.some((a) => a.id !== target.id)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: t("server.auth.lastAdmin") });
    }
    return write(tx, actor);
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
      const me = await actingNow(ctx.user);
      assertWithin(me, input);
      const username = input.username.trim().toLowerCase();
      await assertFreeUsername(username);
      const [user] = await getDb()
        .insert(users)
        .values({ username, displayName: input.displayName, role: input.role, permissions: storedPermissions(input.permissions) })
        .returning();
      const { token, expiresAt } = await createInvite(user.id, me.id);
      return { user: row(user), link: inviteLink(token), expiresAt };
    }),

  /** A new invite link for an account that hasn't set its password yet (the old link stops working). */
  reinvite: manage.input(z.object({ id: z.number().int() })).mutation(async ({ input, ctx }) => {
    const me = await actingNow(ctx.user);
    const user = await target(input.id, me);
    // A link sets the password: for an account that has one, it would be a takeover.
    if (user.passwordHash) throw notAllowed();
    const { token, expiresAt } = await createInvite(user.id, me.id);
    return { link: inviteLink(token), expiresAt };
  }),

  setAccess: manage.input(access.extend({ id: z.number().int() })).mutation(async ({ input, ctx }) => {
    const user = await target(input.id, ctx.user);
    assertWithin(ctx.user, input);
    const [updated] = await writeAccount(ctx.user, user, input.role !== "admin", (db, me) => {
      assertWithin(me, input);
      return db
        .update(users)
        .set({ role: input.role, permissions: storedPermissions(input.permissions) })
        .where(asChecked(user, me))
        .returning();
    });
    if (!updated) throw notAllowed();
    return row(updated);
  }),

  /** A temporary password, shown once; the account must change it at its next sign-in, and is signed out everywhere. */
  resetPassword: manage.input(z.object({ id: z.number().int() })).mutation(async ({ input, ctx }) => {
    const user = await target(input.id, ctx.user);
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    const done = await writeAccount(ctx.user, user, false, (db, me) =>
      db.update(users).set({ passwordHash, mustChangePassword: 1 }).where(asChecked(user, me)).returning({ id: users.id }),
    );
    if (done.length === 0) throw notAllowed();
    await signOutEverywhere(user.id);
    return { password };
  }),

  /** Turns an account off (signed out everywhere, no sign-in) or on again. Its data stays. */
  setDisabled: manage.input(z.object({ id: z.number().int(), disabled: z.boolean() })).mutation(async ({ input, ctx }) => {
    const user = await target(input.id, ctx.user);
    const [updated] = await writeAccount(ctx.user, user, input.disabled, (db, me) =>
      db
        .update(users)
        .set({ disabledAt: input.disabled ? new Date() : null })
        .where(asChecked(user, me))
        .returning(),
    );
    if (!updated) throw notAllowed();
    if (input.disabled) await signOutEverywhere(user.id);
    return row(updated);
  }),
});
