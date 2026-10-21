import { isClosed } from "@contracts/categories";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { containers, issues, worklogs } from "@db/schema";
import { addDays, dayKey, startOfDay, startOfWeek } from "@contracts/time";
import { issueOfWorklog, projectGroup, worklogProjectKey } from "./reports";
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

    // The hours worked: each day's entries, parallel work counted once (realSeconds).
    const entriesBetween = (from: Date, to: Date) =>
      db
        .select({ start: worklogs.started, seconds: worklogs.timeSpentSeconds })
        .from(worklogs)
        .where(and(eq(worklogs.userId, ctx.user.id), gte(worklogs.started, from), lt(worklogs.started, to)));
    const [todaySec, weekSec, monthSec] = await Promise.all(
      [
        [todayStart, tomorrowStart],
        [weekStart, weekEnd],
        [monthStart, monthEnd],
      ].map(async ([from, to]) => realSecondsTotal(await entriesBetween(from, to))),
    );

    // Hours per local day over the last 14 days
    const rangeStart = addDays(startOfDay(now), -13);
    const byDay = realSecondsByDay(await entriesBetween(rangeStart, tomorrowStart));
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
