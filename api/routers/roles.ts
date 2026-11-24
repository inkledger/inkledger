// Named roles: permission sets given to accounts (users.setAccess) or held within a team
// (a lead's team-lead). The system ones are read-only. An edit is held to the escalation
// guard as a change of access: within what the editor holds, and only an owner touches a
// role that holds manageUsers or manageAuth (before or after the edit).
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { roles } from "@db/schema";
import { OWNER_ONLY_PERMISSIONS, PERMISSIONS, type Permission } from "@contracts/accounts";
import { t } from "@contracts/i18n";
import { createRouter, permProcedure } from "../middleware";
import { getDb, uniqueViolation } from "../queries/connection";
import { listRoles, roleById, storedPermissions, within, type Account, type RoleAccess } from "../queries/accounts";

const manage = permProcedure("manageUsers");

const notAllowed = () => new TRPCError({ code: "FORBIDDEN", message: t("server.auth.notAllowed") });
const ownerOnly = (permissions: readonly Permission[]) => permissions.some((p) => OWNER_ONLY_PERMISSIONS.includes(p));

/** `me` may give these permissions as a role (to anyone, anywhere): within what it holds, none owner-only unless an owner. */
function assertMayHold(me: Account, permissions: readonly Permission[]) {
  if (me.access.owner) return;
  if (ownerOnly(permissions) || !within(me, { owner: false, permissions, teams: [], modules: [] })) throw notAllowed();
}

/** An existing role `me` may change or remove: not a system one, and within what it holds. */
async function editable(id: number, me: Account): Promise<RoleAccess> {
  const role = await roleById(id);
  if (!role) throw new TRPCError({ code: "NOT_FOUND", message: t("server.roles.notFound") });
  if (role.system) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.roles.system") });
  assertMayHold(me, role.permissions);
  return role;
}

const view = (r: RoleAccess) => ({ id: r.id, key: r.key, name: r.name, scope: r.scope, system: r.system, permissions: r.permissions });
const audited = (r: RoleAccess) => ({ key: r.key, name: r.name, scope: r.scope, permissions: r.permissions });
const roleTarget = (r: RoleAccess) => ({ type: "role", id: r.id });

const fields = {
  name: z.string().trim().min(1).max(60),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
};

const taken = (e: unknown) => {
  if (uniqueViolation(e)) throw new TRPCError({ code: "CONFLICT", message: t("server.roles.keyTaken") });
  throw e;
};

export const rolesRouter = createRouter({
  /** Every role, system ones first. */
  list: manage.query(async () => (await listRoles()).map(view)),

  create: manage
    .input(z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/), scope: z.enum(["server", "team"]).default("server"), ...fields }))
    .mutation(async ({ input, ctx }) => {
      assertMayHold(ctx.user, input.permissions);
      const [row] = await getDb()
        .insert(roles)
        .values({ key: input.key, name: input.name, scope: input.scope, permissions: storedPermissions(input.permissions) })
        .returning()
        .catch(taken);
      const made = await roleById(row.id);
      if (!made) throw new TRPCError({ code: "NOT_FOUND" });
      ctx.audit.set({ target: roleTarget(made), after: audited(made) });
      return view(made);
    }),

  /** A new name or permissions: everyone holding the role holds them at their next request. */
  update: manage.input(z.object({ id: z.number().int().positive(), ...fields })).mutation(async ({ input, ctx }) => {
    const before = await editable(input.id, ctx.user);
    assertMayHold(ctx.user, input.permissions);
    await getDb().update(roles).set({ name: input.name, permissions: storedPermissions(input.permissions) }).where(eq(roles.id, before.id));
    const after = await roleById(before.id);
    if (!after) throw new TRPCError({ code: "NOT_FOUND" });
    ctx.audit.set({ target: roleTarget(after), before: audited(before), after: audited(after) });
    return view(after);
  }),

  /** Gone: accounts holding it keep only their own grants (and their other roles). */
  remove: manage.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const role = await editable(input.id, ctx.user);
    await getDb().delete(roles).where(eq(roles.id, role.id));
    ctx.audit.set({ target: roleTarget(role), before: audited(role), after: null });
    return { ok: true };
  }),
});
