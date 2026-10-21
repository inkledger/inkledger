import { describe, expect, it } from "vitest";
import {
  PROVIDER_TYPES,
  TIME_SINK_TYPES,
  TRACKER_TYPES,
  connectionSummarySchema,
  entryCapabilitiesSchema,
  limitsSchema,
  rateFigureSchema,
  rateLimitFigureSchema,
  roleOf,
  timeSinkCapabilitiesSchema,
} from "@contracts/providers";

const entries = {
  model: "entries",
  shape: "session",
  write: { mode: "entry", update: "native", delete: true },
  feed: { kind: "incremental", removals: true },
  reconcile: { kind: "period" },
  billable: { read: false, write: false },
  activities: { read: false, write: false, required: "no" },
  onBehalf: { read: false, write: false },
  approvals: { read: false },
  idempotency: "local",
  concurrency: "none",
  limits: {},
};

describe("provider schemas (the installed zod, real parses)", () => {
  it("provider types: none twice, none in both roles, each with its role", () => {
    expect(new Set(PROVIDER_TYPES).size).toBe(PROVIDER_TYPES.length);
    expect(TRACKER_TYPES.filter((t) => (TIME_SINK_TYPES as readonly string[]).includes(t))).toEqual([]);
    for (const t of TRACKER_TYPES) expect(roleOf(t)).toBe("tracker");
    for (const t of TIME_SINK_TYPES) expect(roleOf(t)).toBe("timeSink");
  });

  it("entry capabilities: refinements inside the discriminated union run", () => {
    expect(entryCapabilitiesSchema.safeParse(entries).success).toBe(true);
    expect(entryCapabilitiesSchema.safeParse({ ...entries, write: { mode: "entry", update: "recreate", delete: false } }).success).toBe(false);
    expect(entryCapabilitiesSchema.safeParse({ ...entries, write: { mode: "none" }, concurrency: "revision" }).success).toBe(false);
    expect(entryCapabilitiesSchema.safeParse({ ...entries, write: { mode: "none" }, billable: { read: true, write: true } }).success).toBe(false);
    expect(entryCapabilitiesSchema.safeParse({ ...entries, extra: 1 }).success, "strict").toBe(false);
    const shared = { feed: entries.feed, reconcile: entries.reconcile, approvals: entries.approvals, idempotency: entries.idempotency, concurrency: entries.concurrency, limits: entries.limits };
    expect(entryCapabilitiesSchema.safeParse({ ...shared, model: "dayTotals", write: { set: true } }).success).toBe(true);
    expect(entryCapabilitiesSchema.safeParse({ ...shared, model: "dayTotals", write: { set: false }, concurrency: "revision" }).success).toBe(false);
    expect(entryCapabilitiesSchema.safeParse({ ...shared, model: "dayTotals", write: { set: true }, feed: { kind: "window", by: "updatedAt", lookbackMs: 10, overlapMs: 1 } }).success).toBe(false);
  });

  it("windows, limits and budgets keep their invariants", () => {
    expect(entryCapabilitiesSchema.safeParse({ ...entries, feed: { kind: "window", by: "entryDate", days: 7, overlapDays: 8 } }).success).toBe(false);
    expect(entryCapabilitiesSchema.safeParse({ ...entries, feed: { kind: "window", by: "updatedAt", lookbackMs: 1000, overlapMs: 100 } }).success).toBe(true);
    expect(limitsSchema.safeParse({ minSeconds: 600, maxSeconds: 60 }).success).toBe(false);
    expect(limitsSchema.safeParse({ minSeconds: 60, increment: { seconds: 900, rounding: "up" } }).success, "limits need not align").toBe(true);
    expect(limitsSchema.safeParse({ maxAgeDays: 0 }).success, "only today").toBe(true);
    expect(rateFigureSchema.safeParse({}).success).toBe(false);
    expect(rateFigureSchema.safeParse({ perHour: 30 }).success).toBe(true);
    expect(rateLimitFigureSchema.safeParse({ perHour: 30, origin: "typical" }).success, "figure and origin together").toBe(true);
    expect(rateLimitFigureSchema.safeParse({ origin: "typical" }).success).toBe(false);
    expect(rateLimitFigureSchema.safeParse({ perSecond: 5, origin: "typical", extra: 1 }).success).toBe(false);
  });

  it("time sinks: a project/task reference needs a target, not the other way round", () => {
    const sink = { entries, references: ["description"], target: { use: "none" } };
    expect(timeSinkCapabilitiesSchema.safeParse(sink).success).toBe(true);
    expect(timeSinkCapabilitiesSchema.safeParse({ ...sink, references: ["projectTask"] }).success).toBe(false);
    expect(timeSinkCapabilitiesSchema.safeParse({ ...sink, target: { use: "required", lookup: "manual" } }).success).toBe(true);
    expect(timeSinkCapabilitiesSchema.safeParse({ ...sink, references: [] }).success).toBe(false);
    expect(timeSinkCapabilitiesSchema.safeParse({ ...sink, references: ["external", "external"] }).success).toBe(false);
  });

  it("connection summaries: role, type, state and error agree; hosts are hosts", () => {
    const base = {
      id: 1,
      role: "timeSink",
      type: "harvest",
      label: "Billing",
      host: "api.harvestapp.com",
      status: "ok",
      lastError: null,
      capabilities: { entries, references: ["external"], target: { use: "none" } },
      verifiedAt: 0,
    };
    expect(connectionSummarySchema.safeParse(base).success).toBe(true);
    expect(connectionSummarySchema.safeParse({ ...base, type: "jira" }).success, "a tracker type in a time sink").toBe(false);
    expect(connectionSummarySchema.safeParse({ ...base, status: "authFailed" }).success, "a failed state without its error").toBe(false);
    expect(connectionSummarySchema.safeParse({ ...base, status: "authFailed", lastError: { code: "authRejected", at: 5 } }).success).toBe(true);
    expect(connectionSummarySchema.safeParse({ ...base, status: "unreachable", lastError: { code: "authRejected", at: 5 } }).success).toBe(false);
    for (const host of ["localhost", "jira.example.org", "jira.example.org:8443", "10.0.0.5", "10.0.0.5:8080", "[::1]", "[::1]:3000", "[fd00::5]"]) expect(connectionSummarySchema.safeParse({ ...base, host }).success, host).toBe(true);
    for (const host of ["https://jira.example.org", "-bad.example", "bad-.example", "a..b", "jira.example.org:0", "jira.example.org:65536", "jira.example.org:70000", "[::1]:0", ""]) expect(connectionSummarySchema.safeParse({ ...base, host }).success, host).toBe(false);
    expect(connectionSummarySchema.safeParse({ ...base, lastError: { code: "serviceDown", at: 5 } }).success, "ok with an error").toBe(false);
    expect(connectionSummarySchema.safeParse({ ...base, extra: true }).success, "strict").toBe(false);
  });
});
