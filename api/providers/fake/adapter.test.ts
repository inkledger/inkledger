import { describe, expect, it } from "vitest";
import { timeZone } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { ProviderError } from "../core/errors";
import { sinkConformance, trackerConformance, readPass } from "../conformance/suite";
import { fakeSink, fakeTracker } from "./adapter";

const conn = { id: 1, userId: 1, type: "jira" as const, baseUrl: "https://fake.example", remoteAccountId: "me", options: { region: "eu" }, timeZone: timeZone("Europe/Rome"), credential: async () => ({ kind: "token" as const, token: "t" }) };
const seed = [
  { key: "FAKE-1", title: "First" },
  { key: "FAKE-2", title: "Second", category: "doing" as const },
  { key: "FAKE-3", title: "Third" },
  { key: "OPS-4", title: "Fourth" },
  { key: "OPS-5", title: "Fifth", category: "done" as const },
];

trackerConformance("fake tracker (pages of 2)", async () => ({ provider: fakeTracker(seed), conn, key: "FAKE-1", writable: true, url: "https://fake.example/items/FAKE-1" }));
trackerConformance("fake tracker whose entries can only be recreated, without comments", async () => ({ provider: fakeTracker(seed, { entryUpdate: false, comments: false }), conn, key: "FAKE-1", writable: true }));

sinkConformance("fake time sink", async () => ({
  provider: fakeSink(),
  conn: { ...conn, type: "harvest" as const },
  ref: { trackerType: "jira", trackerConnectionId: 1, issue: { remoteId: "r-1", key: "FAKE-1" }, snapshot: { url: "https://fake.example/items/FAKE-1", title: "First" } },
  writable: true,
}));

const meta = { signal: new AbortController().signal, correlationId: "t" };
const kindOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ProviderError ? e.kind : String(e)));

describe("the binding catches an adapter that breaks the contract", () => {
  it("a removal reason it didn't declare", async () => {
    const b = bindTracker(fakeTracker(seed, { misbehave: "gonePastCapabilities" }), conn);
    expect(await kindOf(readPass((q) => b.listChanged(meta, q), null))).toBe("incompatible");
  });

  it("an entry marked locked and editable", async () => {
    const p = fakeTracker(seed, { misbehave: "editableWhenLocked" });
    const b = bindTracker(p, conn);
    const ref = { remoteId: "r-1", key: "FAKE-1" };
    expect(await kindOf(b.worklogs!.create!(meta, ref, { time: { kind: "session", start: 1_700_000_000_000 as never, seconds: 60 }, comment: "x" }, { idempotencyKey: "k" }))).toBe("incompatible");
  });

  it("a probe claiming more than the provider", async () => {
    const b = bindTracker(fakeTracker(seed, { misbehave: "probeWidens" }), conn);
    expect(await kindOf(b.probe(meta))).toBe("incompatible");
  });
});

describe("what happens on the service outside inkledger", () => {
  it("a move with a new id comes as gone, transferred, with its successor", async () => {
    const p = fakeTracker(seed);
    const b = bindTracker(p, conn);
    const first = await readPass((q) => b.listChanged(meta, q), null);
    const old = first.items.find((i) => i.key === "FAKE-1")!;
    p.outside.moveWithNewId("FAKE-1", "OPS-9");
    const next = await readPass((q) => b.listChanged(meta, q), first.checkpoint);
    expect(next.gone).toEqual([{ remoteId: old.remoteId, reason: "transferred", successor: { remoteId: expect.any(String), key: "OPS-9" } }]);
    expect(next.items.map((i) => i.key)).toContain("OPS-9");
  });

  it("someone else changed an entry: an update at the old revision is a conflict", async () => {
    const p = fakeTracker(seed);
    const b = bindTracker(p, conn);
    const ref = { remoteId: "r-1", key: "FAKE-1" };
    const made = await b.worklogs!.create!(meta, ref, { time: { kind: "session", start: 1_700_000_000_000 as never, seconds: 60 }, comment: "x" }, { idempotencyKey: "k2" });
    p.outside.touchWorklog(made.remoteId);
    expect(await kindOf(b.worklogs!.update!(meta, ref, made.remoteId, { time: { kind: "session", start: 1_700_000_000_000 as never, seconds: 120 }, comment: "y" }, { expectedVersion: made.version ?? undefined }))).toBe("conflict");
  });
});
