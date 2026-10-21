import { describe, expect, it } from "vitest";
import { instant } from "@contracts/values";
import { fakeTrackerCapabilities } from "../fake/adapter";
import { executable, assertTransitionFields } from "./fields";
import { checkActiveSources, checkEntryPage, checkFind } from "./results";
import { assertRevision, assertSeconds, fitDuration } from "./time";
import { trackerProbeExceeds } from "./validate";
import { readPass } from "../conformance/suite";
import { ProviderError } from "./errors";
import type { RemoteIssue, Transition, TrackerProbe, PageToken } from "../types";

const caps = fakeTrackerCapabilities();
const issue = (remoteId: string) => ({ remoteId, key: `A-${remoteId}` }) as RemoteIssue;
const kindOf = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof ProviderError ? e.kind : String(e);
  }
};

describe("durations and amounts", () => {
  it("are rounded to the increment, then refused (never clamped) outside the limits", () => {
    const limits = { minSeconds: 600, maxSeconds: 8 * 3600, increment: { seconds: 900, rounding: "up" as const } };
    expect(fitDuration(1, limits)).toBe(900);
    expect(fitDuration(1800, limits)).toBe(1800);
    expect(kindOf(() => fitDuration(9 * 3600, limits))).toBe("invalid");
    expect(kindOf(() => fitDuration(0, limits))).toBe("invalid");
    expect(kindOf(() => fitDuration(300, { minSeconds: 600 }))).toBe("invalid");
  });

  it("counters move by positive whole seconds; day totals may be zero", () => {
    expect(kindOf(() => assertSeconds(-60))).toBe("invalid");
    expect(kindOf(() => assertSeconds(1.5))).toBe("invalid");
    expect(kindOf(() => assertSeconds(0))).toBe("invalid");
    expect(kindOf(() => assertSeconds(0, true))).toBe("ok");
  });

  it("a service with revisions takes changes only at a known one", () => {
    expect(kindOf(() => assertRevision("revision", undefined))).toBe("invalid");
    expect(kindOf(() => assertRevision("revision", "3"))).toBe("ok");
    expect(kindOf(() => assertRevision("none", undefined))).toBe("ok");
  });
});

describe("transition fields", () => {
  const to = { id: "done", name: "Done", category: "done" as const, categoryOrigin: { by: "native" as const }, source: { kind: "itemState" as const } };
  const t = (requirements: Transition["requirements"]): Transition => ({ id: "1", name: "Resolve", to, requirements, remoteUrl: null });

  it("a required field of an unknown type: not executable by inkledger", () => {
    expect(executable(t([{ id: "x", name: "X", required: true, type: "unknown", nativeType: "com.custom" }]))).toBe(false);
    expect(executable(t([{ id: "x", name: "X", required: false, type: "unknown", nativeType: "com.custom" }]))).toBe(true);
  });

  it("values must fill what is asked, as asked, and nothing else", () => {
    const resolve = t([{ id: "resolution", name: "Resolution", required: true, type: "choice", options: [{ id: "1", name: "Done" }] }]);
    expect(kindOf(() => assertTransitionFields(resolve, {}))).toBe("invalid");
    expect(kindOf(() => assertTransitionFields(resolve, { resolution: "9" }))).toBe("invalid");
    expect(kindOf(() => assertTransitionFields(resolve, { resolution: "1", extra: "x" }))).toBe("invalid");
    expect(kindOf(() => assertTransitionFields(resolve, { resolution: "1" }))).toBe("ok");
  });
});

describe("results held to the contract", () => {
  it("an ambiguous lookup lists distinct issues", () => {
    expect(kindOf(() => checkFind({ kind: "ambiguous", candidates: [issue("1"), issue("2")] }))).toBe("ok");
    expect(kindOf(() => checkFind({ kind: "ambiguous", candidates: [issue("1"), issue("1")] }))).toBe("incompatible");
  });

  it("removals only from a feed that declares them", () => {
    const e = caps.time.mode === "entries" ? caps.time.entries : null;
    if (!e || e.model !== "entries") throw new Error("fake has entries");
    const page = { last: true as const, items: [], gone: [{ remoteId: "w", reason: "deleted" as const }], checkpoint: null };
    expect(kindOf(() => checkEntryPage(e, page))).toBe("ok");
    expect(kindOf(() => checkEntryPage({ ...e, feed: { kind: "incremental", removals: false } }, page))).toBe("incompatible");
  });

  it("active workflow sources: each once, each of a declared kind", () => {
    const one = { kind: "itemState" as const, transitions: "direct" as const, ref: { kind: "itemState" as const }, name: "W" };
    const probe = (activeSources: TrackerProbe["activeSources"]): TrackerProbe => ({ capabilities: caps, activeSources, verifiedAt: instant(1) });
    expect(kindOf(() => checkActiveSources(probe([one])))).toBe("ok");
    expect(kindOf(() => checkActiveSources(probe([one, one])))).toBe("incompatible");
    expect(kindOf(() => checkActiveSources(probe([{ kind: "column", transitions: "move", ref: { kind: "column", boardRemoteId: "b" }, name: "B" }])))).toBe("incompatible");
  });

  it("a probe may narrow (less, tighter) but never widen", () => {
    const base = { activeSources: [], verifiedAt: instant(1) };
    const entries = caps.time.mode === "entries" ? caps.time.entries : null;
    if (!entries || entries.model !== "entries" || entries.write.mode !== "entry") throw new Error("fake has entries");
    const narrower = {
      ...caps,
      searchText: false,
      time: { mode: "entries" as const, entries: { ...entries, write: { ...entries.write, update: "recreate" as const }, limits: { maxSeconds: 3600 } } },
    };
    expect(trackerProbeExceeds(caps, { ...base, capabilities: narrower })).toEqual([]);
    expect(trackerProbeExceeds(caps, { ...base, capabilities: { ...caps, watch: true } })).toEqual(["watch"]);
    const looser = { ...caps, time: { mode: "entries" as const, entries: { ...entries, limits: { maxSeconds: 48 * 3600 } } } };
    expect(trackerProbeExceeds(caps, { ...base, capabilities: looser })).toEqual(["time.entries.limits.maxSeconds"]);
  });
});

describe("reading a pass", () => {
  it("refuses a page token that comes back (a loop)", async () => {
    const token = "pg1.loop" as PageToken;
    await expect(readPass(async () => ({ last: false, items: [], gone: [], next: token }), null)).rejects.toThrow(/came back twice/);
  });
});
