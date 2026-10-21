// An adapter bound to one connection: options parsed once with the adapter's
// own parser (so T and O never get lost), and every call run inside its call
// context (cancellation and correlation reach each request), every error
// turned into a ProviderError, every result checked against the contract.
// The core only ever calls bound adapters.
import { SINK_CALLS, SINK_GROUPS, TRACKER_CALLS, TRACKER_GROUPS } from "./operations";
import { originate } from "./origin";
import { inCall, type CallMeta } from "./context";
import { normalizeError, ProviderError } from "./errors";
import { checkActiveSources, checkEntryPage, checkFind, checkIssuePage, checkWorklog, IncompatibleResultError } from "./results";
import { sinkProbeExceeds, trackerProbeExceeds } from "./validate";
import { publicConversionWarning } from "../types";
import type { CallContext, Conn, PageQuery, Page, RemoteWorklog, ReportedEntryGone, ReportedIssueGone, TrackerProbe, TrackerProvider, TimeSinkProbe, TimeSinkProvider, FindResult, ConversionWarning, PublicConversionWarning, RemoteComment } from "../types";
import type { TimeSinkType, TrackerType } from "@contracts/providers";

export type { CallMeta } from "./context";

/** A connection as stored, before its options are checked by its provider. */
export type StoredConn<T extends TrackerType> = Omit<Conn<T, unknown>, "options"> & {
  options: unknown;
  /** False: its calls never write (an adapter not verified on a real account, until the user allows writes) */
  writable?: boolean;
};

type Unctx<F> = F extends (x: CallContext<infer _T, infer _O>, ...a: infer A) => infer R ? (m: CallMeta, ...a: A) => R : never;
type BoundGroup<G> = { [K in keyof G]: Unctx<NonNullable<G[K]>> };
type Calls = (typeof TRACKER_CALLS)[number];
type Groups = keyof typeof TRACKER_GROUPS;

/** A tracker bound to a connection: the same operations, called with a CallMeta instead of a context. */
export type BoundTracker = {
  role: "tracker";
  type: TrackerType;
  connectionId: number;
  capabilities: TrackerProvider["capabilities"];
  normalizeKey: TrackerProvider["normalizeKey"];
  parseRef: (text: string) => ReturnType<TrackerProvider["parseRef"]>;
  translate?: TrackerProvider["translate"];
} & { [K in Calls]: Unctx<NonNullable<TrackerProvider[K]>> | (undefined extends TrackerProvider[K] ? undefined : never) } & {
  [G in Exclude<Groups, "comments">]?: BoundGroup<NonNullable<TrackerProvider[G]>>;
} & {
  /** Comments as they may leave the server: conversion warnings without their server details */
  comments?: {
    list: Unctx<NonNullable<TrackerProvider["comments"]>["list"]>;
    add?: (m: CallMeta, ...a: Parameters<NonNullable<NonNullable<TrackerProvider["comments"]>["add"]>> extends [unknown, ...infer A] ? A : never) => Promise<{ comment: RemoteComment | null; warnings: PublicConversionWarning[] }>;
  };
};

type AnyFn = (...a: unknown[]) => unknown;

/** What the binding checks after a call, by operation (the result passes through unchanged). */
function checker<T extends TrackerType, O>(p: TrackerProvider<T, O>, name: string, args: unknown[]): ((r: unknown) => unknown) | null {
  const entries = p.capabilities.time.mode === "entries" ? p.capabilities.time.entries : null;
  switch (name) {
    case "listChanged":
      return (r) => checkIssuePage(p.capabilities, args[0] as PageQuery, r as Page<unknown, ReportedIssueGone>);
    case "findIssue":
      return (r) => checkFind(r as FindResult);
    case "probe":
      return (r) => {
        const probe = r as TrackerProbe;
        checkActiveSources(probe);
        const over = trackerProbeExceeds(p.capabilities, probe);
        if (over.length > 0) throw new IncompatibleResultError(`the probe claims more than the provider: ${over.join(", ")}`);
      };
    case "worklogs.list":
      return entries ? (r) => (r as RemoteWorklog[]).forEach((w) => checkWorklog(entries, w)) : null;
    case "worklogs.changed":
      return entries
        ? (r) => {
            const page = r as Page<RemoteWorklog, ReportedEntryGone>;
            checkEntryPage(entries, page);
            page.items.forEach((w) => checkWorklog(entries, w));
          }
        : null;
    case "worklogs.create":
    case "worklogs.update":
      return entries ? (r) => checkWorklog(entries, r as RemoteWorklog) : null;
    case "worklogs.get":
      return entries ? (r) => (r === null ? undefined : checkWorklog(entries, r as RemoteWorklog)) : null;
    default:
      return null;
  }
}

/** Server-only details never leave the binding (logged with the call's correlation id). */
function scrub(name: string, r: unknown, m: CallMeta): unknown {
  if (name !== "comments.add") return r;
  const out = r as { comment: RemoteComment | null; warnings: ConversionWarning[] };
  const scrubbed: { comment: RemoteComment | null; warnings: PublicConversionWarning[] } = {
    comment: out.comment,
    warnings: out.warnings.map((w) => {
      if (w.serverDetail) console.warn(`[provider ${m.correlationId}] conversion: ${w.serverDetail}`);
      return publicConversionWarning(w);
    }),
  };
  return scrubbed;
}

export function bindTracker<T extends TrackerType, O>(p: TrackerProvider<T, O>, stored: StoredConn<T>): BoundTracker {
  let options: O;
  try {
    options = p.parseOptions(stored.options);
  } catch (e) {
    throw e instanceof ProviderError ? e : new ProviderError("invalid", `Connection ${stored.id}: unreadable options`, { cause: e });
  }
  const conn: Conn<T, O> = { ...stored, options };
  const wrap =
    (name: string, fn: AnyFn) =>
    (m: CallMeta, ...args: unknown[]) =>
      inCall(m, async () => {
        if (m.signal.aborted) throw new ProviderError("cancelled", "Cancelled before the call");
        let result: unknown;
        try {
          result = await fn({ conn, signal: m.signal, correlationId: m.correlationId }, ...args);
        } catch (e) {
          throw originate(normalizeError(e, m.signal), stored.id);
        }
        checker(p, name, args)?.(result);
        return scrub(name, result, m);
      }, stored.writable === false);

  const source = p as unknown as Record<string, unknown>;
  const bound: Record<string, unknown> = {
    role: "tracker",
    type: p.type,
    connectionId: stored.id,
    capabilities: p.capabilities,
    normalizeKey: (raw: string) => p.normalizeKey(raw),
    parseRef: (text: string) => p.parseRef({ baseUrl: conn.baseUrl, options }, text),
    ...(p.translate ? { translate: p.translate.bind(p) } : {}),
  };
  for (const name of TRACKER_CALLS) {
    const fn = source[name];
    if (typeof fn === "function") bound[name] = wrap(name, (fn as AnyFn).bind(p));
  }
  for (const [g, members] of Object.entries(TRACKER_GROUPS)) {
    const group = source[g] as Record<string, unknown> | undefined;
    if (!group) continue;
    const b: Record<string, unknown> = {};
    for (const member of members) {
      const fn = group[member];
      if (typeof fn === "function") b[member] = wrap(`${g}.${member}`, (fn as AnyFn).bind(group));
    }
    bound[g] = b;
  }
  return bound as BoundTracker;
}

// ---------- Time sinks ----------

/** A time sink connection as stored, before its options are checked. */
export type StoredSinkConn<T extends TimeSinkType> = Omit<Conn<T, unknown>, "options"> & { options: unknown; writable?: boolean };

/** A time sink bound to a connection: the same operations, called with a CallMeta. */
export type BoundSink = {
  role: "timeSink";
  type: TimeSinkType;
  connectionId: number;
  capabilities: TimeSinkProvider["capabilities"];
  verify: Unctx<TimeSinkProvider["verify"]>;
  probe: Unctx<TimeSinkProvider["probe"]>;
  targets?: Unctx<NonNullable<TimeSinkProvider["targets"]>>;
  entries: BoundGroup<TimeSinkProvider["entries"]>;
};

export function bindSink<T extends TimeSinkType, O>(p: TimeSinkProvider<T, O>, stored: StoredSinkConn<T>): BoundSink {
  let options: O;
  try {
    options = p.parseOptions(stored.options);
  } catch (e) {
    throw e instanceof ProviderError ? e : new ProviderError("invalid", `Connection ${stored.id}: unreadable options`, { cause: e });
  }
  const conn: Conn<T, O> = { ...stored, options };
  const e = p.capabilities.entries;
  const check = (name: string, r: unknown) => {
    if (name === "probe") {
      const over = sinkProbeExceeds(p.capabilities, r as TimeSinkProbe);
      if (over.length > 0) throw new IncompatibleResultError(`the probe claims more than the provider: ${over.join(", ")}`);
    } else if (name === "entries.list") (r as RemoteWorklog[]).forEach((w) => checkWorklog(e, w));
    else if (name === "entries.create" || name === "entries.update") checkWorklog(e, r as RemoteWorklog);
    else if (name === "entries.changed") {
      const page = r as Page<RemoteWorklog, ReportedEntryGone>;
      checkEntryPage(e, page);
      page.items.forEach((w) => checkWorklog(e, w));
    }
  };
  const wrap =
    (name: string, fn: AnyFn) =>
    (m: CallMeta, ...args: unknown[]) =>
      inCall(m, async () => {
        if (m.signal.aborted) throw new ProviderError("cancelled", "Cancelled before the call");
        let result: unknown;
        try {
          result = await fn({ conn, signal: m.signal, correlationId: m.correlationId }, ...args);
        } catch (err) {
          throw normalizeError(err, m.signal);
        }
        check(name, result);
        return result;
      }, stored.writable === false);
  const source = p as unknown as Record<string, unknown>;
  const bound: Record<string, unknown> = { role: "timeSink", type: p.type, connectionId: stored.id, capabilities: p.capabilities };
  for (const name of SINK_CALLS) {
    const fn = source[name];
    if (typeof fn === "function") bound[name] = wrap(name, (fn as AnyFn).bind(p));
  }
  const entries: Record<string, unknown> = {};
  for (const member of SINK_GROUPS.entries) {
    const fn = (p.entries as Record<string, unknown>)[member];
    if (typeof fn === "function") entries[member] = wrap(`entries.${member}`, (fn as AnyFn).bind(p.entries));
  }
  bound.entries = entries;
  return bound as BoundSink;
}
