// The names of every adapter operation, in one place: the validator and the
// binding walk these lists, and operations.test.ts holds them to the
// interfaces in types.ts (an operation added there and forgotten here fails
// the type check).
import type { TimeSinkProvider, TrackerProvider } from "../types";

/** Tracker operations every adapter has. */
export const TRACKER_REQUIRED = ["parseOptions", "normalizeKey", "parseRef", "verify", "probe", "listChanged", "getIssue", "findIssue"] as const;
/** Tracker operations present as their capabilities say. */
export const TRACKER_OPTIONAL = ["searchText", "query", "statuses", "description", "containers", "watch", "history", "statusHistory", "inbox", "markRead", "otherFields"] as const;
/** Tracker operations with no call context (pure, no I/O), present as their capabilities say. */
export const TRACKER_PURE_OPTIONAL = ["translate"] as const;
/** Tracker members that are data, not calls, present as their capabilities say. */
export const TRACKER_DATA_OPTIONAL = ["webhook"] as const;
/** Tracker groups of operations, with their members. */
export const TRACKER_GROUPS = {
  transitions: ["list", "apply"],
  worklogs: ["list", "get", "changed", "create", "update", "delete", "setDayTotal", "activities"],
  timeCounter: ["read", "increment", "decrement"],
  comments: ["list", "add"],
  manage: ["assignable", "assign", "labelOptions", "setLabels", "create", "edit", "createTypes", "createFields"],
} as const;

export const SINK_REQUIRED = ["parseOptions", "verify", "probe"] as const;
export const SINK_OPTIONAL = ["targets"] as const;
export const SINK_GROUPS = { entries: ["list", "changed", "create", "update", "delete", "setDayTotal", "activities"] } as const;

/** Operations that take a call context first: bound to a connection by core/bind.ts. */
export const TRACKER_CALLS = [...TRACKER_REQUIRED.filter((n) => n !== "parseOptions" && n !== "normalizeKey" && n !== "parseRef"), ...TRACKER_OPTIONAL] as const;
export const SINK_CALLS = ["verify", "probe", ...SINK_OPTIONAL] as const;

type Tracker = TrackerProvider;
type Sink = TimeSinkProvider;

/** Compile-time: the lists name every operation of the interfaces, and nothing else. */
type Methods<T> = { [K in keyof T]-?: NonNullable<T[K]> extends (...a: never[]) => unknown ? K : never }[keyof T];
type Groups<T> = { [K in keyof T]-?: NonNullable<T[K]> extends (...a: never[]) => unknown ? never : NonNullable<T[K]> extends object ? K : never }[keyof T];
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type TrackerMethodsCovered = Exact<Methods<Tracker>, (typeof TRACKER_REQUIRED)[number] | (typeof TRACKER_OPTIONAL)[number] | (typeof TRACKER_PURE_OPTIONAL)[number]>;
export type TrackerGroupsCovered = Exact<Exclude<Groups<Tracker>, "capabilities" | "traits" | "settings" | (typeof TRACKER_DATA_OPTIONAL)[number]>, keyof typeof TRACKER_GROUPS>;
export type TrackerGroupMembersCovered = {
  [G in keyof typeof TRACKER_GROUPS]: Exact<keyof NonNullable<Tracker[G]>, (typeof TRACKER_GROUPS)[G][number]>;
};
export type SinkMethodsCovered = Exact<Methods<Sink>, (typeof SINK_REQUIRED)[number] | (typeof SINK_OPTIONAL)[number]>;
export type SinkGroupsCovered = Exact<Exclude<Groups<Sink>, "capabilities" | "traits">, keyof typeof SINK_GROUPS>;
export type SinkGroupMembersCovered = Exact<keyof Sink["entries"], (typeof SINK_GROUPS)["entries"][number]>;
