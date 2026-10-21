import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { clientContainers, clients, connections, containers, issues, worklogs } from "@db/schema";
import { providerName } from "@contracts/providerNames";
import { addDays, dayKey, parseDayKey } from "@contracts/time";
import { realSecondsByDay, realSecondsTotal } from "@contracts/placement";
import { t } from "@contracts/i18n";
import { issueOfWorklog, worklogScope } from "../queries/worklogScope";

/** A key's project, when its issue isn't in the catalogue: APP of APP-12, owner/repo of owner/repo#12. */
const keyProject = sql`(CASE WHEN ${worklogs.issueKey} LIKE '%#%' THEN split_part(${worklogs.issueKey}, '#', 1) ELSE split_part(${worklogs.issueKey}, '-', 1) END)`;

/**
 * Project key of a worklog: the issue's project when the issue is known
 * locally, else the issue-key prefix ("ABC-12" → "ABC", "owner/repo#12" →
 * "owner/repo"), so time logged on issues no longer synced still lands on
 * its project.
 */
export const worklogProjectKey = sql<string>`coalesce(${issues.projectKey}, ${keyProject})`;

export { issueOfWorklog };

/** One issue, whoever's key: its catalogue row, else its connection and key. */
const issueIdentity = sql<string>`coalesce(${issues.id}::text, 'k:' || ${worklogs.connectionId} || ':' || ${worklogs.issueKey})`;

/** A worklog's project: its issue's container, else the issue-key prefix. */
export const projectGroup = sql<string>`coalesce(${containers.id}::text, 'k:' || ${keyProject})`;

/** Longest report span: a leap year. */
export const REPORT_MAX_DAYS = 366;

const rangeInput = z.object({
  /** First day included, "YYYY-MM-DD" (local) */
  from: z.string().min(1),
  /** Last day included, "YYYY-MM-DD" (local) */
  to: z.string().min(1),
  /** D9: this device's bucket, or all the time (the default) */
  scope: z.enum(["bucket", "all"]).default("all"),
  /** The search language, on the worklogs' issues */
  search: z.string().trim().max(500).optional(),
});

/** Inclusive day-key range → [from, to) dates, or BAD_REQUEST. */
function rangeOf(input: { from: string; to: string }): { from: Date; to: Date } {
  const from = parseDayKey(input.from);
  const lastDay = parseDayKey(input.to);
  const to = lastDay ? addDays(lastDay, 1) : null;
  if (!from || !to || from >= to) {
    throw new TRPCError({ code: "BAD_REQUEST", message: t("server.reports.invalidRange") });
  }
  if (to > addDays(from, REPORT_MAX_DAYS)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: t("server.reports.rangeTooLong", { count: REPORT_MAX_DAYS }),
    });
  }
  return { from, to };
}

type Row = {
  key: string;
  label: string;
  seconds: number;
  entries: number;
  /** An issue row: its identity (two trackers may share a key), its link, its tracker and container (CSV, last columns) */
  id?: string;
  connectionId?: number | null;
  remoteId?: string | null;
  tracker?: string;
  container?: string;
};

/** The user's trackers by connection, as a report names them (its label, else its service). */
async function trackerNames(userId: number): Promise<Map<number, string>> {
  const rows = await getDb().select({ id: connections.id, type: connections.type, label: connections.label }).from(connections).where(eq(connections.userId, userId));
  return new Map(rows.map((c) => [c.id, c.label || providerName(c.type)]));
}

/**
 * A range's hours: worked (parallel work once, realSeconds) and logged (the
 * entries' sum, what the rows add up to); they differ only by parallel work.
 */
function hoursOf(logs: { started: Date; seconds: number }[]): { totalSeconds: number; loggedSeconds: number } {
  return {
    totalSeconds: realSecondsTotal(logs.map((w) => ({ start: w.started, seconds: w.seconds }))),
    loggedSeconds: logs.reduce((a, w) => a + w.seconds, 0),
  };
}

const bySecondsDesc = (a: Row, b: Row) => b.seconds - a.seconds || a.key.localeCompare(b.key);

export const reportsRouter = createRouter({
  /**
   * Worklog report for a date range, grouped by day, issue or project.
   * Includes per-group totals and a grand total.
   */
  generate: protectedProcedure
    .input(rangeInput.extend({ groupBy: z.enum(["day", "issue", "project", "client"]).default("day") }))
    .query(async ({ ctx, input }) => {
      const { from, to } = rangeOf(input);
      const db = getDb();
      const scoped = await worklogScope(ctx.user.id, ctx.deviceId, input);
      const baseConds = [
        eq(worklogs.userId, ctx.user.id),
        gte(worklogs.started, from),
        lt(worklogs.started, to),
        ...scoped.where,
      ];
      const query = { unsupported: scoped.unsupported };
      const logs = await db
        .select({ started: worklogs.started, seconds: worklogs.timeSpentSeconds })
        .from(worklogs)
        .where(and(...baseConds));
      const hours = hoursOf(logs);

      if (input.groupBy === "day") {
        // A day's hours are the hours worked that day (parallel work once).
        const worked = realSecondsByDay(logs.map((w) => ({ start: w.started, seconds: w.seconds })));
        const byDay = new Map<string, { seconds: number; entries: number }>();
        for (const w of logs) {
          const key = dayKey(w.started);
          const acc = byDay.get(key) ?? { seconds: worked.get(key) ?? 0, entries: 0 };
          acc.entries += 1;
          byDay.set(key, acc);
        }
        const rows = [...byDay.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => ({ key, label: key, ...v }));
        return {
          groupBy: input.groupBy,
        query,
          rows,
          ...hours,
          totalEntries: rows.reduce((a, r) => a + r.entries, 0),
        };
      }

      if (input.groupBy === "issue") {
        const rows = await db
          .select({
            group: sql<string>`coalesce(max(${issues.key}), max(${worklogs.issueKey}))`,
            summary: sql<string>`max(${issues.summary})`,
            seconds: sql<number>`sum(${worklogs.timeSpentSeconds})`,
            entries: sql<number>`count(*)`,
            id: issueIdentity,
            connectionId: sql<number | null>`max(${worklogs.connectionId})`,
            remoteId: sql<string | null>`max(${issues.remoteId})`,
            container: sql<string>`coalesce(max(${containers.key}), max(${worklogProjectKey}))`,
          })
          .from(worklogs)
          .leftJoin(issues, issueOfWorklog)
          .leftJoin(containers, eq(containers.id, issues.containerId))
          .where(and(...baseConds))
          // One row per issue, by its identity (its connection and key for one not in the catalogue)
          .groupBy(issueIdentity)
          .orderBy(sql`3 desc`);
        const names = await trackerNames(ctx.user.id);
        return {
          groupBy: input.groupBy,
        query,
          rows: rows.map((r) => ({
            key: r.group,
            label: r.summary ? `${r.group} — ${r.summary}` : r.group,
            seconds: r.seconds,
            entries: r.entries,
            id: r.id,
            connectionId: r.connectionId,
            remoteId: r.remoteId,
            tracker: r.connectionId !== null ? (names.get(r.connectionId) ?? "") : "",
            container: r.container,
          })),
          ...hours,
          totalEntries: rows.reduce((a, r) => a + r.entries, 0),
        };
      }

      if (input.groupBy === "client") {
        // Hours per client (§4.7): the client of the worklog's project; the rest together, unnamed.
        const rows = await db
          .select({
            group: sql<string>`coalesce(${clients.id}::text, '')`,
            name: sql<string>`coalesce(max(${clients.name}), '')`,
            seconds: sql<number>`sum(${worklogs.timeSpentSeconds})`,
            entries: sql<number>`count(*)`,
          })
          .from(worklogs)
          .leftJoin(issues, issueOfWorklog)
          .leftJoin(clientContainers, eq(clientContainers.containerId, issues.containerId))
          .leftJoin(clients, eq(clients.id, clientContainers.clientId))
          .where(and(...baseConds))
          .groupBy(sql`coalesce(${clients.id}::text, '')`)
          .orderBy(sql`3 desc`);
        return {
          groupBy: input.groupBy,
        query,
          rows: rows.map((r) => ({ key: r.group || "none", label: r.name || t("server.reports.noClient"), seconds: r.seconds, entries: r.entries })),
          ...hours,
          totalEntries: rows.reduce((a, r) => a + r.entries, 0),
        };
      }

      // groupBy project
      const rows = await db
        .select({
          group: sql<string>`coalesce(max(${containers.key}), max(${worklogProjectKey}))`,
          name: sql<string>`coalesce(max(${containers.name}), max(${issues.projectName}), '')`,
          seconds: sql<number>`sum(${worklogs.timeSpentSeconds})`,
          entries: sql<number>`count(*)`,
        })
        .from(worklogs)
        .leftJoin(issues, issueOfWorklog)
        .leftJoin(containers, eq(containers.id, issues.containerId))
        .where(and(...baseConds))
        .groupBy(projectGroup)
        .orderBy(sql`3 desc`);
      return {
        groupBy: input.groupBy,
        query,
        rows: rows.map((r) => ({
          key: r.group,
          label: r.name ? `${r.group} — ${r.name}` : r.group,
          seconds: r.seconds,
          entries: r.entries,
        })),
        ...hours,
        totalEntries: rows.reduce((a, r) => a + r.entries, 0),
      };
    }),

  /**
   * Day-by-day breakdown of a range: per day, the issues worked with their
   * time merged; plus the per-issue totals over the whole range.
   */
  daily: protectedProcedure.input(rangeInput).query(async ({ ctx, input }) => {
    const { from, to } = rangeOf(input);
    const scoped = await worklogScope(ctx.user.id, ctx.deviceId, input);
    const logs = await getDb()
      .select({
        issueKey: worklogs.issueKey,
        summary: issues.summary,
        started: worklogs.started,
        seconds: worklogs.timeSpentSeconds,
        id: issueIdentity,
        connectionId: worklogs.connectionId,
        remoteId: issues.remoteId,
        container: sql<string>`coalesce(${containers.key}, ${worklogProjectKey})`,
      })
      .from(worklogs)
      .leftJoin(issues, issueOfWorklog)
      .leftJoin(containers, eq(containers.id, issues.containerId))
      .where(and(eq(worklogs.userId, ctx.user.id), gte(worklogs.started, from), lt(worklogs.started, to), ...scoped.where));
    const names = await trackerNames(ctx.user.id);

    // Merged per issue by its identity: two trackers' APP-1 stay two rows.
    const add = (m: Map<string, Row>, w: (typeof logs)[number]) => {
      const label = w.summary ? `${w.issueKey} — ${w.summary}` : w.issueKey;
      const r = m.get(w.id) ?? {
        key: w.issueKey,
        label,
        seconds: 0,
        entries: 0,
        id: w.id,
        connectionId: w.connectionId,
        remoteId: w.remoteId,
        tracker: names.get(w.connectionId) ?? "",
        container: w.container,
      };
      m.set(w.id, { ...r, seconds: r.seconds + w.seconds, entries: r.entries + 1 });
    };
    const days = new Map<string, Map<string, Row>>();
    const total = new Map<string, Row>();
    for (const w of logs) {
      const day = dayKey(w.started);
      const m = days.get(day) ?? new Map<string, Row>();
      days.set(day, m);
      add(m, w);
      add(total, w);
    }
    const rangeIssues = [...total.values()].sort(bySecondsDesc);
    const worked = realSecondsByDay(logs.map((w) => ({ start: w.started, seconds: w.seconds })));
    return {
      days: [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, m]) => {
          const rows = [...m.values()].sort(bySecondsDesc);
          return {
            day,
            // The hours worked that day; its issues keep their own (they may run in parallel).
            seconds: worked.get(day) ?? 0,
            loggedSeconds: rows.reduce((a, r) => a + r.seconds, 0),
            entries: rows.reduce((a, r) => a + r.entries, 0),
            issues: rows,
          };
        }),
      issues: rangeIssues,
      ...hoursOf(logs),
      totalEntries: rangeIssues.reduce((a, r) => a + r.entries, 0),
      query: { unsupported: scoped.unsupported },
    };
  }),
});
