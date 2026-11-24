// Teams: groups of people. A lead reads its team's time (the team-lead role, held within
// the team: role_assignments), so making someone a lead is a change of access: whoever does
// it must hold that team's time itself (on the whole server, or as the team's own lead).
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { roleAssignments, teamMembers, teams, users } from "@db/schema";
import { t } from "@contracts/i18n";
import { createRouter, permProcedure } from "../middleware";
import { getDb, uniqueViolation } from "../queries/connection";
import { roleByKey, userById, within, type Account } from "../queries/accounts";

const manage = permProcedure("manageTeams");

const notAllowed = () => new TRPCError({ code: "FORBIDDEN", message: t("server.auth.notAllowed") });
const notFound = () => new TRPCError({ code: "NOT_FOUND", message: t("server.teams.notFound") });

const nameTaken = (e: unknown): never => {
  if (uniqueViolation(e)) throw new TRPCError({ code: "CONFLICT", message: t("server.teams.nameTaken") });
  throw e;
};

async function teamOf(id: number) {
  const [team] = await getDb().select().from(teams).where(eq(teams.id, id)).limit(1);
  if (!team) throw notFound();
  return team;
}

/** `me` may make someone this team's lead: it holds what a lead holds there. */
async function assertMayLead(me: Account, teamId: number) {
  const lead = await roleByKey("team-lead");
  if (!lead || !within(me, { owner: false, permissions: [], teams: [{ teamId, permissions: lead.permissions }], modules: [] })) throw notAllowed();
}

const teamTarget = (team: { id: number }) => ({ type: "team", id: team.id });

export const teamsRouter = createRouter({
  /** Every team with its people (leads first), and the active accounts one can add (names only). */
  list: manage.query(async () => {
    const db = getDb();
    const [all, members, people] = await Promise.all([
      db.select().from(teams).orderBy(asc(teams.name)),
      db
        .select({ teamId: teamMembers.teamId, userId: teamMembers.userId, role: teamMembers.role, displayName: users.displayName, username: users.username })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .orderBy(asc(users.displayName)),
      db.select({ id: users.id, displayName: users.displayName, username: users.username }).from(users).where(isNull(users.disabledAt)).orderBy(asc(users.displayName)),
    ]);
    const list = all.map((team) => ({
      id: team.id,
      name: team.name,
      externalId: team.externalId,
      members: members
        .filter((m) => m.teamId === team.id)
        .map((m) => ({ userId: m.userId, displayName: m.displayName, username: m.username, role: m.role === "lead" ? ("lead" as const) : ("member" as const) }))
        .sort((a, b) => Number(b.role === "lead") - Number(a.role === "lead")),
    }));
    return { teams: list, people };
  }),

  create: manage.input(z.object({ name: z.string().trim().min(1).max(80) })).mutation(async ({ input, ctx }) => {
    const [team] = await getDb().insert(teams).values({ name: input.name }).returning().catch(nameTaken);
    ctx.audit.set({ target: teamTarget(team), after: { name: team.name } });
    return { id: team.id, name: team.name };
  }),

  rename: manage.input(z.object({ id: z.number().int().positive(), name: z.string().trim().min(1).max(80) })).mutation(async ({ input, ctx }) => {
    const before = await teamOf(input.id);
    await getDb().update(teams).set({ name: input.name }).where(eq(teams.id, before.id)).catch(nameTaken);
    ctx.audit.set({ target: teamTarget(before), before: { name: before.name }, after: { name: input.name } });
    return { id: before.id, name: input.name };
  }),

  /** Gone with its places and the leads' role in it; the people stay. */
  remove: manage.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const team = await teamOf(input.id);
    await getDb().delete(teams).where(eq(teams.id, team.id));
    ctx.audit.set({ target: teamTarget(team), before: { name: team.name }, after: null });
    return { ok: true };
  }),

  /** Someone in the team, as a member or its lead (a lead holds the team-lead role there). */
  setMember: manage
    .input(z.object({ teamId: z.number().int().positive(), userId: z.number().int().positive(), role: z.enum(["member", "lead"]) }))
    .mutation(async ({ input, ctx }) => {
      const team = await teamOf(input.teamId);
      const person = await userById(input.userId);
      if (!person) throw new TRPCError({ code: "NOT_FOUND" });
      const lead = await roleByKey("team-lead");
      const [was] = await getDb().select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, person.id)));
      // Making or unmaking a lead changes what someone may read: held to the guard both ways.
      if (input.role === "lead" || was?.role === "lead") await assertMayLead(ctx.user, team.id);
      await getDb().transaction(async (tx) => {
        await tx
          .insert(teamMembers)
          .values({ teamId: team.id, userId: person.id, role: input.role })
          .onConflictDoUpdate({ target: [teamMembers.teamId, teamMembers.userId], set: { role: input.role } });
        if (!lead) return;
        await tx.delete(roleAssignments).where(and(eq(roleAssignments.userId, person.id), eq(roleAssignments.roleId, lead.id), eq(roleAssignments.teamId, team.id)));
        if (input.role === "lead") await tx.insert(roleAssignments).values({ userId: person.id, roleId: lead.id, teamId: team.id });
      });
      ctx.audit.set({ target: teamTarget(team), before: was ? { team: team.name, username: person.username, role: was.role } : null, after: { team: team.name, username: person.username, role: input.role } });
      return { ok: true };
    }),

  /** Out of the team (a lead loses the team's time with it). */
  removeMember: manage.input(z.object({ teamId: z.number().int().positive(), userId: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const team = await teamOf(input.teamId);
    const [was] = await getDb().select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, input.userId)));
    if (!was) throw new TRPCError({ code: "NOT_FOUND" });
    if (was.role === "lead") await assertMayLead(ctx.user, team.id);
    const person = await userById(input.userId);
    await getDb().transaction(async (tx) => {
      await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, input.userId)));
      await tx.delete(roleAssignments).where(and(eq(roleAssignments.userId, input.userId), eq(roleAssignments.teamId, team.id), isNotNull(roleAssignments.teamId)));
    });
    ctx.audit.set({ target: teamTarget(team), before: { team: team.name, username: person?.username ?? null, role: was.role }, after: null });
    return { ok: true };
  }),
});
