import { isClosed } from "@contracts/categories";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { containers, issues, worklogs } from "@db/schema";
import { addDays, dayKey, startOfDay, startOfWeek } from "@contracts/time";
import { issueOfWorklog, projectGroup, worklogProjectKey } from "./reports";
import { onLiveConnection } from "../queries/liveConnections";
import { realSecondsByDay, realSecondsTotal } from "@contracts/placement";

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

    // Hours per local day over the last 14 days
    const rangeStart = addDays(startOfDay(now), -13);

    // The hours worked: each day's entries, parallel work counted once (realSeconds).
    // One read over the span all four periods share, sliced in memory.
    const spanStart = new Date(Math.min(todayStart.getTime(), weekStart.getTime(), monthStart.getTime(), rangeStart.getTime()));
    const spanEnd = new Date(Math.max(tomorrowStart.getTime(), weekEnd.getTime(), monthEnd.getTime()));
    const entriesInSpan = db
      .select({ start: worklogs.started, seconds: worklogs.timeSpentSeconds })
      .from(worklogs)
      .where(and(eq(worklogs.userId, ctx.user.id), gte(worklogs.started, spanStart), lt(worklogs.started, spanEnd)));

    // All independent reads: one round trip of the pool, not one after another.
    const [spanEntries, perProject, byCategory] = await Promise.all([
      entriesInSpan,
      // Hours per project (this month); worklogs on issues not synced locally
      // count under their issue-key prefix, as in reports.
      db
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
        .limit(8),
      // Issue counts by status category
      db
        .select({
          category: issues.category,
          count: sql<number>`count(*)`,
        })
        .from(issues)
        // hidden issues are out of the user's view: out of the counts too, as gone ones and those of archived connections
        .where(and(eq(issues.userId, ctx.user.id), eq(issues.hidden, 0), onLiveConnection))
        .groupBy(issues.category),
    ]);

    const between = (from: Date, to: Date) => spanEntries.filter((e) => e.start >= from && e.start < to);
    const todaySec = realSecondsTotal(between(todayStart, tomorrowStart));
    const weekSec = realSecondsTotal(between(weekStart, weekEnd));
    const monthSec = realSecondsTotal(between(monthStart, monthEnd));
    const byDay = realSecondsByDay(between(rangeStart, tomorrowStart));
    const perDay = Array.from({ length: 14 }, (_, i) => {
      const key = dayKey(addDays(rangeStart, i));
      return { date: key, seconds: byDay.get(key) ?? 0 };
    });

    const totalIssues = byCategory.reduce((acc, r) => acc + r.count, 0);

    return {
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
