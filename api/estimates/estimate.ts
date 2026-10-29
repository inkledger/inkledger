// How long an issue will take, from my closed issues (docs/work/ideas/estimates.md
// R-3.1–R-3.10, R-3.15). An answer reads the user's revision, then, unless it is
// cached at that revision, everything it needs in one query: the target, the
// newest 2000 candidates with their worklogs and status changes, and what each
// status is (snapshots, synced issues) and whether it counts (work_statuses).
import { TRPCError } from "@trpc/server";
import { t } from "@contracts/i18n";
import {
  backtest,
  countsAsWork,
  estimate,
  recencyWeight,
  usableSummary,
  weightedQuantile,
  winsorize,
  workSeconds,
  workStretches,
  MIN_SAMPLES,
  SIMILAR_TITLE,
  type Backtest,
  type Estimate,
  type Sample,
  type StatusChange,
} from "@contracts/estimate";
import { q } from "../queries/connection";
import { estimateRevision } from "../queries/estimateRevision";

/** Candidates of one estimate: my closed issues with my time, the newest first (R-3.2) */
export const UNIVERSE = 2000;
const TTL_MS = 10 * 60_000;
/** The backtest's window (R-3.16) */
const BACKTEST_WINDOW_MS = 90 * 24 * 3_600_000;
/** Less than this is not work worth a sample (R-3.1) */
const MIN_WORK_SECONDS = 300;

export type Excluded = { pending: number; stale: number; retry: number; invalid: number };
export type IssueEstimate = (Estimate & { excluded: Excluded }) | { hidden: "closed" };
export type TodoEstimate = IssueEstimate | { todoRatio: number; n: number } | { none: true; n: number };

/**
 * Answers per user, kept while the user's revision stays the same and for at
 * most 10 minutes. Each server process has its own: the revision, read first,
 * is what tells it about another one's writes.
 */
export class EstimateCache {
  private readonly users = new Map<number, { revision: string; entries: Map<string, { at: number; value: unknown }> }>();

  get<T>(userId: number, revision: bigint, key: string, now: number): T | undefined {
    const u = this.users.get(userId);
    if (!u || u.revision !== revision.toString()) return undefined;
    const e = u.entries.get(key);
    return e && now - e.at < TTL_MS ? (e.value as T) : undefined;
  }

  set(userId: number, revision: bigint, key: string, now: number, value: unknown): void {
    let u = this.users.get(userId);
    if (!u || u.revision !== revision.toString()) {
      u = { revision: revision.toString(), entries: new Map() };
      this.users.set(userId, u);
    }
    u.entries.set(key, { at: now, value });
  }
}

export const defaultCache = new EstimateCache();

type Row = {
  target: { id: number; summary: string; type: string | null; components: string; container_id: number | null; time_estimate_seconds: number | null; category: string }[] | null;
  samples:
    | {
        id: number;
        connection_id: number;
        type: string | null;
        components: string;
        container_id: number | null;
        time_estimate_seconds: number | null;
        created_at: number | null;
        state: string;
        read_at: number | null;
        status_id_at_read: string | null;
        similarity: number | null;
        worklogs: { started: number; seconds: number }[];
        changes: { at: number; ordinal: number; from: string | null; to: string }[] | null;
      }[]
    | null;
  statuses: { connection_id: number; id: string; category: string }[] | null;
  choices: { connection_id: number; id: string; counts: number }[] | null;
  /** Accuracy only: [case id, earlier id, similarity] of titles alike in one project */
  pairs?: [number, number, number][] | null;
};

/** My closed issues with my time, the newest UNIVERSE by my latest worklog on each (R-3.2). */
const CANDIDATES = `cand AS (
  SELECT i."id", i."connection_id", nullif(i."issue_type", '') AS "type", i."components", i."container_id", i."time_estimate_seconds",
         i."summary", i."jira_created_at" AS "created_at", coalesce(r."state", 'pending') AS "state", r."read_at", r."status_id_at_read",
         max(w."started") AS "last_worklog"
  FROM "issues" i
  JOIN "worklogs" w ON w."item_id" = i."id" AND w."user_id" = i."user_id"
  LEFT JOIN "issue_history_reads" r ON r."item_id" = i."id"
  WHERE i."user_id" = $1 AND i."category" = 'done' AND i."gone_at" IS NULL
  GROUP BY i."id", r."item_id"
  ORDER BY "last_worklog" DESC, i."id" DESC
  LIMIT ${UNIVERSE}
)`;

/** Each candidate with its worklogs and, when its history is proven, its status changes; `similarity` as given. */
const samplesOfCand = (similarity: string) => `(SELECT json_agg(json_build_object(
     'id', c."id", 'connection_id', c."connection_id", 'type', c."type", 'components', c."components", 'container_id', c."container_id",
     'time_estimate_seconds', c."time_estimate_seconds", 'created_at', c."created_at", 'state', c."state", 'read_at', c."read_at",
     'status_id_at_read', c."status_id_at_read", 'similarity', ${similarity},
     'worklogs', (SELECT json_agg(json_build_object('started', w."started", 'seconds', w."time_spent_seconds")) FROM "worklogs" w WHERE w."item_id" = c."id" AND w."user_id" = $1),
     'changes', CASE WHEN c."state" = 'available' THEN (SELECT json_agg(json_build_object('at', x."at", 'ordinal', x."ordinal", 'from', x."from_status_id", 'to', x."to_status_id") ORDER BY x."ordinal") FROM "issue_status_changes" x WHERE x."item_id" = c."id") END))`;

/** What each status of the candidates' connections is (snapshots, else synced issues), and the user's choices. */
const STATUSES_AND_CHOICES = `
  (SELECT json_agg(json_build_object('connection_id', k."connection_id", 'id', k."id", 'category', k."category")) FROM (
     SELECT s."connection_id", s."status_id" AS "id", s."category" FROM "status_snapshots" s WHERE s."connection_id" IN (SELECT DISTINCT "connection_id" FROM cand)
     UNION
     SELECT DISTINCT i."connection_id", i."status_id", i."category" FROM "issues" i
     WHERE i."user_id" = $1 AND i."status_id" IS NOT NULL AND i."connection_id" IN (SELECT DISTINCT "connection_id" FROM cand)
       AND NOT EXISTS (SELECT 1 FROM "status_snapshots" s WHERE s."connection_id" = i."connection_id" AND s."status_id" = i."status_id")) k) AS "statuses",
  (SELECT json_agg(json_build_object('connection_id', ws."connection_id", 'id', ws."status_id", 'counts', ws."counts")) FROM "work_statuses" ws WHERE ws."user_id" = $1) AS "choices"`;

const SAMPLES_SQL = `
WITH target AS (
  SELECT i."id", i."summary", nullif(i."issue_type", '') AS "type", i."components", i."container_id", i."time_estimate_seconds", i."category"
  FROM "issues" i
  WHERE i."user_id" = $1 AND i."key" = $2 AND ($3::integer IS NULL OR i."connection_id" = $3) AND i."gone_at" IS NULL
  LIMIT 2
), one AS (
  SELECT "summary" FROM target LIMIT 1
), ${CANDIDATES}
SELECT
  (SELECT json_agg(row_to_json(target)) FROM target) AS "target",
  ${samplesOfCand(`(SELECT CASE WHEN length(btrim(c."summary")) >= 3 AND length(btrim(o."summary")) >= 3 THEN similarity(c."summary", o."summary") END FROM one o)`)} FROM cand c) AS "samples",
  ${STATUSES_AND_CHOICES}`;

/** The backtest's: every candidate, and the pairs titled alike in one project (T0) for the cases of the window. */
const ACCURACY_SQL = `
WITH ${CANDIDATES}, pairs AS (
  SELECT a."id" AS "a", b."id" AS "b", similarity(a."summary", b."summary") AS "s"
  FROM cand a JOIN cand b ON b."container_id" = a."container_id" AND b."id" <> a."id"
  WHERE a."last_worklog" >= $2 AND length(btrim(a."summary")) >= 3 AND length(btrim(b."summary")) >= 3 AND similarity(a."summary", b."summary") >= ${SIMILAR_TITLE}
)
SELECT
  NULL AS "target",
  ${samplesOfCand("NULL")} FROM cand c) AS "samples",
  ${STATUSES_AND_CHOICES},
  (SELECT json_agg(json_build_array(p."a", p."b", p."s")) FROM pairs p) AS "pairs"`;

const jsonList = (text: string): string[] => {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** Whether each status counts as work, per connection: the user's choice, else the provider's default (R-3.14); null when nothing places it. */
export function classifier(statuses: Row["statuses"], choices: Row["choices"]): (connectionId: number, statusId: string) => boolean | null {
  const category = new Map<string, string>();
  const hasDoing = new Set<number>();
  for (const s of statuses ?? []) {
    const k = `${s.connection_id}:${s.id}`;
    if (!category.has(k)) category.set(k, s.category);
    if (s.category === "doing") hasDoing.add(s.connection_id);
  }
  const chosen = new Map((choices ?? []).map((c) => [`${c.connection_id}:${c.id}`, c.counts === 1]));
  return (connectionId, statusId) => {
    const k = `${connectionId}:${statusId}`;
    const c = category.get(k);
    if (c === undefined) return null;
    return countsAsWork({ category: c, hasDoing: hasDoing.has(connectionId), override: chosen.get(k) });
  };
}

/** The samples of R-3.1 and the candidates left out by their history's state (R-3.2, R-3.4). */
function samplesOf(row: Row): { samples: (Sample & { id: number })[]; excluded: Excluded } {
  const classify = classifier(row.statuses, row.choices);
  const excluded: Excluded = { pending: 0, stale: 0, retry: 0, invalid: 0 };
  const samples: (Sample & { id: number })[] = [];
  for (const c of row.samples ?? []) {
    const worklogs = c.worklogs ?? [];
    let counted: { started: number; seconds: number }[];
    if (c.state === "unsupported") counted = worklogs;
    else if (c.state === "available") {
      const changes: StatusChange[] = (c.changes ?? []).map((x) => ({ at: Number(x.at), ordinal: x.ordinal, from: x.from, to: x.to }));
      const check = workStretches({
        changes,
        createdAt: c.created_at === null ? 0 : Number(c.created_at),
        readAt: c.read_at === null ? Number.MAX_SAFE_INTEGER : Number(c.read_at),
        statusNow: c.status_id_at_read ?? "",
        classify: (id) => classify(c.connection_id, id),
        closed: true,
      });
      // A history read as coherent may still not hold with today's choices (a stretch left open): not proven.
      if (!check.ok) {
        excluded.invalid++;
        continue;
      }
      counted = worklogs.filter((w) => workSeconds([w], check.stretches) > 0);
    } else {
      if (c.state === "pending" || c.state === "stale" || c.state === "retry" || c.state === "invalid") excluded[c.state]++;
      continue;
    }
    const seconds = counted.reduce((sum, w) => sum + w.seconds, 0);
    if (seconds < MIN_WORK_SECONDS) continue;
    samples.push({
      id: c.id,
      workSeconds: seconds,
      type: c.type,
      components: jsonList(c.components),
      containerId: c.container_id,
      trackerEstimate: c.time_estimate_seconds !== null && c.time_estimate_seconds > 0 ? c.time_estimate_seconds : null,
      lastCountedWorklogAt: Math.max(...counted.map((w) => Number(w.started))),
      similarity: c.similarity,
      allWorklogs: c.state === "unsupported",
    });
  }
  return { samples, excluded };
}

/** The estimate of an issue of mine (R-3.1–R-3.9): none on a closed one. */
export async function estimateForIssue(userId: number, input: { issueKey: string; connectionId?: number }, now: number, cache: EstimateCache = defaultCache): Promise<IssueEstimate> {
  const revision = await estimateRevision(userId);
  const key = `issue:${input.connectionId ?? ""}:${input.issueKey}`;
  const cached = cache.get<IssueEstimate>(userId, revision, key, now);
  if (cached) return cached;
  const [row] = await q<Row>(SAMPLES_SQL, userId, input.issueKey, input.connectionId ?? null);
  const targets = row?.target ?? [];
  if (targets.length > 1) throw new TRPCError({ code: "CONFLICT", message: t("server.connections.ambiguousKey", { key: input.issueKey }) });
  const target = targets[0];
  if (!target) throw new TRPCError({ code: "NOT_FOUND", message: t("server.issues.notFound") });
  let answer: IssueEstimate;
  if (target.category === "done" || target.category === "cancelled") answer = { hidden: "closed" };
  else {
    const { samples, excluded } = samplesOf(row);
    const e = estimate(
      samples.map((s) => (usableSummary(target.summary) ? s : { ...s, similarity: null })),
      {
        type: target.type,
        components: jsonList(target.components),
        containerId: target.container_id,
        trackerEstimate: target.time_estimate_seconds !== null && target.time_estimate_seconds > 0 ? target.time_estimate_seconds : null,
      },
      now,
    );
    answer = { ...e, excluded };
  }
  cache.set(userId, revision, key, now, answer);
  return answer;
}

type TodoRow = {
  todo: { issue_key: string | null; connection_id: number | null; estimate_seconds: number | null } | null;
  ratios: { ratio: number; last: number }[] | null;
};

const TODO_SQL = `
SELECT
  (SELECT json_build_object('issue_key', t."issue_key", 'connection_id', t."connection_id", 'estimate_seconds', t."estimate_seconds")
   FROM "todos" t WHERE t."id" = $2 AND t."user_id" = $1) AS "todo",
  (SELECT json_agg(json_build_object('ratio', x."spent"::float8 / x."estimate_seconds", 'last', x."last"))
   FROM (SELECT t."estimate_seconds", sum(s."ended_at" - s."started_at") / 1000 AS "spent", max(s."ended_at") AS "last"
         FROM "todos" t JOIN "todo_sessions" s ON s."todo_id" = t."id" AND s."ended_at" IS NOT NULL
         WHERE t."user_id" = $1 AND t."estimate_seconds" > 0
         GROUP BY t."id") x WHERE x."spent" > 0) AS "ratios"`;

/** My habit with TODO estimates (R-3.10): the weighted median of time taken over time estimated, winsorized, rounded to 2 decimals. */
export function todoRatio(ratios: readonly { ratio: number; last: number }[], now: number): { todoRatio: number; n: number } | { none: true; n: number } {
  if (ratios.length < MIN_SAMPLES) return { none: true, n: ratios.length };
  const weights = ratios.map((r) => recencyWeight(Number(r.last), now));
  const values = winsorize(
    ratios.map((r) => r.ratio),
    weights,
  );
  return { todoRatio: Math.round(weightedQuantile(values, weights, 0.5) * 100) / 100, n: ratios.length };
}

/** A TODO's estimate: its issue's, or my TODO habit when it has none (R-3.10). */
export async function estimateForTodo(userId: number, todoId: number, now: number, cache: EstimateCache = defaultCache): Promise<TodoEstimate> {
  const revision = await estimateRevision(userId);
  const key = `todo:${todoId}`;
  const cached = cache.get<TodoEstimate>(userId, revision, key, now);
  if (cached) return cached;
  const [row] = await q<TodoRow>(TODO_SQL, userId, todoId);
  if (!row?.todo) throw new TRPCError({ code: "NOT_FOUND", message: t("server.todos.notFound") });
  const answer: TodoEstimate = row.todo.issue_key
    ? await estimateForIssue(userId, { issueKey: row.todo.issue_key, ...(row.todo.connection_id !== null ? { connectionId: row.todo.connection_id } : {}) }, now, cache)
    : todoRatio(row.ratios ?? [], now);
  cache.set(userId, revision, key, now, answer);
  return answer;
}

/**
 * How the estimates would have done over the last 90 days (R-3.16): each case
 * predicted only from the samples worked before it, its title compared with
 * theirs (not with today's issue).
 */
export async function accuracyFor(userId: number, now: number, cache: EstimateCache = defaultCache): Promise<Backtest> {
  const revision = await estimateRevision(userId);
  const cached = cache.get<Backtest>(userId, revision, "accuracy", now);
  if (cached) return cached;
  const [row] = await q<Row>(ACCURACY_SQL, userId, now - BACKTEST_WINDOW_MS);
  const { samples } = samplesOf(row);
  const alike = new Map((row.pairs ?? []).map(([a, b, s]) => [`${a}:${b}`, s]));
  const answer = backtest(
    samples.map((s) => ({ ...s, target: { type: s.type, components: s.components, containerId: s.containerId, trackerEstimate: s.trackerEstimate } })),
    now,
    (c, earlier) => alike.get(`${c.id}:${earlier.id}`) ?? null,
  );
  cache.set(userId, revision, "accuracy", now, answer);
  return answer;
}

