// The checks every provider adapter passes, run from each adapter's own test
// against simulated or recorded answers, always through the binding (so
// errors arrive normalized and results are held to the contract, as in the
// app). The sync engine's own rules (replay of a cut pass, transfers,
// "missing", recreate with compensation) are tested with the engine (WP-08).
import { describe, expect, it } from "vitest";
import { STATUS_CATEGORIES, type EntryCapabilities } from "@contracts/providers";
import { instant, localDate, markdown } from "@contracts/values";
import { bindSink, bindTracker, type BoundTracker, type CallMeta, type StoredConn, type StoredSinkConn } from "../core/bind";
import { ProviderError } from "../core/errors";
import { providerProblems } from "../core/validate";
import type { Checkpoint, ExternalRef, IssueRef, RemoteIssue, TimeInput, TimeSinkProvider, TrackerProvider } from "../types";
import type { TimeSinkType, TrackerType } from "@contracts/providers";
import { readPass } from "../core/paging";

const meta = (signal = new AbortController().signal): CallMeta => ({ signal, correlationId: "conformance" });

/** Every page of one pass, refusing a pass that repeats a token or never ends. */
export { readPass };

/** A span of the shape a service keeps. */
export function timeFor(shape: "session" | "date", seconds: number): TimeInput {
  return shape === "session" ? { kind: "session", start: instant(Date.UTC(2026, 9, 14, 8, 30)), seconds } : { kind: "date", date: localDate("2026-10-14"), seconds };
}

const refOf = (i: RemoteIssue): IssueRef => ({ remoteId: i.remoteId, key: i.key, container: { remoteId: i.container.remoteId, key: i.container.key } });

const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ProviderError ? e.kind : `not a ProviderError: ${String(e)}`;
  }
};

export type TrackerSetup<T extends TrackerType, O> = {
  provider: TrackerProvider<T, O>;
  conn: StoredConn<T>;
  /** An issue of the user's, present on the service */
  key: string;
  /** Whether the test may write (entries, comments, transitions) */
  writable: boolean;
  /** A URL of that issue, as someone would paste it */
  url?: string;
};

export function trackerConformance<T extends TrackerType, O>(name: string, setup: () => Promise<TrackerSetup<T, O>>) {
  const bound = async () => {
    const s = await setup();
    return { ...s, b: bindTracker(s.provider, s.conn) };
  };
  const entriesOf = (b: BoundTracker): EntryCapabilities | null => (b.capabilities.time.mode === "entries" ? b.capabilities.time.entries : null);

  describe(`tracker conformance: ${name}`, () => {
    it("holds to the contract: capabilities valid, operations present exactly as declared, all callable", async () => {
      const { provider } = await setup();
      expect(providerProblems(provider)).toEqual([]);
    });

    it("refuses options it can't read", async () => {
      const { provider, conn } = await setup();
      expect(() => bindTracker(provider, { ...conn, options: 42 })).toThrow(ProviderError);
    });

    it("knows who the credentials belong to, and its probe narrows the provider", async () => {
      const { b } = await bound();
      expect((await b.verify(meta())).remoteId).toMatch(/\S/);
      const probe = await b.probe(meta());
      expect(probe.activeSources.length).toBeGreaterThan(0);
    });

    it("reads keys and pasted links, and refuses what isn't one", async () => {
      const { b, key, url } = await bound();
      expect(b.normalizeKey(key)).toBe(key);
      expect(b.normalizeKey("  not a key!! ")).toBeNull();
      expect(b.parseRef(key)).toEqual({ key });
      if (url) expect(b.parseRef(url)).toMatchObject({ key });
      expect(b.parseRef("https://elsewhere.example/whatever")).toBeNull();
    });

    it("lists the user's items a pass at a time, the same way twice, then only what changed since", async () => {
      const { b, key } = await bound();
      const all = await readPass((q) => b.listChanged(meta(), q), null);
      expect(all.items.map((i) => i.key)).toContain(key);
      for (const i of all.items) {
        expect(i.remoteId).toMatch(/\S/);
        expect(b.normalizeKey(i.key)).toBe(i.key);
        expect(STATUS_CATEGORIES).toContain(i.status.category);
        expect(i.url).toMatch(/^https?:\/\//);
        expect(i.container.remoteId).toMatch(/\S/);
      }
      expect(new Set(all.items.map((i) => i.remoteId)).size, "no item twice in a pass").toBe(all.items.length);
      const again = await readPass((q) => b.listChanged(meta(), q), null);
      expect(again.items.map((i) => i.remoteId)).toEqual(all.items.map((i) => i.remoteId));
      if (b.capabilities.sync.issueCheckpoints) {
        expect(all.checkpoint).not.toBeNull();
        const since = await readPass((q) => b.listChanged(meta(), q), all.checkpoint);
        expect(since.items.length).toBeLessThanOrEqual(all.items.length);
      } else expect(all.checkpoint).toBeNull();
    });

    it("refuses a checkpoint or page token of another connection, stream or pass", async () => {
      const { b, conn, provider } = await bound();
      if (!b.capabilities.sync.issueCheckpoints) return;
      const mine = (await readPass((q) => b.listChanged(meta(), q), null)).checkpoint;
      const other = bindTracker(provider, { ...conn, id: conn.id + 1 });
      expect(await kindOf(other.listChanged(meta(), { since: mine, page: null }))).toBe("invalidCheckpoint");
      expect(await kindOf(b.listChanged(meta(), { since: "garbage" as Checkpoint, page: null }))).toBe("invalidCheckpoint");
      if (b.worklogs?.changed) expect(await kindOf(b.worklogs.changed(meta(), { since: mine, page: null })), "an issues checkpoint on the worklogs stream").toBe("invalidCheckpoint");
      const first = await b.listChanged(meta(), { since: null, page: null });
      if (!first.last) expect(await kindOf(b.listChanged(meta(), { since: mine, page: first.next })), "a page of another pass").toBe("invalidCheckpoint");
    });

    it("finds an issue by reference, by key and by link; none for an unknown key", async () => {
      const { b, key, url } = await bound();
      const found = await b.findIssue(meta(), { key });
      expect(found.kind).toBe("found");
      if (found.kind !== "found") return;
      expect((await b.getIssue(meta(), refOf(found.issue)))?.remoteId).toBe(found.issue.remoteId);
      if (url) {
        const handle = b.parseRef(url);
        expect(handle && (await b.findIssue(meta(), handle)).kind).toBe("found");
      }
      expect((await b.findIssue(meta(), { key: key.replace(/\d+$/, "999999") })).kind).toBe("none");
    });

    it("offers the service's own ways out of a status, and moves along one", async () => {
      const { b, key, writable } = await bound();
      if (!b.transitions?.list) return;
      const found = await b.findIssue(meta(), { key });
      if (found.kind !== "found") throw new Error("no issue");
      const ways = await b.transitions.list(meta(), refOf(found.issue));
      for (const t of ways) {
        expect(STATUS_CATEGORIES).toContain(t.to.category);
        expect(t.remoteUrl === null || /^https?:\/\//.test(t.remoteUrl)).toBe(true);
      }
      const [way] = ways;
      if (!writable || !way || !b.transitions.apply) return;
      const after = await b.transitions.apply(meta(), refOf(found.issue), way.id, {});
      const now = after ?? (await b.getIssue(meta(), refOf(found.issue)));
      expect(now?.status.name).toBe(way.to.name);
    });

    it("gives back logged time as logged, honours revisions and keys, deletes twice without fuss", async () => {
      const { b, key, writable } = await bound();
      const e = entriesOf(b);
      if (!b.worklogs || !e || e.model !== "entries" || e.write.mode !== "entry" || !writable) return;
      const found = await b.findIssue(meta(), { key });
      if (found.kind !== "found") throw new Error("no issue");
      const ref = refOf(found.issue);
      const before = b.worklogs.changed ? (await readPass((q) => b.worklogs!.changed!(meta(), q), null)).checkpoint : null;
      const made = await b.worklogs.create!(meta(), ref, { time: timeFor(e.shape, 5400), comment: "conformance" }, { idempotencyKey: "k-1" });
      expect(made.span).toMatchObject({ kind: e.shape, seconds: 5400 });
      expect((await b.worklogs.list(meta(), ref)).map((w) => w.remoteId)).toContain(made.remoteId);
      if (e.idempotency === "native") {
        const again = await b.worklogs.create!(meta(), ref, { time: timeFor(e.shape, 5400), comment: "conformance" }, { idempotencyKey: "k-1" });
        expect(again.remoteId, "a retried create with the same key").toBe(made.remoteId);
      }
      if (b.worklogs.update) {
        const version = made.version ?? undefined;
        if (e.concurrency === "revision") expect(await kindOf(b.worklogs.update(meta(), ref, made.remoteId, { time: timeFor(e.shape, 60), comment: "x" }, { expectedVersion: "stale" }))).toBe("conflict");
        const changed = await b.worklogs.update(meta(), ref, made.remoteId, { time: timeFor(e.shape, 1800), comment: "changed" }, { expectedVersion: version });
        expect(changed.span.seconds).toBe(1800);
      }
      if (b.worklogs.changed) {
        const feed = await readPass((q) => b.worklogs!.changed!(meta(), q), before);
        expect(feed.items.map((w) => w.remoteId)).toContain(made.remoteId);
      }
      if (e.write.delete && b.worklogs.delete) {
        await b.worklogs.delete(meta(), ref, made.remoteId, {});
        await b.worklogs.delete(meta(), ref, made.remoteId, {});
        expect((await b.worklogs.list(meta(), ref)).map((w) => w.remoteId)).not.toContain(made.remoteId);
        if (b.worklogs.changed && e.feed.kind === "incremental" && e.feed.removals) {
          const feed = await readPass((q) => b.worklogs!.changed!(meta(), q), before);
          expect(feed.gone.map((g) => g.remoteId)).toContain(made.remoteId);
        }
      }
    });

    it("writes comments from markdown; conversion warnings never carry server details", async () => {
      const { b, key, writable } = await bound();
      if (!b.comments?.add || !writable) return;
      const found = await b.findIssue(meta(), { key });
      if (found.kind !== "found") throw new Error("no issue");
      const { comment, warnings } = await b.comments.add(meta(), refOf(found.issue), markdown("Checked **twice**\n\n| a | b |\n|---|---|"), { idempotencyKey: "c-1" });
      for (const w of warnings) expect(w).not.toHaveProperty("serverDetail");
      if (comment) expect((await b.comments.list(meta(), refOf(found.issue))).map((c) => c.id)).toContain(comment.id);
    });

    it("stops when the caller cancels: a cancelled call fails as cancelled", async () => {
      const { b } = await bound();
      const ctl = new AbortController();
      ctl.abort();
      expect(await kindOf(b.verify(meta(ctl.signal)))).toBe("cancelled");
    });
  });
}

export type SinkSetup<T extends TimeSinkType, O> = {
  provider: TimeSinkProvider<T, O>;
  conn: StoredSinkConn<T>;
  ref: ExternalRef;
  writable: boolean;
};

export function sinkConformance<T extends TimeSinkType, O>(name: string, setup: () => Promise<SinkSetup<T, O>>) {
  const bound = async () => {
    const s = await setup();
    return { ...s, b: bindSink(s.provider, s.conn) };
  };

  describe(`time sink conformance: ${name}`, () => {
    it("holds to the contract: capabilities valid, operations present exactly as declared, all callable", async () => {
      const { provider } = await setup();
      expect(providerProblems(provider)).toEqual([]);
    });

    it("knows who the credentials belong to, and its probe narrows the provider", async () => {
      const { b } = await bound();
      expect((await b.verify(meta())).remoteId).toMatch(/\S/);
      await b.probe(meta());
    });

    it("keeps an entry pointing back at its issue, as precisely as it says, and lets it go", async () => {
      const { b, ref, writable } = await bound();
      const e = b.capabilities.entries;
      if (!writable || e.model !== "entries" || e.write.mode !== "entry" || !b.entries.create) return;
      const target = b.capabilities.target.use === "none" ? null : b.targets ? (await b.targets(meta(), "", 10)).items[0] ?? null : null;
      if (b.capabilities.target.use === "required") expect(target, "a required target can be found").not.toBeNull();
      const activity = e.activities.write && b.entries.activities ? (await b.entries.activities(meta(), { target: target ?? undefined }, 50)).items[0]?.id : undefined;
      const made = await b.entries.create(meta(), ref, target, { time: timeFor(e.shape, 3600), comment: "conformance", activityId: activity }, { idempotencyKey: "s-1" });
      expect(made.span).toMatchObject({ kind: e.shape, seconds: 3600 });
      expect(made.issue?.remoteId ?? made.issue?.key).toBeTruthy();
      const list = await b.entries.list(meta(), { from: localDate("2026-10-01"), to: localDate("2026-10-31") });
      expect(list.map((x) => x.remoteId)).toContain(made.remoteId);
      if (b.entries.update) expect((await b.entries.update(meta(), made.remoteId, { time: timeFor(e.shape, 1800), comment: "c", activityId: activity }, {})).span.seconds).toBe(1800);
      if (b.entries.delete) {
        await b.entries.delete(meta(), made.remoteId, {});
        await b.entries.delete(meta(), made.remoteId, {});
        expect((await b.entries.list(meta(), { from: localDate("2026-10-01"), to: localDate("2026-10-31") })).map((x) => x.remoteId)).not.toContain(made.remoteId);
      }
    });
  });
}
