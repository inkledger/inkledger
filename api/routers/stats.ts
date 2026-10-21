import { isClosed } from "@contracts/categories";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { containers, issues, worklogs } from "@db/schema";
import { addDays, dayKey, startOfDay, startOfWeek } from "@contracts/time";
import { issueOfWorklog, projectGroup, worklogProjectKey } from "./reports";
import { clockSeconds } from "@contracts/placement";
import { getSettings } from "./settings";

export const statsRouter = createRouter({
  dashboard: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const now = new Date();
    const weekStart = startOfWeek(now);
    const weekEnd = addDays(weekStart, 7);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const todayStart = startOfDay(now);
    const tomorrowStart = addDays(todayStart, 1);

    const sumWhere = async (from: Date, to: Date) => {
      const conds = [
        eq(worklogs.userId, ctx.user.id),
        gte(worklogs.started, from),
        lt(worklogs.started, to),
      ];
      const rows = await db
        .select({ total: sql<number>`coalesce(sum(${worklogs.timeSpentSeconds}), 0)` })
        .from(worklogs)
        .where(and(...conds));
      return rows[0]?.total ?? 0;
    };

    // Goals by clock time: each day's union of entries (parallel work once).
    const basis = (await getSettings(ctx.user.id)).goalBasis === "clock" ? "clock" : "logged";
    const clockBetween = async (from: Date, to: Date) => {
      const rows = await db
        .select({ started: worklogs.started, seconds: worklogs.timeSpentSeconds })
        .from(worklogs)
        .where(and(eq(worklogs.userId, ctx.user.id), gte(worklogs.started, from), lt(worklogs.started, to)));
      const days = new Map<string, { start: Date; seconds: number }[]>();
      for (const r of rows) {
        const k = dayKey(r.started);
        days.set(k, [...(days.get(k) ?? []), { start: r.started, seconds: r.seconds }]);
      }
      return days;
    };
    const total = (days: Map<string, { start: Date; seconds: number }[]>) => [...days.values()].reduce((a, d) => a + clockSeconds(d), 0);
    const [todaySec, weekSec, monthSec] =
      basis === "clock"
        ? await Promise.all([clockBetween(todayStart, tomorrowStart), clockBetween(weekStart, weekEnd), clockBetween(monthStart, monthEnd)]).then((d) => d.map(total))
        : await Promise.all([sumWhere(todayStart, tomorrowStart), sumWhere(weekStart, weekEnd), sumWhere(monthStart, monthEnd)]);

    // Hours per local day over the last 14 days
    const rangeStart = addDays(startOfDay(now), -13);
    const recent = await db
      .select({ started: worklogs.started, seconds: worklogs.timeSpentSeconds })
      .from(worklogs)
      .where(
        and(
          eq(worklogs.userId, ctx.user.id),
          gte(worklogs.started, rangeStart),
          lt(worklogs.started, tomorrowStart),
        ),
      );
    const byDay = new Map<string, number>();
    if (basis === "clock") {
      const grouped = new Map<string, { start: Date; seconds: number }[]>();
      for (const w of recent) grouped.set(dayKey(w.started), [...(grouped.get(dayKey(w.started)) ?? []), { start: w.started, seconds: w.seconds }]);
      for (const [k, items] of grouped) byDay.set(k, clockSeconds(items));
    } else {
      for (const w of recent) {
        const key = dayKey(w.started);
        byDay.set(key, (byDay.get(key) ?? 0) + w.seconds);
      }
    }
    const perDay = Array.from({ length: 14 }, (_, i) => {
      const key = dayKey(addDays(rangeStart, i));
      return { date: key, seconds: byDay.get(key) ?? 0 };
    });

    // Hours per project (this month); worklogs on issues not synced locally
    // count under their issue-key prefix, as in reports.
    const perProject = await db
      .select({
        projectKey: sql<string>`coalesce(max(${containers.key}), max(${worklogProjectKey}))`,
        projectName: sql<string>`coalesce(max(${containers.name}), max(${issues.projectName}), '')`,
        total: sql<number>`sum(${worklogs.timeSpentSeconds})`,
      })
      .from(worklogs)
      .leftJoin(issues, issueOfWorklog)
      .leftJoin(containers, eq(containers.id, issues.containerId))
      .where(
        and(
          eq(worklogs.userId, ctx.user.id),
          gte(worklogs.started, monthStart),
          lt(worklogs.started, monthEnd),
        ),
      )
      .groupBy(projectGroup)
      .orderBy(sql`sum(${worklogs.timeSpentSeconds}) desc`)
      .limit(8);

    // Issue counts by status category
    const byCategory = await db
      .select({
        category: issues.category,
        count: sql<number>`count(*)`,
      })
      .from(issues)
      // hidden issues are out of the user's view: out of the counts too
      .where(and(eq(issues.userId, ctx.user.id), eq(issues.hidden, 0)))
      .groupBy(issues.category);

    const totalIssues = byCategory.reduce((acc, r) => acc + r.count, 0);

    return {
      goalBasis: basis,
      todaySeconds: todaySec,
      weekSeconds: weekSec,
      monthSeconds: monthSec,
      perDay,
      perProject: perProject.map((p) => ({
        projectKey: p.projectKey,
        projectName: p.projectName,
        seconds: p.total,
      })),
      issueCount: totalIssues,
      openIssueCount: byCategory
        .filter((c) => !isClosed(c.category))
        .reduce((acc, r) => acc + r.count, 0),
    };
  }),
});
