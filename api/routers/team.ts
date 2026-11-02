// The team report, for whoever may see everyone's time (viewTeamTime): each
// active account's logged hours over a range, day by day, against its own
// target, and one account's day. Read only; nothing here changes anyone's time.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, gte, inArray, isNull, lt } from "drizzle-orm";
import { issues, plannedEntries, users, worklogs } from "@db/schema";
import { addDays, dayKey, parseDayKey } from "@contracts/time";
import { effectiveTargetSeconds, scheduleFor } from "@contracts/workSchedule";
import type { PlannedInterval } from "@contracts/planned";
import { t } from "@contracts/i18n";
import { createRouter, permProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issueOfWorklog } from "../queries/worklogScope";
import { scheduleVersionsOf, timeFreshness } from "../queries/teamTime";
import { rangeOf } from "./reports";

const view = permProcedure("viewTeamTime");

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

export const teamRouter = createRouter({
  /**
   * Every active account over a range (inclusive day keys): its logged
   * seconds per day and in all, its target (schedule minus vacation), and
   * how fresh its time is. Most hours first.
   */
  overview: view
    .input(z.object({ from: z.string().min(1), to: z.string().min(1) }))
    .query(async ({ input }) => {
      const { from, to } = rangeOf(input);
      const db = getDb();
      const people = await db
        .select({ id: users.id, displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl })
        .from(users)
        .where(isNull(users.disabledAt))
        .orderBy(asc(users.id));
      const ids = people.map((p) => p.id);
      const logs = ids.length === 0
        ? []
        : await db
            .select({ userId: worklogs.userId, started: worklogs.started, seconds: worklogs.timeSpentSeconds })
            .from(worklogs)
            .where(and(inArray(worklogs.userId, ids), gte(worklogs.started, from), lt(worklogs.started, to)));
      const [fresh, versions, away] = await Promise.all([timeFreshness(ids), scheduleVersionsOf(ids), vacations(ids, from, to)]);

      const days: Date[] = [];
      for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
      // Logged: the entries' plain sum (what was booked), by the server's local day as in Reports.
      const logged = new Map<number, Map<string, number>>(ids.map((id) => [id, new Map()]));
      for (const w of logs) {
        const m = logged.get(w.userId);
        if (!m) continue;
        const key = dayKey(w.started);
        m.set(key, (m.get(key) ?? 0) + w.seconds);
      }

      const rows = people.map((p) => {
        const mine = logged.get(p.id) ?? new Map<string, number>();
        const planned = away.get(p.id) ?? [];
        const schedules = versions.get(p.id) ?? [];
        const perDay = days.map((d) => ({
          day: dayKey(d),
          loggedSeconds: mine.get(dayKey(d)) ?? 0,
          targetSeconds: effectiveTargetSeconds(d, scheduleFor(d, schedules), planned),
        }));
        const loggedSeconds = perDay.reduce((a, d) => a + d.loggedSeconds, 0);
        const targetSeconds = perDay.reduce((a, d) => a + d.targetSeconds, 0);
        return {
          userId: p.id,
          displayName: p.displayName || p.username || "",
          avatarUrl: p.avatarUrl,
          freshness: fresh.get(p.id) ?? { state: "local" as const, at: null },
          loggedSeconds,
          targetSeconds,
          /** Logged over target (1 = all of it); null with nothing expected */
          coverage: targetSeconds > 0 ? loggedSeconds / targetSeconds : null,
          days: perDay,
        };
      });
      rows.sort((a, b) => b.loggedSeconds - a.loggedSeconds || a.displayName.localeCompare(b.displayName));
      return {
        people: rows,
        loggedSeconds: rows.reduce((a, r) => a + r.loggedSeconds, 0),
        targetSeconds: rows.reduce((a, r) => a + r.targetSeconds, 0),
      };
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
      const db = getDb();
      const [person] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, input.userId), isNull(users.disabledAt)))
        .limit(1);
      if (!person) throw new TRPCError({ code: "NOT_FOUND", message: t("server.team.notFound") });
      const entries = await db
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
      const [versions, away] = await Promise.all([scheduleVersionsOf([person.id]), vacations([person.id], day, next)]);
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
        schedule: scheduleFor(day, versions.get(person.id) ?? []),
      };
    }),
});
