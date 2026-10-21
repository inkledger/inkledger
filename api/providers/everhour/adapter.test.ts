import { describe, expect, it, vi } from "vitest";
import { localDate, timeZone } from "@contracts/values";
import { bindSink } from "../core/bind";
import { sinkConformance } from "../conformance/suite";
import { everhourSimulator } from "./simulator";
import { everhourSink, EVERHOUR_PREFIX, noteOf, taskIdOf } from "./adapter";
import type { ExternalRef } from "../types";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "104.18.20.35", family: 4 }]),
}));

const ISSUE: ExternalRef = {
  trackerType: "jira",
  trackerConnectionId: 3,
  issue: { remoteId: "10001", key: "ABC-12" },
  snapshot: { url: "https://jira.example.com/browse/ABC-12", title: "Fix the login" },
};
const OTHER: ExternalRef = { ...ISSUE, issue: { remoteId: "10002", key: "ABC-13" }, snapshot: { url: "", title: "Second" } };

function simulated(o: { zone?: string; token?: string } = {}) {
  const sim = everhourSimulator();
  sim.task("ji:10001", "Fix the login");
  sim.task("ji:10002", "Second");
  sim.task("ev:77", "Admin work");
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 9,
    userId: 1,
    type: "everhour" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: String(sim.me.id),
    options: {},
    timeZone: timeZone(o.zone ?? "Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.key }),
  };
  return { sim, conn, b: bindSink(everhourSink, conn) };
}

sinkConformance("everhour (simulated)", async () => {
  const { conn } = simulated();
  return { provider: everhourSink, conn, ref: ISSUE, writable: true };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const day = localDate("2026-03-10");
const range = { from: localDate("2026-03-01"), to: localDate("2026-03-31") };
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; rateLimit?: { retryAfterMs?: number }; message: string });

describe("everhour, who and what", () => {
  it("knows the key's owner and declares no budget it doesn't know", async () => {
    const { b } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: "4711", name: "Mario Rossi", email: "mario@example.com" });
    const probe = await b.probe(meta());
    expect(probe.rateLimit).toBeUndefined();
    expect(b.targets).toBeUndefined();
    expect(Object.keys(b.entries).sort()).toEqual(["list", "setDayTotal"]);
  });

  it("takes empty options only; the key stays in the credential", () => {
    expect(everhourSink.parseOptions(undefined)).toEqual({});
    expect(() => everhourSink.parseOptions({ workspace: "x" })).toThrow(/Everhour options/);
  });

  it("sends the key in X-Api-Key and nothing in the URL", async () => {
    const { sim, b } = simulated();
    const seen: Request[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(String(input), init));
      return sim.fetch(input, init);
    });
    await b.entries.list(meta(), range);
    expect(seen[0].headers.get("x-api-key")).toBe(sim.key);
    expect(seen[0].url).not.toContain(sim.key);
  });
});

describe("everhour, day totals", () => {
  it("sets a day's total on the issue's task with its key and title in the note, and reads it back", async () => {
    const { sim, b } = simulated();
    const made = await b.entries.setDayTotal!(meta(), ISSUE, null, day, 5400, { idempotencyKey: "k" });
    expect(made).toMatchObject({ remoteId: "ji:10001@2026-03-10", span: { kind: "dayTotal", date: "2026-03-10", seconds: 5400 }, issue: { remoteId: "10001" }, approval: "none" });
    expect(sim.mine()).toMatchObject([{ task: "ji:10001", date: "2026-03-10", time: 5400, comment: "ABC-12: Fix the login" }]);
    expect(noteOf(ISSUE)).toBe("ABC-12: Fix the login");
    const list = await b.entries.list(meta(), range);
    expect(list.map((w) => [w.remoteId, w.span, w.comment])).toEqual([["ji:10001@2026-03-10", { kind: "dayTotal", date: "2026-03-10", seconds: 5400 }, "ABC-12: Fix the login"]]);
  });

  it("trap: PUT replaces, it doesn't add: setting the same day twice (a retry) is one total, never double", async () => {
    const { sim, b } = simulated();
    await b.entries.setDayTotal!(meta(), ISSUE, null, day, 3600, { idempotencyKey: "k" });
    await b.entries.setDayTotal!(meta(), ISSUE, null, day, 3600, { idempotencyKey: "k" });
    await b.entries.setDayTotal!(meta(), ISSUE, null, day, 7200, { idempotencyKey: "k2" });
    expect(sim.mine().map((r) => r.time)).toEqual([7200]);
    // The same service adds when asked with POST: the adapter never does.
    const posted = await sim.fetch(`${sim.apiBase}/tasks/ji:10001/time`, { method: "POST", headers: { "X-Api-Key": sim.key }, body: JSON.stringify({ time: 60, date: day }) });
    expect(posted.status).toBe(200);
    expect(sim.mine().map((r) => r.time)).toEqual([7260]);
  });

  it("trap: no idempotency key; a write whose answer was lost has landed, and its retry changes nothing", async () => {
    const { sim, b } = simulated();
    sim.loseNextAnswer();
    expect((await errorOf(b.entries.setDayTotal!(meta(), ISSUE, null, day, 1800, { idempotencyKey: "k" })))?.kind).toBe("unavailable");
    expect(sim.mine().map((r) => r.time)).toEqual([1800]);
    await b.entries.setDayTotal!(meta(), ISSUE, null, day, 1800, { idempotencyKey: "k" });
    expect(sim.mine().map((r) => r.time)).toEqual([1800]);
  });

  it("trap: a total of 0 removes the day; removing what isn't there is done", async () => {
    const { sim, b } = simulated();
    await b.entries.setDayTotal!(meta(), ISSUE, null, day, 600, { idempotencyKey: "k" });
    expect(await b.entries.setDayTotal!(meta(), ISSUE, null, day, 0, { idempotencyKey: "del" })).toBeNull();
    expect(sim.mine()).toEqual([]);
    expect(await b.entries.setDayTotal!(meta(), ISSUE, null, day, 0, { idempotencyKey: "del" })).toBeNull();
    // Even for a task Everhour doesn't have.
    expect(await b.entries.setDayTotal!(meta(), { ...ISSUE, issue: { remoteId: "999", key: "ABC-99" } }, null, day, 0, { idempotencyKey: "del" })).toBeNull();
  });

  it("two issues on one day are two records; each total is its own", async () => {
    const { sim, b } = simulated();
    await b.entries.setDayTotal!(meta(), ISSUE, null, day, 3600, { idempotencyKey: "a" });
    await b.entries.setDayTotal!(meta(), OTHER, null, day, 1800, { idempotencyKey: "b" });
    expect(sim.mine().map((r) => [r.task, r.time])).toEqual([["ji:10001", 3600], ["ji:10002", 1800]]);
    await b.entries.setDayTotal!(meta(), ISSUE, null, day, 0, { idempotencyKey: "c" });
    expect(sim.mine().map((r) => r.task)).toEqual(["ji:10002"]);
  });
});

describe("everhour, the traps of its API", () => {
  it("trap, seconds: durations are whole seconds, never hours or minutes (1.5 h is 5400, and the sink refuses a day over 24 h or a fraction before asking)", async () => {
    const { sim, b } = simulated();
    await b.entries.setDayTotal!(meta(), ISSUE, null, day, 5400, { idempotencyKey: "k" });
    expect((await b.entries.list(meta(), range))[0].span.seconds).toBe(5400);
    const calls = sim.state.calls;
    expect((await errorOf(b.entries.setDayTotal!(meta(), ISSUE, null, day, 25 * 3600, { idempotencyKey: "k" })))?.kind).toBe("invalid");
    expect((await errorOf(b.entries.setDayTotal!(meta(), ISSUE, null, day, 90.5, { idempotencyKey: "k" })))?.kind).toBe("invalid");
    expect((await errorOf(b.entries.setDayTotal!(meta(), ISSUE, null, day, -60, { idempotencyKey: "k" })))?.kind).toBe("invalid");
    expect(sim.state.calls).toBe(calls);
    // The service itself holds the same rule.
    const res = await sim.fetch(`${sim.apiBase}/tasks/ji:10001/time`, { method: "PUT", headers: { "X-Api-Key": sim.key }, body: JSON.stringify({ time: 1.5, date: day }) });
    expect(res.status).toBe(400);
  });

  it("trap, date-only: a day is a plain YYYY-MM-DD with no zone; the day the engine counted in the user's zone is the day filed, whatever the server's", async () => {
    const { sim, b } = simulated({ zone: "Pacific/Auckland" });
    await b.entries.setDayTotal!(meta(), ISSUE, null, localDate("2026-03-10"), 3600, { idempotencyKey: "k" });
    expect(sim.mine()[0].date).toBe("2026-03-10");
    // An instant is refused by the service, so the adapter must never send one.
    const res = await sim.fetch(`${sim.apiBase}/tasks/ji:10001/time`, { method: "PUT", headers: { "X-Api-Key": sim.key }, body: JSON.stringify({ time: 60, date: "2026-03-10T23:30:00Z" }) });
    expect(res.status).toBe(400);
    // The range is days too, both included.
    sim.put("ji:10001", "2026-03-31", 60);
    sim.put("ji:10001", "2026-04-01", 60);
    expect((await b.entries.list(meta(), range)).map((w) => w.span.kind === "dayTotal" && w.span.date)).toEqual(["2026-03-10", "2026-03-31"]);
  });

  it("trap, running timer: a timer on the task adds its time when it stops, so the day isn't set under it (a conflict, in the user's zone's day)", async () => {
    const { sim, b } = simulated({ zone: "Europe/Rome" });
    // Started 23:30 UTC on the 9th: the 10th in Rome.
    sim.startTimer("ji:10001", Date.parse("2026-03-09T23:30:00Z"));
    expect((await errorOf(b.entries.setDayTotal!(meta(), ISSUE, null, localDate("2026-03-10"), 3600, { idempotencyKey: "k" })))?.kind).toBe("conflict");
    expect(sim.mine()).toEqual([]);
    // Another day, and another task, are not under it.
    await b.entries.setDayTotal!(meta(), ISSUE, null, localDate("2026-03-05"), 3600, { idempotencyKey: "k" });
    await b.entries.setDayTotal!(meta(), OTHER, null, localDate("2026-03-10"), 3600, { idempotencyKey: "k" });
    sim.stopTimer(Date.parse("2026-03-10T00:30:00Z"));
    await b.entries.setDayTotal!(meta(), ISSUE, null, localDate("2026-03-10"), 3600, { idempotencyKey: "k" });
    const rows = sim.mine().map((r) => `${r.task} ${r.date} ${r.time}`).sort();
    // The timer's hour landed on its start day; the sink's totals are where it set them.
    expect(rows).toEqual(["ji:10001 2026-03-05 3600", "ji:10001 2026-03-09 3600", "ji:10001 2026-03-10 3600", "ji:10002 2026-03-10 3600"]);
  });

  it("trap, locked period: approved time or a locked timesheet refuses writes (a conflict, the entry shown locked, not editable)", async () => {
    const { sim, b } = simulated();
    sim.task("ji:10003", "Old");
    sim.put("ji:10001", "2026-03-02", 3600);
    sim.lock("2026-03-15");
    const [w] = await b.entries.list(meta(), range);
    expect(w).toMatchObject({ approval: "approved", locked: { cause: "approved" }, editable: { update: false, delete: false } });
    const e = await errorOf(b.entries.setDayTotal!(meta(), ISSUE, null, localDate("2026-03-02"), 7200, { idempotencyKey: "k" }));
    expect(e).toMatchObject({ kind: "conflict" });
    expect((await errorOf(b.entries.setDayTotal!(meta(), ISSUE, null, localDate("2026-03-02"), 0, { idempotencyKey: "k" })))?.kind).toBe("conflict");
    expect(sim.mine().map((r) => r.time)).toEqual([3600]);
    await b.entries.setDayTotal!(meta(), ISSUE, null, localDate("2026-03-16"), 600, { idempotencyKey: "k" });
  });

  it("trap, required task: Everhour files time on a task it knows; an unknown one is refused (not retried) and says what to do", async () => {
    const { b } = simulated();
    const e = await errorOf(b.entries.setDayTotal!(meta(), { ...ISSUE, issue: { remoteId: "404", key: "ABC-404" } }, null, day, 600, { idempotencyKey: "k" }));
    expect(e).toMatchObject({ kind: "invalid" });
    expect(e?.message).toMatch(/ji:404/);
  });

  it("trap, references: the task is named by the tracker's integration prefix; a tracker Everhour has no integration for can't be filed", async () => {
    expect(taskIdOf(ISSUE)).toBe("ji:10001");
    expect(taskIdOf({ ...ISSUE, trackerType: "gitlab", issue: { remoteId: "55", key: "a/b#1" } })).toBe("gl:55");
    expect(Object.keys(EVERHOUR_PREFIX)).not.toContain("redmine");
    const { sim, b } = simulated();
    const e = await errorOf(b.entries.setDayTotal!(meta(), { ...ISSUE, trackerType: "redmine" }, null, day, 600, { idempotencyKey: "k" }));
    expect(e?.kind).toBe("invalid");
    expect(sim.state.calls).toBe(0);
  });

  it("trap, no target: the sink takes none (the user files by issue, not by project)", async () => {
    const { b } = simulated();
    const e = await errorOf(b.entries.setDayTotal!(meta(), ISSUE, { remoteId: "p", name: "P", path: [] }, day, 600, { idempotencyKey: "k" }));
    expect(e?.kind).toBe("invalid");
  });

  it("trap, only the user's own time: a teammate's records on the same task aren't listed or touched", async () => {
    const { sim, b } = simulated();
    sim.other("ji:10001", "2026-03-10", 9000);
    await b.entries.setDayTotal!(meta(), ISSUE, null, day, 600, { idempotencyKey: "k" });
    expect((await b.entries.list(meta(), range)).map((w) => [w.authorRemoteId, w.span.seconds])).toEqual([["4711", 600]]);
    await b.entries.setDayTotal!(meta(), ISSUE, null, day, 0, { idempotencyKey: "k" });
    expect(sim.records.size).toBe(1);
    expect(await b.entries.list(meta(), range)).toEqual([]);
  });

  it("an Everhour task of its own (ev:…) is listed without an issue, to be reconciled", async () => {
    const { sim, b } = simulated();
    sim.put("ev:77", "2026-03-04", 1200);
    const [w] = await b.entries.list(meta(), range);
    expect(w).toMatchObject({ remoteId: "ev:77@2026-03-04", issue: null });
  });

  it("trap, paging: the service caps the page below what is asked, so a short page isn't the end; every record comes", async () => {
    const { sim, b } = simulated();
    sim.state.pageCap = 100;
    for (let i = 0; i < 250; i++) {
      const d = new Date(Date.UTC(2026, 2, 1) + (i % 30) * 86_400_000).toISOString().slice(0, 10);
      const t = `ji:${20000 + Math.floor(i / 30)}`;
      sim.task(t, t);
      sim.put(t, d, 60 + i);
    }
    expect(sim.mine()).toHaveLength(250);
    expect(await b.entries.list(meta(), range)).toHaveLength(250);
  });

  it("trap, per-plan limits: 20 requests per 10 seconds is a rate limit with when to retry; a plan without the API is forbidden", async () => {
    const { sim, b } = simulated();
    sim.burstLimit(3);
    for (let i = 0; i < 3; i++) await b.verify(meta());
    const e = await errorOf(b.verify(meta()));
    expect(e).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: expect.any(Number) } });
    expect(e?.rateLimit?.retryAfterMs).toBeGreaterThanOrEqual(1000);
    sim.state.burst = 0;
    sim.exhaust();
    expect((await errorOf(b.entries.list(meta(), range)))?.rateLimit?.retryAfterMs).toBe(10_000);
    sim.refill();
    sim.withoutApi();
    expect((await errorOf(b.verify(meta())))?.kind).toBe("forbidden");
  });

  it("a revoked key is an auth failure", async () => {
    const { sim, b } = simulated();
    sim.revoke();
    expect((await errorOf(b.verify(meta())))?.kind).toBe("auth");
    const { b: wrong } = simulated({ token: "nope" });
    expect((await errorOf(wrong.probe(meta())))?.kind).toBe("auth");
  });

  it("a connection that may not write (unverified, not allowed yet) never changes the account", async () => {
    const { sim, conn } = simulated();
    const b = bindSink(everhourSink, { ...conn, writable: false });
    expect((await errorOf(b.entries.setDayTotal!(meta(), ISSUE, null, day, 600, { idempotencyKey: "k" })))?.kind).toBe("readOnly");
    expect(sim.mine()).toEqual([]);
    await b.entries.list(meta(), range);
  });
});
