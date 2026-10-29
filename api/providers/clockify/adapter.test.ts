import { afterEach, describe, expect, it, vi } from "vitest";
import { instant, localDate, timeZone } from "@contracts/values";
import { bindSink } from "../core/bind";
import { sinkConformance } from "../conformance/suite";
import type { ExternalRef, SinkTarget, WorklogInput } from "../types";
import { isoDuration } from "../core/time";
import { clockifySimulator } from "./simulator";
import { clockifySink, dayStart, MAX_DESCRIPTION, noteOf } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "172.65.251.78", family: 4 }]),
}));

afterEach(() => vi.unstubAllGlobals());

const ZONE = timeZone("Europe/Rome");
const REF: ExternalRef = { trackerType: "jira", trackerConnectionId: 1, issue: { remoteId: "10001", key: "APP-7" }, snapshot: { url: "https://jira.example/browse/APP-7", title: "Login fails on Safari" } };

function simulated(o: Parameters<typeof clockifySimulator>[0] & { options?: unknown; token?: string } = {}) {
  const sim = clockifySimulator(o);
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 9,
    userId: 1,
    type: "clockify" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: sim.me.id,
    options: o.options ?? {},
    timeZone: ZONE,
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, conn, b: bindSink(clockifySink, conn) };
}

sinkConformance("clockify (simulated)", async () => {
  const { sim, conn } = simulated();
  sim.project("Client A");
  return { provider: clockifySink, conn, ref: REF, writable: true };
});

sinkConformance("clockify (simulated, a workspace that forces a project)", async () => {
  const { sim, conn } = simulated({ forceProjects: true });
  sim.project("Client A");
  return { provider: clockifySink, conn, ref: REF, writable: true };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const at = (iso: string) => Date.parse(iso);
const session = (iso: string, seconds: number, extra: Partial<WorklogInput> = {}): WorklogInput => ({ time: { kind: "session", start: instant(at(iso)), seconds }, comment: "", ...extra });
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; message: string; rateLimit?: { retryAfterMs?: number } });
const range = (from: string, to: string) => ({ from: localDate(from), to: localDate(to) });
const target = (id: string, name: string, path: SinkTarget["path"] = []): SinkTarget => ({ remoteId: id, name, path });

describe("clockify, connection", () => {
  it("knows the user, and the key is sent in X-Api-Key, never in the URL", async () => {
    const { b, sim } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: sim.me.id, name: "Mario Rossi", email: "mario@example.org" });
    const seen = vi.fn(sim.fetch);
    vi.stubGlobal("fetch", seen);
    await b.probe(meta());
    const [url, init] = seen.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(sim.token);
    expect(new Headers(init.headers).get("x-api-key")).toBe(sim.token);
  });

  it("a refused key is 'auth'", async () => {
    const { b } = simulated({ token: "wrong" });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "auth" });
  });

  it("a workspace option the user is not in is refused; a malformed id is not an option", async () => {
    const { b } = simulated({ options: { workspaceId: "a".repeat(24) } });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "forbidden" });
    expect(() => clockifySink.parseOptions({ workspaceId: "nope" })).toThrow(/24 hex/);
    expect(clockifySink.parseOptions(undefined)).toEqual({});
  });

  it("the probe says what the service has, with the published 50 requests a second", async () => {
    const { b } = simulated();
    const p = await b.probe(meta());
    expect(p.rateLimit).toEqual({ perSecond: 50, origin: "typical" });
    expect(p.capabilities.entries).toMatchObject({ model: "entries", shape: "session", feed: { kind: "none" }, reconcile: { kind: "period" } });
  });

  it("an explicit workspace is used as is; without one the user's active workspace", async () => {
    const { b, sim } = simulated();
    await b.entries.create!(meta(), REF, null, session("2026-10-14T08:30:00Z", 600), { idempotencyKey: "k" });
    expect(sim.log.some((r) => r.method === "POST" && r.path === "/workspaces/" + sim.workspaceId + "/time-entries")).toBe(true);
    const own = simulated({ options: { workspaceId: "b".repeat(24) } });
    expect(await errorOf(own.b.entries.list(meta(), range("2026-10-01", "2026-10-31")))).toMatchObject({ kind: "forbidden" });
  });
});

describe("clockify, rate limit", () => {
  it("over 50 requests in a second is 429: a rateLimit that waits a second when no Retry-After is sent", async () => {
    const { b } = simulated();
    const results = await Promise.all(Array.from({ length: 60 }, () => errorOf(b.probe(meta()))));
    const limited = results.filter((e) => e?.kind === "rateLimit");
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]?.rateLimit?.retryAfterMs).toBe(1000);
  });

  it("Retry-After, when sent, is the wait", async () => {
    const { b } = simulated();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "Too many requests", code: 429 }), { status: 429, headers: { "Retry-After": "3" } }));
    expect((await errorOf(b.verify(meta())))?.rateLimit?.retryAfterMs).toBe(3000);
  });

  it("a server error is 'unavailable'", async () => {
    const { b } = simulated();
    vi.stubGlobal("fetch", async () => new Response("Bad gateway", { status: 502 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "unavailable" });
  });
});

describe("clockify, targets", () => {
  it("projects by name with the tasks of those that matched; archived projects and finished tasks are left out", async () => {
    const { b, sim } = simulated();
    const web = sim.project("Website");
    sim.project("Website old", { archived: true });
    sim.project("Intranet");
    sim.task(web.id, "Build");
    sim.task(web.id, "Done long ago", { done: true });
    const found = await b.targets!(meta(), "web", 10);
    expect(found).toEqual({
      items: [
        { remoteId: web.id, name: "Website", path: [] },
        { remoteId: expect.any(String), name: "Build", path: [{ remoteId: web.id, name: "Website" }] },
      ],
      complete: true,
    });
    expect((await b.targets!(meta(), "intra", 10)).items.map((t) => t.name)).toEqual(["Intranet"]);
  });

  it("says when it cut the list short", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 12; n++) sim.project(`Project ${n}`);
    const found = await b.targets!(meta(), "Project", 5);
    expect(found.items).toHaveLength(5);
    expect(found.complete).toBe(false);
  });
});

describe("clockify, creating", () => {
  it("files an entry under a project, or under a task with its project, the issue named in the note's first line", async () => {
    const { b, sim } = simulated();
    const p = sim.project("Website");
    const t = sim.task(p.id, "Build");
    const underProject = await b.entries.create!(meta(), REF, target(p.id, "Website"), session("2026-10-14T08:30:00Z", 5400, { comment: "fixed the redirect" }), { idempotencyKey: "a" });
    expect(underProject).toMatchObject({ issue: REF.issue, comment: "fixed the redirect", span: { kind: "session", seconds: 5400 }, authorRemoteId: sim.me.id, editable: { update: true, delete: true } });
    const underTask = await b.entries.create!(meta(), REF, target(t.id, "Build", [{ remoteId: p.id, name: "Website" }]), session("2026-10-14T10:30:00Z", 600), { idempotencyKey: "b" });
    const stored = sim.entries;
    expect(stored[0]).toMatchObject({ projectId: p.id, taskId: null, description: "[APP-7] Login fails on Safari\nfixed the redirect" });
    expect(stored[1]).toMatchObject({ projectId: p.id, taskId: t.id, description: "[APP-7] Login fails on Safari" });
    expect(underTask.remoteId).toBe(stored[1].id);
  });

  it("a list gives the issue back from the note's first line, and the comment without it", async () => {
    const { b } = simulated();
    await b.entries.create!(meta(), REF, null, session("2026-10-14T08:30:00Z", 600, { comment: "first" }), { idempotencyKey: "a" });
    const [w] = await b.entries.list(meta(), range("2026-10-14", "2026-10-14"));
    expect(w).toMatchObject({ issue: { key: "APP-7" }, comment: "first" });
  });

  it("an entry nobody linked to an issue has none", async () => {
    const { b, sim } = simulated();
    sim.entry({ start: at("2026-10-14T08:00:00Z"), description: "stand-up" });
    expect((await b.entries.list(meta(), range("2026-10-14", "2026-10-14")))[0]).toMatchObject({ issue: null, comment: "stand-up" });
  });

  it("billable: sent only when the input says; otherwise the project's own setting decides", async () => {
    const { b, sim } = simulated();
    const billable = sim.project("Paid", { billable: true });
    const free = sim.project("Free");
    const a = await b.entries.create!(meta(), REF, target(billable.id, "Paid"), session("2026-10-14T08:00:00Z", 600), { idempotencyKey: "a" });
    const c = await b.entries.create!(meta(), REF, target(free.id, "Free"), session("2026-10-14T09:00:00Z", 600), { idempotencyKey: "b" });
    const d = await b.entries.create!(meta(), REF, target(free.id, "Free"), session("2026-10-14T10:00:00Z", 600, { billable: true }), { idempotencyKey: "c" });
    expect([a.billable, c.billable, d.billable]).toEqual([true, false, true]);
    expect(sim.log.filter((r) => r.method === "POST").map((r) => "billable" in r.body)).toEqual([false, false, true]);
  });

  it("for someone else only where the key may (a manager); a plain user is forbidden", async () => {
    const plain = simulated();
    const input = session("2026-10-14T08:00:00Z", 600, { onBehalfOfRemoteId: plain.sim.colleague });
    expect(await errorOf(plain.b.entries.create!(meta(), REF, null, input, { idempotencyKey: "a" }))).toMatchObject({ kind: "forbidden" });
    const boss = simulated({ manager: true });
    const made = await boss.b.entries.create!(meta(), REF, null, { ...input, onBehalfOfRemoteId: boss.sim.colleague }, { idempotencyKey: "a" });
    expect(made.authorRemoteId).toBe(boss.sim.colleague);
  });

  it("TRAP no idempotency: the same key twice makes two entries, so the capability says 'local' (the engine's own protection)", async () => {
    const { b, sim } = simulated();
    const first = await b.entries.create!(meta(), REF, null, session("2026-10-14T08:00:00Z", 600), { idempotencyKey: "same" });
    const second = await b.entries.create!(meta(), REF, null, session("2026-10-14T08:00:00Z", 600), { idempotencyKey: "same" });
    expect(second.remoteId).not.toBe(first.remoteId);
    expect(sim.entries).toHaveLength(2);
    expect(b.capabilities.entries.idempotency).toBe("local");
    expect(JSON.stringify(sim.log.map((r) => r.body))).not.toContain("same");
  });
});

describe("clockify, trap: times are instants to the second, never dates", () => {
  it("sends start and end as ISO instants without milliseconds, the end a length after the start", async () => {
    const { b, sim } = simulated();
    await b.entries.create!(meta(), REF, null, { time: { kind: "session", start: instant(at("2026-10-14T08:30:00Z") + 750), seconds: 90 }, comment: "" }, { idempotencyKey: "a" });
    const body = sim.log.find((r) => r.method === "POST")!.body;
    expect(body.start).toBe("2026-10-14T08:30:00Z");
    expect(body.end).toBe("2026-10-14T08:31:30Z");
    expect(sim.entries[0].end! - sim.entries[0].start).toBe(90_000);
  });

  it("the sim holds the format: a date-only filter, or a start with no zone, is a 400", async () => {
    const { sim } = simulated();
    const get = (q: string) => sim.fetch(`${sim.apiBase}/workspaces/${sim.workspaceId}/user/${sim.me.id}/time-entries?${q}`, { headers: { "X-Api-Key": sim.token } });
    expect((await get("start=2026-10-14&end=2026-10-15")).status).toBe(400);
    expect((await get("start=2026-10-14T08:00:00&end=2026-10-15T08:00:00Z")).status).toBe(400);
    expect((await get("start=2026-10-14T08:00:00Z&end=2026-10-15T08:00:00Z")).status).toBe(200);
  });

  it("a day is read in the connection's zone: late evening stays on its day, just after midnight on the next, whatever UTC says", async () => {
    const { b, sim } = simulated();
    // Rome in October is UTC+2: 23:30 on the 14th is 21:30Z, 00:30 on the 15th is 22:30Z (still the 14th in UTC).
    sim.entry({ start: at("2026-10-14T21:30:00Z"), description: "late" });
    sim.entry({ start: at("2026-10-14T22:30:00Z"), description: "after midnight" });
    expect((await b.entries.list(meta(), range("2026-10-14", "2026-10-14"))).map((w) => w.comment)).toEqual(["late"]);
    expect((await b.entries.list(meta(), range("2026-10-15", "2026-10-15"))).map((w) => w.comment)).toEqual(["after midnight"]);
  });

  it("the day the clocks go back lasts 25 hours: its range covers all of them, and the next day starts an hour later in UTC", async () => {
    const { b, sim } = simulated();
    // 2026-10-25: Rome goes from UTC+2 to UTC+1 at 03:00 local.
    expect(new Date(dayStart(localDate("2026-10-25"), ZONE)).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(new Date(dayStart(localDate("2026-10-26"), ZONE)).toISOString()).toBe("2026-10-25T23:00:00.000Z");
    sim.entry({ start: at("2026-10-25T22:30:00Z"), description: "last hour of the 25th" });
    sim.entry({ start: at("2026-10-25T23:30:00Z"), description: "first hour of the 26th" });
    expect((await b.entries.list(meta(), range("2026-10-25", "2026-10-25"))).map((w) => w.comment)).toEqual(["last hour of the 25th"]);
    expect((await b.entries.list(meta(), range("2026-10-25", "2026-10-26"))).map((w) => w.comment)).toHaveLength(2);
  });

  it("the day the clocks go forward lasts 23 hours", () => {
    expect(new Date(dayStart(localDate("2026-03-29"), ZONE)).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(new Date(dayStart(localDate("2026-03-30"), ZONE)).toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });
});

describe("clockify, trap: durations are ISO 8601, not seconds", () => {
  it("prints them as Clockify does and reads the length from the interval", async () => {
    expect([0, 59, 60, 3600, 5400, 3661, 90_000].map(isoDuration)).toEqual(["PT0S", "PT59S", "PT1M", "PT1H", "PT1H30M", "PT1H1M1S", "PT25H"]);
    const { b, sim } = simulated();
    const made = await b.entries.create!(meta(), REF, null, session("2026-10-14T08:00:00Z", 5400), { idempotencyKey: "a" });
    const res = await sim.fetch(`${sim.apiBase}/workspaces/${sim.workspaceId}/time-entries/${made.remoteId}`, { headers: { "X-Api-Key": sim.token } });
    expect(((await res.json()) as { timeInterval: { duration: string } }).timeInterval.duration).toBe("PT1H30M");
    expect(made.span).toEqual({ kind: "session", start: at("2026-10-14T08:00:00Z"), seconds: 5400 });
  });

  it("an interval that runs backwards is refused by the service, not turned into a length", async () => {
    const { sim } = simulated();
    const res = await sim.fetch(`${sim.apiBase}/workspaces/${sim.workspaceId}/time-entries`, {
      method: "POST",
      headers: { "X-Api-Key": sim.token },
      body: JSON.stringify({ start: "2026-10-14T09:00:00Z", end: "2026-10-14T08:00:00Z" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("clockify, trap: running timers", () => {
  it("a timer still running has no end: not an entry to reconcile, and left alone", async () => {
    const { b, sim } = simulated();
    sim.outside.startTimer(at("2026-10-14T08:00:00Z"));
    sim.entry({ start: at("2026-10-14T06:00:00Z"), description: "done" });
    expect((await b.entries.list(meta(), range("2026-10-14", "2026-10-14"))).map((w) => w.comment)).toEqual(["done"]);
    await b.entries.create!(meta(), REF, null, session("2026-10-14T10:00:00Z", 600), { idempotencyKey: "a" });
    expect(sim.entries.filter((e) => e.end === null)).toHaveLength(1);
  });

  it("the sim holds Clockify's rule: a request with no end starts a timer and stops the one running (the adapter always sends an end)", async () => {
    const { b, sim } = simulated();
    const timer = sim.outside.startTimer(Date.now() - 60_000);
    await b.entries.create!(meta(), REF, null, session("2026-10-14T10:00:00Z", 600), { idempotencyKey: "a" });
    expect(timer.end).toBeNull();
    await sim.fetch(`${sim.apiBase}/workspaces/${sim.workspaceId}/time-entries`, { method: "POST", headers: { "X-Api-Key": sim.token }, body: JSON.stringify({ start: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") }) });
    expect(timer.end).not.toBeNull();
  });

  it("changing an entry whose timer is running gives it an end", async () => {
    const { b, sim } = simulated();
    const timer = sim.outside.startTimer(at("2026-10-14T08:00:00Z"));
    const changed = await b.entries.update!(meta(), timer.id, session("2026-10-14T08:00:00Z", 1200), {});
    expect(changed.span).toMatchObject({ seconds: 1200 });
    expect(timer.end).toBe(at("2026-10-14T08:20:00Z"));
  });
});

describe("clockify, reading a period", () => {
  it("pages of 200 with no total: an exact multiple costs one empty page more, nothing is lost or repeated", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 400; n++) sim.entry({ start: at("2026-10-14T00:00:00Z") + n * 60_000, end: at("2026-10-14T00:00:00Z") + n * 60_000 + 30_000, description: `e${n}` });
    const all = await b.entries.list(meta(), range("2026-10-14", "2026-10-15"));
    expect(all).toHaveLength(400);
    expect(new Set(all.map((w) => w.remoteId)).size).toBe(400);
    expect(sim.log.filter((r) => r.path.includes("/time-entries?")).map((r) => /page=(\d+)/.exec(r.path)?.[1])).toEqual(["1", "2", "3"]);
  });

  it("the service caps a page at 1000 whatever is asked (the sim holds it)", async () => {
    const { sim } = simulated();
    for (let n = 0; n < 1200; n++) sim.entry({ start: at("2026-10-14T00:00:00Z") + n * 1000, end: at("2026-10-14T00:00:00Z") + n * 1000 + 500 });
    const res = await sim.fetch(`${sim.apiBase}/workspaces/${sim.workspaceId}/user/${sim.me.id}/time-entries?page-size=5000`, { headers: { "X-Api-Key": sim.token } });
    expect(((await res.json()) as unknown[]).length).toBe(1000);
  });

  it("only the user's own entries", async () => {
    const { b, sim } = simulated();
    sim.entry({ start: at("2026-10-14T08:00:00Z"), userId: sim.colleague, description: "theirs" });
    sim.entry({ start: at("2026-10-14T09:00:00Z"), description: "mine" });
    expect((await b.entries.list(meta(), range("2026-10-14", "2026-10-14"))).map((w) => w.comment)).toEqual(["mine"]);
  });
});

describe("clockify, trap: an update replaces the whole entry", () => {
  it("project, task, tags and billable are read and sent again; the note keeps its issue line and takes the new comment", async () => {
    const { b, sim } = simulated();
    const p = sim.project("Website", { billable: false });
    const t = sim.task(p.id, "Build");
    const made = await b.entries.create!(meta(), REF, target(t.id, "Build", [{ remoteId: p.id, name: "Website" }]), session("2026-10-14T08:00:00Z", 600, { comment: "old", billable: true }), { idempotencyKey: "a" });
    sim.outside.edit(sim.entries[0], { tagIds: ["5f0000000000000000000001"] });
    const changed = await b.entries.update!(meta(), made.remoteId, session("2026-10-14T08:00:00Z", 1800, { comment: "new" }), {});
    expect(changed).toMatchObject({ span: { seconds: 1800 }, comment: "new", billable: true, issue: { key: "APP-7" } });
    expect(sim.entries[0]).toMatchObject({ projectId: p.id, taskId: t.id, tagIds: ["5f0000000000000000000001"], billable: true, description: "[APP-7] Login fails on Safari\nnew" });
  });

  it("an explicit billable wins; an entry of someone else's making (no issue line) takes just the comment", async () => {
    const { b, sim } = simulated();
    const e = sim.entry({ start: at("2026-10-14T08:00:00Z"), description: "by hand", billable: false });
    const out = await b.entries.update!(meta(), e.id, session("2026-10-14T08:00:00Z", 600, { comment: "edited", billable: true }), {});
    expect(out).toMatchObject({ comment: "edited", billable: true, issue: null });
    expect(e.description).toBe("edited");
  });

  it("an entry that is gone is notFound", async () => {
    const { b } = simulated();
    expect(await errorOf(b.entries.update!(meta(), "5f0000000000000000009999", session("2026-10-14T08:00:00Z", 600), {}))).toMatchObject({ kind: "notFound" });
  });

  it("deleting what is already gone is a success", async () => {
    const { b } = simulated();
    await expect(b.entries.delete!(meta(), "5f0000000000000000009999", {})).resolves.toBeUndefined();
  });
});

describe("clockify, trap: locked and approved entries", () => {
  it("an approved entry is locked and says why when the key may read approval requests; every change is a conflict", async () => {
    const { b, sim } = simulated({ manager: true });
    const e = sim.entry({ start: at("2026-10-14T08:00:00Z") });
    sim.outside.timesheet(e, "APPROVED");
    const [w] = await b.entries.list(meta(), range("2026-10-14", "2026-10-14"));
    expect(w).toMatchObject({ approval: "approved", locked: { cause: "approved" }, editable: { update: false, delete: false } });
    expect(await errorOf(b.entries.update!(meta(), e.id, session("2026-10-14T08:00:00Z", 60), {}))).toMatchObject({ kind: "conflict" });
    expect(await errorOf(b.entries.delete!(meta(), e.id, {}))).toMatchObject({ kind: "conflict", message: expect.stringContaining("locked") });
    expect(sim.entries).toHaveLength(1);
  });

  it("a submitted timesheet is locked as submitted; a plain key cannot list approvals, so the lock is only 'periodClosed'", async () => {
    const boss = simulated({ manager: true });
    boss.sim.outside.timesheet(boss.sim.entry({ start: at("2026-10-14T08:00:00Z") }), "PENDING");
    expect((await boss.b.entries.list(meta(), range("2026-10-14", "2026-10-14")))[0]).toMatchObject({ approval: "submitted", locked: { cause: "submitted" } });
    const plain = simulated();
    plain.sim.outside.timesheet(plain.sim.entry({ start: at("2026-10-14T08:00:00Z") }), "APPROVED");
    const [w] = await plain.b.entries.list(meta(), range("2026-10-14", "2026-10-14"));
    expect(w.locked).toMatchObject({ cause: "periodClosed" });
    expect(w.approval).toBeUndefined();
    expect(w.editable).toEqual({ update: false, delete: false });
  });

  it("a rejected timesheet unlocks its entries", async () => {
    const { b, sim } = simulated({ manager: true });
    sim.outside.timesheet(sim.entry({ start: at("2026-10-14T08:00:00Z") }), "REJECTED");
    expect((await b.entries.list(meta(), range("2026-10-14", "2026-10-14")))[0]).toMatchObject({ editable: { update: true, delete: true } });
  });

  it("a closed period refuses new time and changes: a conflict, with the service's words", async () => {
    const { b, sim } = simulated();
    sim.outside.lockPeriod(at("2026-10-01T00:00:00Z"));
    const old = sim.entry({ start: at("2026-09-20T08:00:00Z") });
    const err = await errorOf(b.entries.create!(meta(), REF, null, session("2026-09-25T08:00:00Z", 600), { idempotencyKey: "a" }));
    expect(err).toMatchObject({ kind: "conflict", message: expect.stringContaining("locked period") });
    expect((await b.entries.list(meta(), range("2026-09-20", "2026-09-20")))[0]).toMatchObject({ locked: { cause: "periodClosed" } });
    expect(await errorOf(b.entries.update!(meta(), old.id, session("2026-09-20T08:00:00Z", 60), {}))).toMatchObject({ kind: "conflict" });
  });
});

describe("clockify, trap: a project or task may be required", () => {
  it("a workspace that forces projects refuses an entry with none, in its own words ('invalid')", async () => {
    const { b } = simulated({ forceProjects: true });
    expect(await errorOf(b.entries.create!(meta(), REF, null, session("2026-10-14T08:00:00Z", 600), { idempotencyKey: "a" }))).toMatchObject({ kind: "invalid", message: expect.stringContaining("Project is required") });
  });

  it("a workspace that forces tasks wants one; a task is sent with its project", async () => {
    const { b, sim } = simulated({ forceProjects: true, forceTasks: true });
    const p = sim.project("Website");
    const t = sim.task(p.id, "Build");
    expect(await errorOf(b.entries.create!(meta(), REF, target(p.id, "Website"), session("2026-10-14T08:00:00Z", 600), { idempotencyKey: "a" }))).toMatchObject({ kind: "invalid", message: expect.stringContaining("Task is required") });
    const ok = await b.entries.create!(meta(), REF, target(t.id, "Build", [{ remoteId: p.id, name: "Website" }]), session("2026-10-14T08:00:00Z", 600), { idempotencyKey: "b" });
    expect(sim.entries.find((e) => e.id === ok.remoteId)).toMatchObject({ projectId: p.id, taskId: t.id });
  });

  it("a task alone, without its project, is refused by the service (so the adapter always sends both)", async () => {
    const { sim } = simulated();
    const p = sim.project("Website");
    const t = sim.task(p.id, "Build");
    const res = await sim.fetch(`${sim.apiBase}/workspaces/${sim.workspaceId}/time-entries`, {
      method: "POST",
      headers: { "X-Api-Key": sim.token },
      body: JSON.stringify({ start: "2026-10-14T08:00:00Z", end: "2026-10-14T09:00:00Z", taskId: t.id }),
    });
    expect(res.status).toBe(400);
  });

  it("an archived project takes no new entries", async () => {
    const { b, sim } = simulated();
    const p = sim.project("Old", { archived: true });
    expect(await errorOf(b.entries.create!(meta(), REF, target(p.id, "Old"), session("2026-10-14T08:00:00Z", 600), { idempotencyKey: "a" }))).toMatchObject({ kind: "invalid", message: expect.stringContaining("archived") });
  });
});

describe("clockify, trap: a description is at most 3000 characters", () => {
  it("a long comment is cut to fit, the issue line kept whole", async () => {
    const { b, sim } = simulated();
    await b.entries.create!(meta(), REF, null, session("2026-10-14T08:00:00Z", 600, { comment: "x".repeat(5000) }), { idempotencyKey: "a" });
    const d = sim.entries[0].description;
    expect(d.length).toBe(MAX_DESCRIPTION);
    expect(d.startsWith("[APP-7] Login fails on Safari\nxxx")).toBe(true);
  });

  it("a very long title is cut too, and an update still fits", async () => {
    const { b, sim } = simulated();
    const long = { ...REF, snapshot: { ...REF.snapshot, title: "t".repeat(4000) } };
    const made = await b.entries.create!(meta(), long, null, session("2026-10-14T08:00:00Z", 600, { comment: "c".repeat(4000) }), { idempotencyKey: "a" });
    expect(sim.entries[0].description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    await b.entries.update!(meta(), made.remoteId, session("2026-10-14T08:00:00Z", 600, { comment: "d".repeat(4000) }), {});
    expect(sim.entries[0].description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(noteOf("[A-1] x", "")).toBe("[A-1] x");
  });

  it("newlines in a title do not break the issue line", async () => {
    const { b, sim } = simulated();
    await b.entries.create!(meta(), { ...REF, snapshot: { ...REF.snapshot, title: "two\nlines" } }, null, session("2026-10-14T08:00:00Z", 600, { comment: "c" }), { idempotencyKey: "a" });
    expect(sim.entries[0].description).toBe("[APP-7] two lines\nc");
  });
});

describe("clockify, what changes outside", () => {
  it("an entry edited or removed in Clockify shows on the next read of the period, as there is no feed", async () => {
    const { b, sim } = simulated();
    const made = await b.entries.create!(meta(), REF, null, session("2026-10-14T08:00:00Z", 600, { comment: "mine" }), { idempotencyKey: "a" });
    expect(b.capabilities.entries.feed).toEqual({ kind: "none" });
    expect(b.entries.changed).toBeUndefined();
    sim.outside.edit(sim.entries[0], { description: "[APP-7] Login fails on Safari\nreworded" });
    expect((await b.entries.list(meta(), range("2026-10-14", "2026-10-14")))[0].comment).toBe("reworded");
    sim.outside.remove(sim.entries[0]);
    expect((await b.entries.list(meta(), range("2026-10-14", "2026-10-14")))).toEqual([]);
    await expect(b.entries.delete!(meta(), made.remoteId, {})).resolves.toBeUndefined();
  });
});
