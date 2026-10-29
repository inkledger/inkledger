// The checks every adapter passes before it is used (the registry runs them
// at load, the tests on every adapter), and the rule a connection's probe is
// held to:
// - the capabilities are valid (their schemas, with every cross-field rule);
// - each operation present is callable, and present exactly when its
//   capability says so (both ways);
// - a probe's capabilities narrow the provider's: never more, by domain
//   rules spelled out below, not a generic comparison.
import {
  timeSinkCapabilitiesSchema,
  timeSinkTraitsSchema,
  trackerCapabilitiesSchema,
  trackerTraitsSchema,
  type EntryCapabilities,
  type TimeSinkCapabilities,
  type TrackerCapabilities,
} from "@contracts/providers";
import type { ProviderShape, TimeSinkProbe, TimeSinkShape, TrackerProbe, TrackerShape } from "../types";

type Problems = string[];

const isFn = (x: unknown) => typeof x === "function";

/** Present ⇔ declared, and callable when present. */
function op(out: Problems, name: string, value: unknown, declared: boolean) {
  if (value !== undefined && !isFn(value)) out.push(`${name} is not a function`);
  if (value !== undefined && !declared) out.push(`${name} is implemented but not declared`);
  if (value === undefined && declared) out.push(`${name} is declared but not implemented`);
}

/** A group of operations: present ⇔ any of them is declared, and an object when present. */
function group(out: Problems, name: string, value: unknown, declared: boolean): Record<string, unknown> {
  if (value !== undefined && (typeof value !== "object" || value === null)) out.push(`${name} is not a group of operations`);
  if (value !== undefined && !declared) out.push(`${name} is implemented but not declared`);
  if (value === undefined && declared) out.push(`${name} is declared but not implemented`);
  if (value !== null && typeof value === "object" && Object.values(value).every((v) => v === undefined)) out.push(`${name} is an empty group`);
  return (value ?? {}) as Record<string, unknown>;
}

function schemaProblems(out: Problems, name: string, r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  if (!r.success) for (const i of r.error?.issues ?? []) out.push(`${name}.${i.path.map(String).join(".")}: ${i.message}`);
}

/** The time operations of an entries/dayTotals service against its capabilities. */
function entryOps(out: Problems, where: string, ops: Record<string, unknown>, e: EntryCapabilities) {
  op(out, `${where}.changed`, ops.changed, e.feed.kind !== "none");
  if (e.model === "entries") {
    const w = e.write;
    op(out, `${where}.create`, ops.create, w.mode === "entry");
    op(out, `${where}.update`, ops.update, w.mode === "entry" && (w.update === "native" || w.update === "replace"));
    op(out, `${where}.delete`, ops.delete, w.mode === "entry" && w.delete);
    op(out, `${where}.setDayTotal`, ops.setDayTotal, false);
    op(out, `${where}.activities`, ops.activities, e.activities.write);
  } else {
    op(out, `${where}.create`, ops.create, false);
    op(out, `${where}.update`, ops.update, false);
    op(out, `${where}.delete`, ops.delete, false);
    op(out, `${where}.setDayTotal`, ops.setDayTotal, e.write.set);
    op(out, `${where}.activities`, ops.activities, false);
  }
}

function trackerProblems(p: TrackerShape): Problems {
  const out: Problems = [];
  const parsed = trackerCapabilitiesSchema.safeParse(p.capabilities);
  schemaProblems(out, "capabilities", parsed);
  schemaProblems(out, "traits", trackerTraitsSchema.safeParse(p.traits));
  if (!parsed.success) return out;
  const c: TrackerCapabilities = parsed.data;
  op(out, "searchText", p.searchText, c.searchText);
  op(out, "query", p.query, c.query !== null);
  op(out, "statuses", p.statuses, c.statuses);
  const tr = group(out, "transitions", p.transitions, c.transitions.read || c.transitions.write);
  op(out, "transitions.list", tr.list, c.transitions.read);
  op(out, "transitions.apply", tr.apply, c.transitions.write);
  const wl = group(out, "worklogs", p.worklogs, c.time.mode === "entries");
  if (c.time.mode === "entries") {
    op(out, "worklogs.list", wl.list, true);
    entryOps(out, "worklogs", wl, c.time.entries);
  }
  const tc = group(out, "timeCounter", p.timeCounter, c.time.mode === "counter");
  op(out, "timeCounter.read", tc.read, c.time.mode === "counter" && c.time.read);
  op(out, "timeCounter.increment", tc.increment, c.time.mode === "counter" && c.time.increment);
  op(out, "timeCounter.decrement", tc.decrement, c.time.mode === "counter" && c.time.decrement);
  const cm = group(out, "comments", p.comments, c.comments.mode !== "none");
  op(out, "comments.list", cm.list, c.comments.mode !== "none");
  op(out, "comments.add", cm.add, c.comments.mode === "readWrite");
  op(out, "description", p.description, c.description);
  op(out, "containers", p.containers, c.containers);
  if (c.manage.types && !c.manage.create) out.push("manage.types needs manage.create");
  const mg = group(out, "manage", p.manage, c.manage.assign || c.manage.labels || c.manage.create || c.manage.edit);
  op(out, "manage.assignable", mg.assignable, c.manage.assign);
  op(out, "manage.assign", mg.assign, c.manage.assign);
  op(out, "manage.labelOptions", mg.labelOptions, c.manage.labels);
  op(out, "manage.setLabels", mg.setLabels, c.manage.labels);
  op(out, "manage.create", mg.create, c.manage.create);
  op(out, "manage.edit", mg.edit, c.manage.edit);
  op(out, "manage.createTypes", mg.createTypes, c.manage.types);
  op(out, "watch", p.watch, c.watch);
  op(out, "history", p.history, c.history);
  op(out, "statusHistory", p.statusHistory, c.statusHistory);
  op(out, "translate", p.translate, c.query !== null);
  // Webhook checks: pure functions, present exactly when deliveries are declared.
  const wh = p.webhook as Record<string, unknown> | undefined;
  if (wh !== undefined && c.sync.webhooks === null) out.push("webhook is implemented but not declared");
  if (wh === undefined && c.sync.webhooks !== null) out.push("webhook is declared but not implemented");
  if (wh !== undefined && (!isFn(wh.verify) || !isFn(wh.deliveryId))) out.push("webhook needs verify and deliveryId");
  op(out, "inbox", p.inbox, c.inbox);
  op(out, "markRead", p.markRead, c.inbox);
  op(out, "otherFields", p.otherFields, c.otherFields);
  return out;
}

function sinkProblems(p: TimeSinkShape): Problems {
  const out: Problems = [];
  const parsed = timeSinkCapabilitiesSchema.safeParse(p.capabilities);
  schemaProblems(out, "capabilities", parsed);
  schemaProblems(out, "traits", timeSinkTraitsSchema.safeParse(p.traits));
  if (!parsed.success) return out;
  const c: TimeSinkCapabilities = parsed.data;
  op(out, "targets", p.targets, c.target.use !== "none" && c.target.lookup === "search");
  const en = group(out, "entries", p.entries, true);
  op(out, "entries.list", en.list, true);
  entryOps(out, "entries", en, c.entries);
  return out;
}

/** What's wrong with an adapter ([] when nothing). */
export function providerProblems(p: ProviderShape): Problems {
  return p.role === "tracker" ? trackerProblems(p) : sinkProblems(p);
}

/** Throws with every problem at once: an adapter that doesn't hold to the contract never runs. */
export function assertProvider(p: ProviderShape): void {
  const problems = providerProblems(p);
  if (problems.length > 0) throw new Error(`Provider "${p.type}" breaks the contract:\n- ${problems.join("\n- ")}`);
}

// ---------- Narrowing: a connection never claims more than its provider ----------

/** A boolean can only go from true to false. */
const flag = (out: Problems, path: string, declared: boolean, effective: boolean) => {
  if (effective && !declared) out.push(path);
};

/** A choice can stay, or become the "less" value; anything else is a widening. */
const choice = <T>(out: Problems, path: string, declared: T, effective: T, less: T[]) => {
  if (effective !== declared && !less.includes(effective)) out.push(path);
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Limits only tighten: a lower maximum, a higher minimum, a coarser increment, a shorter history, noFuture only added. */
function limitsNarrow(out: Problems, path: string, d: EntryCapabilities["limits"], e: EntryCapabilities["limits"]) {
  if (d.maxSeconds !== undefined && (e.maxSeconds === undefined || e.maxSeconds > d.maxSeconds)) out.push(`${path}.maxSeconds`);
  if (d.minSeconds !== undefined && (e.minSeconds === undefined || e.minSeconds < d.minSeconds)) out.push(`${path}.minSeconds`);
  // An increment only coarsens: a multiple of the declared one, rounded the same way (so every duration it yields the provider takes too).
  if (d.increment && (!e.increment || e.increment.seconds % d.increment.seconds !== 0 || e.increment.rounding !== d.increment.rounding)) out.push(`${path}.increment`);
  if (d.maxAgeDays !== undefined && (e.maxAgeDays === undefined || e.maxAgeDays > d.maxAgeDays)) out.push(`${path}.maxAgeDays`);
  if (d.noFuture && !e.noFuture) out.push(`${path}.noFuture`);
}

function entriesNarrow(out: Problems, path: string, d: EntryCapabilities, e: EntryCapabilities) {
  if (d.model !== e.model) return void out.push(`${path}.model`);
  // How a service keeps and feeds time is its nature, not a connection's: unchanged.
  if (!sameJson(d.feed, e.feed)) out.push(`${path}.feed`);
  if (!sameJson(d.reconcile, e.reconcile)) out.push(`${path}.reconcile`);
  choice(out, `${path}.idempotency`, d.idempotency, e.idempotency, ["local"]);
  choice(out, `${path}.concurrency`, d.concurrency, e.concurrency, []);
  flag(out, `${path}.approvals.read`, d.approvals.read, e.approvals.read);
  limitsNarrow(out, `${path}.limits`, d.limits, e.limits);
  if (d.model === "entries" && e.model === "entries") {
    if (d.shape !== e.shape) out.push(`${path}.shape`);
    if (e.write.mode === "entry") {
      if (d.write.mode !== "entry") out.push(`${path}.write`);
      else {
        // native ⊃ replace ⊃ recreate ⊃ none: a connection may only do less.
        const order = ["none", "recreate", "replace", "native"] as const;
        if (order.indexOf(e.write.update) > order.indexOf(d.write.update)) out.push(`${path}.write.update`);
        flag(out, `${path}.write.delete`, d.write.delete, e.write.delete);
      }
    }
    for (const k of ["billable", "onBehalf"] as const) {
      flag(out, `${path}.${k}.read`, d[k].read, e[k].read);
      flag(out, `${path}.${k}.write`, d[k].write, e[k].write);
    }
    flag(out, `${path}.activities.read`, d.activities.read, e.activities.read);
    flag(out, `${path}.activities.write`, d.activities.write, e.activities.write);
  }
  if (d.model === "dayTotals" && e.model === "dayTotals") flag(out, `${path}.write.set`, d.write.set, e.write.set);
}

/** Where a tracker connection claims more than its provider ([] when it doesn't). */
export function trackerProbeExceeds(d: TrackerCapabilities, probe: TrackerProbe): Problems {
  const out: Problems = [];
  const e = probe.capabilities;
  const parsed = trackerCapabilitiesSchema.safeParse(e);
  schemaProblems(out, "probe", parsed);
  // Sources: each effective one among the declared kinds, with the declared transitions.
  for (const s of e.workflow.sources) if (!d.workflow.sources.some((x) => sameJson(x, s))) out.push(`workflow.sources[${s.kind}]`);
  for (const a of probe.activeSources) if (!e.workflow.sources.some((x) => x.kind === a.kind && x.transitions === a.transitions)) out.push(`activeSources[${a.kind}]`);
  flag(out, "transitions.read", d.transitions.read, e.transitions.read);
  flag(out, "transitions.write", d.transitions.write, e.transitions.write);
  flag(out, "statuses", d.statuses, e.statuses);
  flag(out, "searchText", d.searchText, e.searchText);
  if (e.query !== null && e.query !== d.query) out.push("query");
  if (e.comments.mode !== "none") {
    const order = ["none", "read", "readWrite"] as const;
    if (order.indexOf(e.comments.mode) > order.indexOf(d.comments.mode)) out.push("comments.mode");
    else if (d.comments.mode !== "none") {
      for (const f of e.comments.formats) if (!d.comments.formats.includes(f)) out.push(`comments.formats[${f}]`);
      if (e.comments.mode === "readWrite" && d.comments.mode === "readWrite") {
        for (const f of e.comments.writePreserves) if (!d.comments.writePreserves.includes(f)) out.push(`comments.writePreserves[${f}]`);
        choice(out, "comments.idempotency", d.comments.idempotency, e.comments.idempotency, ["local"]);
      }
    }
  }
  flag(out, "description", d.description, e.description);
  flag(out, "containers", d.containers, e.containers);
  for (const k of ["assign", "labels", "create", "edit", "types"] as const) flag(out, `manage.${k}`, d.manage[k], e.manage[k]);
  flag(out, "watch", d.watch, e.watch);
  flag(out, "inbox", d.inbox, e.inbox);
  flag(out, "otherFields", d.otherFields, e.otherFields);
  flag(out, "history", d.history, e.history);
  flag(out, "statusHistory", d.statusHistory, e.statusHistory);
  if (d.time.mode !== e.time.mode) out.push("time.mode");
  else if (d.time.mode === "entries" && e.time.mode === "entries") entriesNarrow(out, "time.entries", d.time.entries, e.time.entries);
  else if (d.time.mode === "counter" && e.time.mode === "counter") {
    for (const k of ["read", "increment", "decrement"] as const) flag(out, `time.${k}`, d.time[k], e.time[k]);
    choice(out, "time.concurrency", d.time.concurrency, e.time.concurrency, []);
  } else if (d.time.mode === "local" && e.time.mode === "local") flag(out, "time.remoteTotals", d.time.remoteTotals, e.time.remoteTotals);
  flag(out, "sync.issueCheckpoints", d.sync.issueCheckpoints, e.sync.issueCheckpoints);
  for (const k of ["deleted", "lostAccess", "movedOut"] as const) flag(out, `sync.gone.${k}`, d.sync.gone[k], e.sync.gone[k]);
  choice(out, "sync.gone.transfer", d.sync.gone.transfer, e.sync.gone.transfer, ["none"]);
  for (const w of e.sync.webhooks ?? []) {
    const declared = d.sync.webhooks?.find((x) => x.event === w.event);
    if (!declared || (declared.payload === "signal" && w.payload === "full")) out.push(`sync.webhooks[${w.event}]`);
  }
  return out;
}

/** Where a time sink connection claims more than its provider ([] when it doesn't). */
export function sinkProbeExceeds(d: TimeSinkCapabilities, probe: TimeSinkProbe): Problems {
  const out: Problems = [];
  const e = probe.capabilities;
  schemaProblems(out, "probe", timeSinkCapabilitiesSchema.safeParse(e));
  entriesNarrow(out, "entries", d.entries, e.entries);
  for (const r of e.references) if (!d.references.includes(r)) out.push(`references[${r}]`);
  // The order is behaviour: a connection keeps the provider's order among what it supports.
  const kept = d.references.filter((r) => e.references.includes(r));
  if (!sameJson(kept, e.references)) out.push("references order");
  if (!sameJson(d.target, e.target) && !(d.target.use === "optional" && e.target.use === "none")) out.push("target");
  return out;
}
