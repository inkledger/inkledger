// The team report, for whoever may see everyone's time (viewTeamTime): each
// active account's logged hours over a range, day by day, against its own
// target, one account's period (its projects and issues) and one account's
// day. Read only; nothing here changes anyone's time.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { containers, issues, plannedEntries, users, worklogs } from "@db/schema";
import { addDays, dayKey, parseDayKey } from "@contracts/time";
import { effectiveTargetSeconds, expectedSeconds, scheduleFor } from "@contracts/workSchedule";
import type { PlannedInterval } from "@contracts/planned";
import { t } from "@contracts/i18n";
import { createRouter, permProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issueOfWorklog } from "../queries/worklogScope";
import { dayOverridesOf, scheduleVersionsOf, timeFreshness } from "../queries/teamTime";
import { issueIdentity, projectGroup, rangeOf, worklogProjectKey } from "./reports";

const view = permProcedure("viewTeamTime");

/** How many projects and issues one account's period lists. */
const TOP = 5;

/** Vacation only: work and travel never change a target, and nobody else reads their notes. */
async function vacations(userIds: number[], from: Date, to: Date): Promise<Map<number, PlannedInterval[]>> {
  const out = new Map<number, PlannedInterval[]>(userIds.map((id) => [id, []]));
  if (userIds.length === 0) return out;
  const rows = await getDb()
    .select({ userId: plannedEntries.userId, startsAt: plannedEntries.startsAt, endsAt: plannedEntries.endsAt })
    .from(plannedEntries)
    .where(and(inArray(plannedEntries.userId, userIds), eq(plannedEntries.kind, "vacation"), lt(plannedEntries.startsAt, to), gt(plannedEntries.endsAt, from)));
  for (const r of rows) out.get(r.userId)?.push({ kind: "vacation", startsAt: r.startsAt, endsAt: r.endsAt });
  return out;
}

/** An active account, or NOT_FOUND (turned off, or never there). */
async function activePerson(userId: number): Promise<{ id: number }> {
  const [person] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .limit(1);
  if (!person) throw new TRPCError({ code: "NOT_FOUND", message: t("server.team.notFound") });
  return person;
}

type Totals = { loggedSeconds: number; targetSeconds: number; coverage: number | null };

const totalsOf = (loggedSeconds: number, targetSeconds: number): Totals => ({
  loggedSeconds,
  targetSeconds,
  /** Logged over target (1 = all of it); null with nothing expected */
  coverage: targetSeconds > 0 ? loggedSeconds / targetSeconds : null,
});

/**
 * Each account's days over [from, to): logged seconds (the entries' plain
 * sum, by the server's local day as in Reports), its target (schedule minus
 * vacation) and the time vacation took. Totals count the target of the days
 * up to today only: a day still to come is nobody's shortfall; time logged
 * ahead counts all the same.
 */
async function summarize(ids: number[], from: Date, to: Date, now: Date) {
  const logs = ids.length === 0
    ? []
    : await getDb()
        .select({ userId: worklogs.userId, started: worklogs.started, seconds: worklogs.timeSpentSeconds })
        .from(worklogs)
        .where(and(inArray(worklogs.userId, ids), gte(worklogs.started, from), lt(worklogs.started, to)));
  const [versions, away, ownDays] = await Promise.all([scheduleVersionsOf(ids), vacations(ids, from, to), dayOverridesOf(ids)]);
  const days: Date[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const today = dayKey(now);
  const elapsedDays = days.filter((d) => dayKey(d) <= today).length;
  const logged = new Map<number, Map<string, number>>(ids.map((id) => [id, new Map()]));
  for (const w of logs) {
    const m = logged.get(w.userId);
    if (!m) continue;
    const key = dayKey(w.started);
    m.set(key, (m.get(key) ?? 0) + w.seconds);
  }
  const people = new Map(
    ids.map((id) => {
      const mine = logged.get(id) ?? new Map<string, number>();
      const planned = away.get(id) ?? [];
      const schedules = versions.get(id) ?? [];
      const perDay = days.map((d) => {
        const schedule = scheduleFor(d, schedules, ownDays.get(id));
        const targetSeconds = effectiveTargetSeconds(d, schedule, planned);
        return {
          day: dayKey(d),
          loggedSeconds: mine.get(dayKey(d)) ?? 0,
          targetSeconds,
          absentSeconds: Math.max(0, expectedSeconds(d, schedule) - targetSeconds),
        };
      });
      const loggedSeconds = perDay.reduce((a, d) => a + d.loggedSeconds, 0);
      const targetSeconds = perDay.slice(0, elapsedDays).reduce((a, d) => a + d.targetSeconds, 0);
      return [id, { ...totalsOf(loggedSeconds, targetSeconds), days: perDay }] as const;
    }),
  );
  return { people, elapsedDays };
}

export const teamRouter = createRouter({
  /**
   * Every active account over a range (inclusive day keys): its logged
   * seconds per day and in all, its target (schedule minus vacation, up to
   * today), and how fresh its time is; most hours first. With `compare`,
   * the same totals over the range of equal length just before.
   */
  overview: view
    .input(z.object({ from: z.string().min(1), to: z.string().min(1), compare: z.boolean().default(false) }))
    .query(async ({ input }) => {
      const { from, to } = rangeOf(input);
      const now = new Date();
      const people = await getDb()
        .select({ id: users.id, displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl })
        .from(users)
        .where(isNull(users.disabledAt))
        .orderBy(asc(users.id));
      const ids = people.map((p) => p.id);
      const length = Math.round((to.getTime() - from.getTime()) / 86_400_000);
      const [current, previous, fresh] = await Promise.all([
        summarize(ids, from, to, now),
        input.compare ? summarize(ids, addDays(from, -length), from, now) : null,
        timeFreshness(ids),
      ]);
      const rows = people.map((p) => {
        const mine = current.people.get(p.id) ?? { ...totalsOf(0, 0), days: [] };
        const before = previous?.people.get(p.id);
        return {
          userId: p.id,
          displayName: p.displayName || p.username || "",
          avatarUrl: p.avatarUrl,
          freshness: fresh.get(p.id) ?? { state: "local" as const, at: null },
          ...mine,
          previous: before ? totalsOf(before.loggedSeconds, before.targetSeconds) : null,
        };
      });
      rows.sort((a, b) => b.loggedSeconds - a.loggedSeconds || a.displayName.localeCompare(b.displayName));
      const sum = (pick: (r: Totals) => number, list: Totals[]) => list.reduce((a, r) => a + pick(r), 0);
      const prev = rows.flatMap((r) => (r.previous ? [r.previous] : []));
      return {
        people: rows,
        /** Days of the range up to today: the ones a target counts */
        elapsedDays: current.elapsedDays,
        ...totalsOf(sum((r) => r.loggedSeconds, rows), sum((r) => r.targetSeconds, rows)),
        previous: previous ? totalsOf(sum((r) => r.loggedSeconds, prev), sum((r) => r.targetSeconds, prev)) : null,
      };
    }),

  /**
   * One active account's period: the projects and issues its hours went to
   * (the most first, names and hours only: no comments, no notes).
   */
  person: view
    .input(z.object({ userId: z.number().int().positive(), from: z.string().min(1), to: z.string().min(1) }))
    .query(async ({ input }) => {
      const { from, to } = rangeOf(input);
      const person = await activePerson(input.userId);
      const db = getDb();
      const where = and(eq(worklogs.userId, person.id), gte(worklogs.started, from), lt(worklogs.started, to));
      const [projects, topIssues] = await Promise.all([
        db
          .select({
            key: sql<string>`coalesce(max(${containers.key}), max(${worklogProjectKey}))`,
            name: sql<string>`coalesce(max(${containers.name}), max(${issues.projectName}), '')`,
            seconds: sql<number>`sum(${worklogs.timeSpentSeconds})::int`,
          })
          .from(worklogs)
          .leftJoin(issues, issueOfWorklog)
          .leftJoin(containers, eq(containers.id, issues.containerId))
          .where(where)
          .groupBy(projectGroup)
          .orderBy(sql`3 desc`)
          .limit(TOP),
        db
          .select({
            key: sql<string>`coalesce(max(${issues.key}), max(${worklogs.issueKey}))`,
            summary: sql<string>`coalesce(max(${issues.summary}), '')`,
            seconds: sql<number>`sum(${worklogs.timeSpentSeconds})::int`,
          })
          .from(worklogs)
          .leftJoin(issues, issueOfWorklog)
          .where(where)
          .groupBy(issueIdentity)
          .orderBy(sql`3 desc`)
          .limit(TOP),
      ]);
      return { projects, issues: topIssues };
    }),

  /**
   * One active account's day: its worklogs as the day timeline draws them,
   * its vacation as bare intervals (no note, no other kind), and the
   * schedule in force that day.
   */
  day: view
    .input(z.object({ userId: z.number().int().positive(), day: z.string().min(1) }))
    .query(async ({ input }) => {
      const day = parseDayKey(input.day);
      if (!day) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.reports.invalidRange") });
      const next = addDays(day, 1);
      const person = await activePerson(input.userId);
      const entries = await getDb()
        .select({
          id: worklogs.id,
          issueKey: worklogs.issueKey,
          connectionId: worklogs.connectionId,
          started: worklogs.started,
          seconds: worklogs.timeSpentSeconds,
          summary: issues.summary,
          remoteId: issues.remoteId,
        })
        .from(worklogs)
        .leftJoin(issues, issueOfWorklog)
        .where(and(eq(worklogs.userId, person.id), gte(worklogs.started, day), lt(worklogs.started, next)))
        .orderBy(asc(worklogs.started));
      const [versions, away, ownDays] = await Promise.all([scheduleVersionsOf([person.id]), vacations([person.id], day, next), dayOverridesOf([person.id])]);
      return {
        entries: entries.map((e) => ({
          id: String(e.id),
          issueKey: e.issueKey,
          connectionId: e.connectionId,
          remoteId: e.remoteId ?? undefined,
          summary: e.summary ?? undefined,
          start: e.started,
          seconds: e.seconds,
        })),
        away: (away.get(person.id) ?? []).map((v) => ({ startsAt: v.startsAt, endsAt: v.endsAt })),
        schedule: scheduleFor(day, versions.get(person.id) ?? [], ownDays.get(person.id)),
      };
    }),
});
