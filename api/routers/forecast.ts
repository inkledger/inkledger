// When I'll finish (docs/work/ideas/estimates.md L2, R-3.17–R-3.20): my capacity ahead, the
// finish of what's open, and where my times are going; asked of the forecast sidecar.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, gte, inArray, isNull, lt, notInArray, sql, type SQL } from "drizzle-orm";
import { buckets, issues, plannedEntries, worklogs } from "@db/schema";
import { t } from "@contracts/i18n";
import { addDays, dayKey, parseDayKey, startOfDay, weekStartKey } from "@contracts/time";
import { scheduleFor, workBounds } from "@contracts/workSchedule";
import {
  capacityInput,
  cleanQuantiles,
  direction,
  finishDate,
  ForecastShapeError,
  weeklySeries,
  type ForecastDay,
  type Insufficient,
  type Weekly,
} from "@contracts/forecast";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issueKeyInput } from "../lib/inputs";
import { activeBucket, bucketQuery, coversIssue } from "../queries/buckets";
import { myRemoteIds } from "../providers/connections";
import { closedSamples, estimateForIssue } from "../estimates/estimate";
import { forecast, ForecastError, readiness, type ForecastRequest } from "../ml/forecast";
import { listScheduleVersions } from "./workSchedule";

const HISTORY_DAYS = 365;
const FINISH_DAYS = 90;
const TREND_WEEKS = 12;
const QUANTILES = [0.1, 0.5, 0.9];
const MAX_ISSUES = 200;

/** The sidecar's refusals as the API's errors (E-3.2–E-3.4, E-3.6). */
function asTrpc(e: unknown): never {
  if (e instanceof ForecastShapeError) throw new TRPCError({ code: "BAD_GATEWAY", message: t("server.forecast.bad") });
  if (!(e instanceof ForecastError)) throw e;
  if (e.kind === "off") throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.forecast.off") });
  if (e.kind === "notReady") throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.forecast.notReady") });
  if (e.kind === "slow") throw new TRPCError({ code: "TIMEOUT", message: t("server.forecast.slow") });
  throw new TRPCError({ code: "BAD_GATEWAY", message: t("server.forecast.bad") });
}

/** Asked only once the sidecar says it's ready (R-3.21). */
async function ready(): Promise<void> {
  const r = await readiness();
  if (!r.available) asTrpc(new ForecastError(r.reason === "off" ? "off" : "notReady", r.reason));
}

/** Each day from `from` for `n` days, as keys. */
const span = (from: Date, n: number) => Array.from({ length: n }, (_, i) => dayKey(addDays(from, i)));

/**
 * My capacity for `horizon` days from today (R-3.17, R-3.18): the 365 days up to yesterday of
 * logged hours (today isn't over: it would read as a short day), the work schedule and the
 * holidays on both sides, the model's answer cleaned.
 */
async function capacity(userId: number, horizon: number, now: number): Promise<ForecastDay[]> {
  const today = startOfDay(new Date(now));
  const first = addDays(today, -HISTORY_DAYS);
  const end = addDays(today, horizon);
  const [logs, holidays, versions] = await Promise.all([
    getDb()
      .select({ started: worklogs.started, seconds: worklogs.timeSpentSeconds })
      .from(worklogs)
      .where(and(eq(worklogs.userId, userId), gte(worklogs.started, first), lt(worklogs.started, today))),
    getDb()
      .select({ from: plannedEntries.startsAt, until: plannedEntries.endsAt })
      .from(plannedEntries)
      .where(and(eq(plannedEntries.userId, userId), eq(plannedEntries.kind, "vacation"), lt(plannedEntries.startsAt, end), sql`${plannedEntries.endsAt} > ${first.getTime()}`)),
    listScheduleVersions(userId),
  ]);
  const hours = new Map<string, number>();
  for (const l of logs) {
    const k = dayKey(new Date(l.started));
    hours.set(k, (hours.get(k) ?? 0) + l.seconds / 3600);
  }
  /** A day is off when a holiday covers its middle (half days still count as work). */
  const isOff = (key: string) => {
    const mid = parseDayKey(key)!.getTime() + 12 * 3_600_000;
    return holidays.some((h) => h.from.getTime() <= mid && mid < h.until.getTime());
  };
  const isWorkday = (key: string) => {
    const d = parseDayKey(key)!;
    return workBounds(d, scheduleFor(d, versions)) !== null;
  };
  const past = span(first, HISTORY_DAYS);
  const ahead = span(today, horizon);
  const input = capacityInput(
    { days: past, hours: past.map((k) => hours.get(k) ?? 0), workday: past.map((k) => (isWorkday(k) ? 1 : 0)), off: past.map((k) => (isOff(k) ? 1 : 0)) },
    { days: ahead, workday: ahead.map((k) => (isWorkday(k) ? 1 : 0)), off: ahead.map((k) => (isOff(k) ? 1 : 0)) },
  );
  const answer = await forecast({ ...input, freq: "D", horizon, quantiles: QUANTILES });
  const at = (q: number, i: number) => answer.quantiles[String(q)][i];
  return cleanQuantiles(
    ahead.map((day, i) => ({ day, p10: at(0.1, i), p50: at(0.5, i), p90: at(0.9, i) })),
    ahead.map((k) => isOff(k)),
  );
}

type Series = Weekly & { forecast: { week: string; p10: number; p50: number; p90: number }[]; direction: "better" | "worse" | "flat" };

/** A weekly series and its next 12 weeks (R-3.20), lower being better. */
async function trendOf(series: Weekly | Insufficient): Promise<Series | Insufficient> {
  if ("insufficient" in series) return series;
  const values = series.weeks.map((w) => w.value);
  const req: ForecastRequest = { series: values, freq: "W", horizon: TREND_WEEKS, quantiles: QUANTILES };
  const answer = await forecast(req);
  const last = series.weeks[series.weeks.length - 1].week;
  const weeks = Array.from({ length: TREND_WEEKS }, (_, i) => weekStartKey(addDays(parseDayKey(last)!, 7 * (i + 1))));
  const cleaned = cleanQuantiles(
    weeks.map((week, i) => ({ day: week, p10: answer.quantiles["0.1"][i], p50: answer.quantiles["0.5"][i], p90: answer.quantiles["0.9"][i] })),
    weeks.map(() => false),
  );
  return {
    weeks: series.weeks,
    forecast: cleaned.map(({ day, p10, p50, p90 }) => ({ week: day, p10, p50, p90 })),
    direction: direction(values[values.length - 1], cleaned[cleaned.length - 1].p50),
  };
}

const OPEN = (userId: number): SQL =>
  and(eq(issues.userId, userId), isNull(issues.goneAt), notInArray(issues.category, ["done", "cancelled"])) as SQL;

const id = z.number().int().positive();

export const forecastRouter = createRouter({
  /** Whether the forecast sections appear (R-3.21): the sidecar's /ready, or nothing when unset. */
  available: protectedProcedure.query(async () => {
    const r = await readiness();
    return r.available ? { available: true, model: r.model, reason: null } : { available: false, model: null, reason: r.reason };
  }),

  /** Hours I'll likely work each day ahead (R-3.17, R-3.18). */
  capacity: protectedProcedure.input(z.object({ days: z.number().int().min(7).max(90) })).query(async ({ ctx, input }) => {
    await ready();
    try {
      return { days: await capacity(ctx.user.id, input.days, Date.now()) };
    } catch (e) {
      asTrpc(e);
    }
  }),

  /**
   * When the open issues are done (R-3.19): their likely work left over my likely capacity, and a
   * cautious bound. The issues: a list, a bucket, or the active bucket (else mine) (Q12).
   */
  finish: protectedProcedure
    .input(
      z.union([
        z.object({ issues: z.array(z.object({ issueKey: issueKeyInput, connectionId: id })).min(1).max(MAX_ISSUES) }),
        z.object({ bucketId: id }),
        z.object({ scope: z.literal("active") }),
      ]),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      let scope: { kind: "list" } | { kind: "mine" } | { kind: "bucket"; id: number; name: string };
      let keys: { issueKey: string; connectionId: number }[];
      const bucketId = "bucketId" in input ? input.bucketId : "scope" in input ? await activeBucket(userId, ctx.deviceId) : null;
      if ("issues" in input) {
        scope = { kind: "list" };
        keys = input.issues;
      } else if (bucketId !== null) {
        const [b] = await getDb().select({ name: buckets.name }).from(buckets).where(and(eq(buckets.id, bucketId), eq(buckets.userId, userId)));
        if (!b) throw new TRPCError({ code: "NOT_FOUND" });
        scope = { kind: "bucket", id: bucketId, name: b.name };
        const narrowed = await bucketQuery(userId, bucketId);
        keys = await getDb()
          .select({ issueKey: issues.key, connectionId: issues.connectionId })
          .from(issues)
          .where(and(OPEN(userId), coversIssue(bucketId), narrowed))
          .limit(MAX_ISSUES);
      } else {
        scope = { kind: "mine" };
        const mine = await myRemoteIds(userId);
        keys = mine.length
          ? await getDb()
              .select({ issueKey: issues.key, connectionId: issues.connectionId })
              .from(issues)
              .where(and(OPEN(userId), inArray(issues.assigneeId, mine)))
              .limit(MAX_ISSUES)
          : [];
      }
      await ready();
      const now = Date.now();
      // What each issue still needs (Q13): its estimate minus every worklog of mine on it.
      const spent = keys.length
        ? await getDb()
            .select({ key: worklogs.issueKey, connectionId: worklogs.connectionId, seconds: sql<number>`sum(${worklogs.timeSpentSeconds})::int` })
            .from(worklogs)
            .where(and(eq(worklogs.userId, userId), inArray(worklogs.issueKey, keys.map((k) => k.issueKey))))
            .groupBy(worklogs.issueKey, worklogs.connectionId)
        : [];
      const spentOn = (k: { issueKey: string; connectionId: number }) => spent.find((s) => s.key === k.issueKey && s.connectionId === k.connectionId)?.seconds ?? 0;
      let workP50 = 0;
      let workP80 = 0;
      const unknownKeys: string[] = [];
      const overKeys: string[] = [];
      let counted = 0;
      for (const k of keys) {
        const e = await estimateForIssue(userId, k, now).catch(() => null);
        if (!e || "hidden" in e) {
          if (!e) unknownKeys.push(k.issueKey);
          continue;
        }
        if (e.none) {
          unknownKeys.push(k.issueKey);
          continue;
        }
        counted++;
        const done = spentOn(k);
        if (done >= e.p50) overKeys.push(k.issueKey);
        workP50 += Math.max(0, e.p50 - done);
        workP80 += Math.max(0, e.p80 - done);
      }
      try {
        const days = await capacity(userId, FINISH_DAYS, now);
        const hours = { p50: workP50 / 3600, p80: workP80 / 3600 };
        return {
          scope,
          ...finishDate(days, hours.p50, hours.p80),
          counted,
          unknown: unknownKeys.length,
          unknownKeys,
          overKeys,
          workP50Hours: hours.p50,
          workP80Hours: hours.p80,
        };
      } catch (e) {
        asTrpc(e);
      }
    }),

  /** Where my times are going (R-3.20): work per issue, and over the tracker's estimate, by week. */
  trend: protectedProcedure.query(async ({ ctx }) => {
    const now = Date.now();
    const series = weeklySeries(await closedSamples(ctx.user.id, now), now);
    // Nothing to forecast: no need to ask the sidecar.
    const { work, ratio } = series;
    if ("insufficient" in work && "insufficient" in ratio) return { work, ratio };
    await ready();
    try {
      return { work: await trendOf(series.work), ratio: await trendOf(series.ratio) };
    } catch (e) {
      asTrpc(e);
    }
  }),
});
