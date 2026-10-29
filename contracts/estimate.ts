// How long an issue will likely take, from the user's own history
// (docs/work/ideas/estimates.md, L1): similar closed issues of mine, their
// work time (my worklogs inside the spans the issue was being worked on),
// weighted by how recent they are. Pure: the server reads, this decides.

const DAY_MS = 86_400_000;
const HOUR = 3600;

/** Fewer eligible samples than this: no number at all (R-3.3). */
export const MIN_SAMPLES = 5;
/** Titles at least this alike (pg_trgm) make tier 0 */
export const SIMILAR_TITLE = 0.35;
const HALF_LIFE_DAYS = 180;
/** A title shorter than a trigram can't be compared (R-3.6). */
const MIN_SUMMARY = 3;
const MAX_CHANGES = 5000;

/** A closed issue of mine, one per issue (R-3.1, R-3.2). */
export type Sample = {
  /** Work time, seconds (R-3.11; every worklog when `allWorklogs`) */
  workSeconds: number;
  type: string | null;
  components: string[];
  containerId: number | null;
  trackerEstimate: number | null;
  /** When the last worklog that counted started (epoch ms): its recency */
  lastCountedWorklogAt: number;
  /** Title likeness to the target (pg_trgm), null when either title is not usable */
  similarity: number | null;
  /** Its tracker has no history: all its worklogs counted (R-3.4) */
  allWorklogs: boolean;
};
export type Target = { type: string | null; components: string[]; containerId: number | null; trackerEstimate: number | null };
export type Tier = 0 | 1 | 2 | 3 | 4 | 5;
export type Confidence = "low" | "medium" | "high";
export type Calibration = { ratio: number; n: number; calibrated: number | null };
export type Estimate =
  | { none: true; n: number }
  | {
      none: false;
      p20: number;
      p50: number;
      p80: number;
      n: number;
      tier: Tier;
      confidence: Confidence;
      calibration: Calibration | null;
      /** Samples of the chosen tier counted with all their worklogs */
      allWorklogs: number;
    };

/**
 * Q(q): the smallest value whose cumulative weight, values taken in
 * ascending order, reaches q of the total (docs: Definitions). Throws on no
 * values, unequal lengths, q outside (0, 1], or a weight not finite and > 0.
 */
export function weightedQuantile(values: readonly number[], weights: readonly number[], q: number): number {
  if (values.length === 0 || values.length !== weights.length) throw new RangeError("weightedQuantile: values and weights must match and not be empty");
  if (!(q > 0 && q <= 1)) throw new RangeError("weightedQuantile: q must be in (0, 1]");
  if (weights.some(w => !(Number.isFinite(w) && w > 0))) throw new RangeError("weightedQuantile: weights must be finite and > 0");
  const pairs = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  const total = pairs.reduce((sum, p) => sum + p.w, 0);
  const reach = q * total - 1e-9 * total;
  let seen = 0;
  for (const p of pairs) {
    seen += p.w;
    if (seen >= reach) return p.v;
  }
  return pairs[pairs.length - 1].v;
}

/** Each value held within the weighted Q(0.05) and Q(0.95) of the same values and weights. */
export function winsorize(values: readonly number[], weights: readonly number[]): number[] {
  const lo = weightedQuantile(values, weights, 0.05);
  const hi = weightedQuantile(values, weights, 0.95);
  return values.map(v => Math.min(hi, Math.max(lo, v)));
}

/** 0.5^(age / 180 days), age from the last counted worklog to now (never negative). */
export function recencyWeight(lastCountedWorklogAt: number, now: number): number {
  return 0.5 ** (Math.max(0, now - lastCountedWorklogAt) / DAY_MS / HALF_LIFE_DAYS);
}

/** To 5 minutes under 2 hours, to 15 from 2 hours; never under 5 minutes. */
export function roundEstimate(seconds: number): number {
  const step = seconds < 2 * HOUR ? 300 : 900;
  return Math.max(300, Math.round(seconds / step) * step);
}

/** A title T0 may compare: not null, at least a trigram long once trimmed. */
export function usableSummary(summary: string | null | undefined): boolean {
  return (summary?.trim().length ?? 0) >= MIN_SUMMARY;
}

const sameContainer = (s: Sample, t: Target) => t.containerId !== null && s.containerId === t.containerId;
const sameType = (s: Sample, t: Target) => t.type !== null && t.type !== "" && s.type === t.type;
const sharesComponent = (s: Sample, t: Target) => s.components.some(c => t.components.includes(c));

/** The tiers, most alike first (R-3.6); the last holds everything. */
const TIERS: readonly { tier: Tier; alike: (s: Sample, t: Target) => boolean }[] = [
  { tier: 0, alike: (s, t) => sameContainer(s, t) && s.similarity !== null && s.similarity >= SIMILAR_TITLE },
  { tier: 1, alike: (s, t) => sameContainer(s, t) && sameType(s, t) && sharesComponent(s, t) },
  { tier: 2, alike: (s, t) => sameContainer(s, t) && sameType(s, t) },
  { tier: 3, alike: (s, t) => sameType(s, t) },
  { tier: 4, alike: (s, t) => sameContainer(s, t) },
  { tier: 5, alike: () => true },
];

function confidenceOf(n: number, tier: Tier): Confidence {
  if (n < 8 || tier >= 4) return "low";
  if (n >= 15 && tier <= 2) return "high";
  return "medium";
}

/** The tracker's estimates against my time, within the chosen tier, its ratios winsorized on their own (R-3.8). */
function calibrationOf(tier: readonly Sample[], target: Target, now: number): Calibration | null {
  const known = tier.filter(s => (s.trackerEstimate ?? 0) > 0);
  if (known.length < MIN_SAMPLES) return null;
  const ratios = known.map(s => s.workSeconds / (s.trackerEstimate ?? 1));
  const weights = known.map(s => recencyWeight(s.lastCountedWorklogAt, now));
  const ratio = Math.round(weightedQuantile(winsorize(ratios, weights), weights, 0.5) * 100) / 100;
  return {
    ratio,
    n: known.length,
    calibrated: target.trackerEstimate !== null && target.trackerEstimate > 0 ? roundEstimate(target.trackerEstimate * ratio) : null,
  };
}

/** The likely work time of `target` from my eligible samples (R-3.3 – R-3.8). */
export function estimate(samples: readonly Sample[], target: Target, now: number): Estimate {
  if (samples.length < MIN_SAMPLES) return { none: true, n: samples.length };
  let tier: Tier = 5;
  let chosen: readonly Sample[] = samples;
  for (const t of TIERS) {
    const hit = samples.filter(s => t.alike(s, target));
    if (hit.length >= MIN_SAMPLES) {
      tier = t.tier;
      chosen = hit;
      break;
    }
  }
  const weights = chosen.map(s => recencyWeight(s.lastCountedWorklogAt, now));
  const values = winsorize(
    chosen.map(s => s.workSeconds),
    weights
  );
  const at = (q: number) => roundEstimate(weightedQuantile(values, weights, q));
  return {
    none: false,
    p20: at(0.2),
    p50: at(0.5),
    p80: at(0.8),
    n: chosen.length,
    tier,
    confidence: confidenceOf(chosen.length, tier),
    calibration: calibrationOf(chosen, target, now),
    allWorklogs: chosen.filter(s => s.allWorklogs).length,
  };
}

export type Backtest = { n: number; skipped: number; mdape: number | null; coverage: number | null };
const BACKTEST_DAYS = 90;

/**
 * How the estimates would have done (R-3.16): each case of the last 90 days
 * predicted from the samples worked before it only. A case with too little
 * earlier history is skipped, never a prediction.
 */
export function backtest<C extends Sample & { target: Target }>(cases: readonly C[], now: number, alike?: (c: C, earlier: C) => number | null): Backtest {
  // Cases worked at the same instant form one group: all predicted from the earlier pool, then added to it.
  const groups = new Map<number, C[]>();
  for (const c of cases) groups.set(c.lastCountedWorklogAt, [...(groups.get(c.lastCountedWorklogAt) ?? []), c]);
  const since = now - BACKTEST_DAYS * DAY_MS;
  const pool: C[] = [];
  const errors: number[] = [];
  let covered = 0;
  let skipped = 0;
  for (const at of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(at) ?? [];
    for (const c of group) {
      if (c.lastCountedWorklogAt < since || c.workSeconds <= 0) continue;
      // Title likeness is to the case's own title, when the caller knows it (else as the samples carry it).
      const e = estimate(alike ? pool.map(s => ({ ...s, similarity: alike(c, s) })) : pool, c.target, c.lastCountedWorklogAt);
      if (e.none) {
        skipped++;
        continue;
      }
      errors.push((Math.abs(e.p50 - c.workSeconds) / c.workSeconds) * 100);
      if (c.workSeconds >= e.p20 && c.workSeconds <= e.p80) covered++;
    }
    pool.push(...group);
  }
  if (errors.length === 0) return { n: 0, skipped, mdape: null, coverage: null };
  const sorted = [...errors].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const mdape = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: errors.length, skipped, mdape, coverage: (covered / errors.length) * 100 };
}

/** A status change, by remote status ids, in the tracker's order (`ordinal`) (R-3.11). */
export type StatusChange = { at: number; ordinal: number; from: string | null; to: string };
/** What the conversion reads of a tracker change (only status changes are given to it, in the tracker's order). */
export type RemoteStatusChange = {
  /** Its index in the complete changelog as the tracker returned it: picking out status changes never renumbers */
  sourceOrdinal: number;
  at: number;
  from: readonly { id?: string; text: string }[];
  to: readonly { id?: string; text: string }[];
};

/**
 * Tracker changes as status changes, in the order given (never reordered),
 * each keeping its `sourceOrdinal` as `ordinal`: `from` holds zero values
 * (null) or one, `to` exactly one; a value by its id, else by a name matching
 * exactly one current status (R-3.11).
 */
export function toStatusChanges(
  changes: readonly RemoteStatusChange[],
  statuses: readonly { id: string; name: string }[]
): { ok: true; changes: StatusChange[] } | { ok: false; reason: "ambiguousChange" } {
  const idOf = (value: { id?: string; text: string }): string | null => {
    if (value.id) return value.id;
    const named = statuses.filter(s => s.name === value.text.trim());
    return named.length === 1 ? named[0].id : null;
  };
  const out: StatusChange[] = [];
  for (const change of changes) {
    if (change.from.length > 1 || change.to.length !== 1) return { ok: false, reason: "ambiguousChange" };
    const to = idOf(change.to[0]);
    const from = change.from.length === 0 ? null : idOf(change.from[0]);
    if (to === null || (change.from.length === 1 && from === null)) return { ok: false, reason: "ambiguousChange" };
    out.push({ at: change.at, ordinal: change.sourceOrdinal, from, to });
  }
  return { ok: true, changes: out };
}

/** A span in which the status counted as work: [from, until), `until` null while it still does. */
export type Stretch = { from: number; until: number | null };
export type HistoryCheck =
  | { ok: true; stretches: Stretch[] }
  | { ok: false; reason: "chain" | "beforeCreation" | "afterRead" | "unknownStatus" | "openOnClosed" | "tooMany" | "ambiguousChange" | "noInitialStatus" | "currentStatusMismatch" };

/**
 * The work stretches of an issue from its status history (R-3.11), or why the
 * history can't be trusted. `classify` says whether a status counts, or null
 * when nothing (statuses(), a snapshot) resolves it.
 */
export function workStretches(input: {
  changes: readonly StatusChange[];
  createdAt: number;
  readAt: number;
  statusNow: string;
  classify: (statusId: string) => boolean | null;
  closed: boolean;
}): HistoryCheck {
  const { createdAt, readAt, classify } = input;
  if (input.changes.length > MAX_CHANGES) return { ok: false, reason: "tooMany" };
  const changes = [...input.changes].sort((a, b) => a.at - b.at || a.ordinal - b.ordinal);
  for (const c of changes) {
    if (c.at < createdAt) return { ok: false, reason: "beforeCreation" };
    if (c.at > readAt) return { ok: false, reason: "afterRead" };
  }
  if (changes.length > 0 && changes[0].from === null) return { ok: false, reason: "noInitialStatus" };
  for (let i = 1; i < changes.length; i++) {
    if (changes[i].from !== changes[i - 1].to) return { ok: false, reason: "chain" };
  }
  // The history must arrive at the status the issue has now.
  if (changes.length > 0 && changes[changes.length - 1].to !== input.statusNow) return { ok: false, reason: "currentStatusMismatch" };
  const first = changes[0]?.from ?? input.statusNow;
  const counted = new Map<string, boolean>();
  for (const id of [first, ...changes.map(c => c.to)]) {
    const c = classify(id);
    if (c === null) return { ok: false, reason: "unknownStatus" };
    counted.set(id, c);
  }
  const stretches: Stretch[] = [];
  let status = first;
  let since = createdAt;
  for (const change of changes) {
    if (counted.get(status) && change.at > since) stretches.push({ from: since, until: change.at });
    status = change.to;
    since = change.at;
  }
  if (counted.get(status)) {
    if (input.closed) return { ok: false, reason: "openOnClosed" };
    stretches.push({ from: since, until: null });
  }
  return { ok: true, stretches };
}

/** Seconds of the worklogs that started inside a stretch: from ≤ started < until. */
export function workSeconds(worklogs: readonly { started: number; seconds: number }[], stretches: readonly Stretch[]): number {
  return worklogs
    .filter(w => stretches.some(s => w.started >= s.from && (s.until === null || w.started < s.until)))
    .reduce((sum, w) => sum + w.seconds, 0);
}

/**
 * Whether a status counts as work (R-3.14): the user's choice for the
 * connection, else the provider's default: the "doing" statuses, or, on a
 * tracker with none (open/closed), every one not done or cancelled.
 */
export function countsAsWork(status: { category: string; hasDoing: boolean; override?: boolean }): boolean {
  if (status.override !== undefined) return status.override;
  if (status.hasDoing) return status.category === "doing";
  return status.category !== "done" && status.category !== "cancelled";
}
