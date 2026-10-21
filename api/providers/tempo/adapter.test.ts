import { describe, expect, it, vi } from "vitest";
import { instant, localDate, timeZone } from "@contracts/values";
import { bindSink } from "../core/bind";
import { readPass } from "../core/paging";
import { sinkConformance } from "../conformance/suite";
import type { ExternalRef, RemoteWorklog, WorklogInput } from "../types";
import { instantOfWall, wallOf } from "./client";
import { tempoSimulator } from "./simulator";
import { jiraWorklogIdOf, tempoSink, tempoSinkCapabilities } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "52.1.2.3", family: 4 }]),
}));

const ZONE = "Europe/Rome";

function simulated(o: { userZone?: string; roundsToMinutes?: boolean; options?: unknown; zone?: string; remoteAccountId?: string; token?: string } = {}) {
  const sim = tempoSimulator(undefined, { userZone: o.userZone, roundsToMinutes: o.roundsToMinutes });
  const login = sim.issue("PROJ-1");
  const csv = sim.issue("PROJ-2");
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 9,
    userId: 1,
    type: "tempo" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: o.remoteAccountId ?? sim.me.accountId,
    options: o.options ?? { jiraConnectionId: 3, accountId: sim.me.accountId },
    timeZone: timeZone(o.zone ?? ZONE),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  const ref = (i: { id: number; key: string }, title = "Login fails on Safari"): ExternalRef => ({
    trackerType: "jira",
    trackerConnectionId: 3,
    issue: { remoteId: String(i.id), key: i.key },
    snapshot: { url: `https://acme.atlassian.net/browse/${i.key}`, title },
  });
  return { sim, conn, login, csv, ref, b: bindSink(tempoSink, conn) };
}

sinkConformance("tempo (simulated)", async () => {
  const { conn, ref, login, sim } = simulated();
  sim.attributes[0].required = false;
  return { provider: tempoSink, conn, ref: ref(login), writable: true };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; status?: number; rateLimit?: { retryAfterMs?: number }; message: string });
const at = (iso: string) => instant(Date.parse(iso));
const session = (iso: string, seconds: number, rest: Partial<WorklogInput> = {}): WorklogInput => ({ time: { kind: "session", start: at(iso), seconds }, comment: "", ...rest });
const range = { from: localDate("2026-10-01"), to: localDate("2026-10-31") };

describe("tempo, connection", () => {
  it("reads its options: the Jira connection and account, with the connection's own account as the fallback", async () => {
    expect(tempoSink.parseOptions({ jiraConnectionId: 3, accountId: "abc" })).toEqual({ jiraConnectionId: 3, accountId: "abc", workAttributeKey: null });
    expect(tempoSink.parseOptions({})).toEqual({ jiraConnectionId: null, accountId: null, workAttributeKey: null });
    expect(() => tempoSink.parseOptions({ jiraConnectionId: "x" })).toThrow(/Tempo options/);
    expect(() => tempoSink.parseOptions({ token: "secret" })).toThrow();
    const { b, sim } = simulated({ options: {} });
    expect((await b.verify(meta())).remoteId).toBe(sim.me.accountId);
  });

  it("without any account id there is nothing to file under: invalid, before a call", async () => {
    const { b, sim } = simulated({ options: {}, remoteAccountId: "" });
    expect((await errorOf(b.verify(meta())))?.kind).toBe("invalid");
    expect(sim.state.calls).toBe(0);
  });

  it("verifies the token with the account's worklogs (Bearer), declares no call budget, and says who it is", async () => {
    const { b, sim } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: sim.me.accountId });
    expect(sim.seen[0]).toMatchObject({ method: "GET", path: `/worklogs/user/${sim.me.accountId}` });
    const probe = await b.probe(meta());
    expect(probe.rateLimit).toBeUndefined();
    expect(probe.capabilities).toEqual(tempoSinkCapabilities);
  });

  it("a revoked token is auth; the limit is a rate limit with Retry-After and no retry of its own", async () => {
    const { b, sim } = simulated();
    sim.exhaust();
    const limited = await errorOf(b.verify(meta()));
    expect(limited).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 30_000 } });
    expect(sim.state.calls).toBe(1);
    sim.refill();
    sim.revoke();
    expect((await errorOf(b.verify(meta())))?.kind).toBe("auth");
  });

  it("follows a next link only on Tempo's own origin (the token travels with it)", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 3; n++) sim.add(sim.issues.keys().next().value as number);
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const res = await sim.fetch(input, init);
      const text = await res.text();
      if (!String(input).includes("/worklogs/user/")) return new Response(text, { status: res.status, headers: res.headers });
      const body = JSON.parse(text) as { metadata: { next?: string } };
      if (body.metadata.next) body.metadata.next = "https://evil.example/4/worklogs/user/x?offset=1";
      return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
    });
    sim.state.maxLimit = 1000;
    // One page holds all of them: no next link to follow, so nothing leaks; a forced one is refused.
    expect((await b.entries.list(meta(), range)).length).toBe(3);
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const res = await sim.fetch(input, init);
      return new Response(JSON.stringify({ metadata: { count: 0, offset: 0, limit: 1, next: "https://evil.example/4/worklogs/user/x?offset=1" }, results: [] }), { status: res.status });
    });
    expect((await errorOf(b.entries.list(meta(), range)))?.kind).toBe("incompatible");
  });
});

describe("tempo, filing time", () => {
  it("files a worklog by the Jira issue's id (never its key), with the key and title in the note, and reads it back as a session", async () => {
    const { b, sim, ref, login } = simulated();
    const made = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:30:00Z", 5400, { comment: "Fixed the redirect" }), { idempotencyKey: "k" });
    const sent = sim.seen.find((s) => s.method === "POST")!;
    expect(sent.path).toBe("/worklogs");
    expect(sent.body).toMatchObject({ issueId: login.id, authorAccountId: sim.me.accountId, startDate: "2026-10-14", startTime: "09:30:00", timeSpentSeconds: 5400 });
    expect(typeof sent.body.issueId).toBe("number");
    expect(sent.body.description).toBe("PROJ-1: Login fails on Safari\nFixed the redirect");
    expect(made).toMatchObject({ issue: { remoteId: String(login.id) }, span: { kind: "session", start: at("2026-10-14T07:30:00Z"), seconds: 5400 }, comment: "Fixed the redirect", authorRemoteId: sim.me.accountId, editable: { update: true, delete: true } });
    // A note with no comment is only the head.
    await b.entries.create!(meta(), ref(login), null, session("2026-10-14T10:00:00Z", 600), { idempotencyKey: "k2" });
    expect(sim.worklogs[1].description).toBe("PROJ-1: Login fails on Safari");
    expect((await b.entries.list(meta(), range)).map((w) => w.comment)).toEqual(["Fixed the redirect", ""]);
  });

  it("refuses a key where Tempo wants the issue's id, before any call", async () => {
    const { b, sim, ref, login } = simulated();
    const keyed: ExternalRef = { ...ref(login), issue: { remoteId: "PROJ-1", key: "PROJ-1" } };
    expect((await errorOf(b.entries.create!(meta(), keyed, null, session("2026-10-14T07:30:00Z", 60), { idempotencyKey: "k" })))?.kind).toBe("invalid");
    expect(sim.state.calls).toBe(0);
    // An id Jira doesn't have is the service's 400.
    const unknown: ExternalRef = { ...ref(login), issue: { remoteId: "999", key: "NOPE-1" } };
    expect(await errorOf(b.entries.create!(meta(), unknown, null, session("2026-10-14T07:30:00Z", 60), { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid", message: expect.stringContaining("not found") });
  });

  it("a note not made here is a comment as it is; one made here loses only its head", async () => {
    const { b, sim, login } = simulated();
    sim.add(login.id, { description: "Weekly sync: notes" });
    sim.add(login.id, { description: "PROJ-1: Login fails on Safari\nline one\nline two" });
    expect((await b.entries.list(meta(), range)).map((w) => w.comment)).toEqual(["Weekly sync: notes", "line one\nline two"]);
  });
});

describe("tempo, time zones and date-only fields", () => {
  it("startDate and startTime are the user's wall clock, not UTC: 23:30 UTC the 14th is the 15th at 01:30 in Rome (summer time)", async () => {
    const { b, sim, ref, login } = simulated();
    await b.entries.create!(meta(), ref(login), null, session("2026-10-14T23:30:00Z", 1800), { idempotencyKey: "k" });
    expect(sim.worklogs[0]).toMatchObject({ startDate: "2026-10-15", startTime: "01:30:00" });
    // And the same wall clock reads back as the same instant.
    expect((await b.entries.list(meta(), range))[0].span).toMatchObject({ start: at("2026-10-14T23:30:00Z") });
  });

  it("follows the zone's offset through the year, summer time ending on 2026-10-25", () => {
    const zone = timeZone(ZONE);
    for (const iso of ["2026-07-14T10:00:00Z", "2026-10-24T22:30:00Z", "2026-10-25T10:00:00Z", "2026-12-01T08:00:00Z", "2027-03-28T05:00:00Z"]) {
      const wall = wallOf(Date.parse(iso), zone);
      expect(instantOfWall(wall.date, wall.time, zone)).toBe(Date.parse(iso));
    }
    expect(wallOf(Date.parse("2026-07-14T10:00:00Z"), zone)).toEqual({ date: "2026-07-14", time: "12:00:00" });
    expect(wallOf(Date.parse("2026-12-01T08:00:00Z"), zone)).toEqual({ date: "2026-12-01", time: "09:00:00" });
    expect(instantOfWall("2026-13-01", "09:00:00", zone)).toBeNull();
  });

  it("a day range is counted in the zone: a worklog at 23:30 local on the last day is in, one at 00:30 the next day is out", async () => {
    const { b, sim, login } = simulated();
    sim.add(login.id, { date: "2026-10-31", time: "23:30:00" });
    sim.add(login.id, { date: "2026-11-01", time: "00:30:00" });
    const got = await b.entries.list(meta(), range);
    expect(got.map((w) => wallOf(w.span.kind === "session" ? w.span.start : 0, timeZone(ZONE)).date)).toEqual(["2026-10-31"]);
    expect(sim.seen.find((x) => x.path.startsWith("/worklogs/user/"))!.query).toContain("from=2026-10-01");
  });

  it("assumes the Jira user's zone is the connection's: a user profile in another zone shifts what is read (spike tempo-user-zone)", async () => {
    const { b, sim, login } = simulated({ userZone: "America/New_York" });
    sim.add(login.id, { date: "2026-10-14", time: "09:00:00" });
    const [w] = await b.entries.list(meta(), range);
    // 09:00 read as Rome time, though Tempo means New York: six hours early.
    expect(w.span.kind === "session" && w.span.start).toBe(at("2026-10-14T07:00:00Z"));
  });
});

describe("tempo, seconds and billable seconds", () => {
  it("sends whole seconds as they are; billable is billableSeconds: all of it, or none", async () => {
    const { b, sim, ref, login } = simulated();
    const yes = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 4500, { billable: true }), { idempotencyKey: "a" });
    const no = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T09:00:00Z", 900, { billable: false }), { idempotencyKey: "b" });
    const said = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T10:00:00Z", 900), { idempotencyKey: "c" });
    const bodies = sim.seen.filter((s) => s.method === "POST").map((s) => [s.body.timeSpentSeconds, s.body.billableSeconds]);
    expect(bodies).toEqual([[4500, 4500], [900, 0], [900, undefined]]);
    expect([yes.billable, no.billable]).toEqual([true, false]);
    // Left unsaid, the service decides (here: nothing billed).
    expect(said.billable).toBe(false);
  });

  it("reads a part-billable worklog as billable, and keeps its share when the time changes", async () => {
    const { b, sim, login } = simulated();
    const full = sim.add(login.id, { seconds: 3600, billable: 3600 });
    const part = sim.add(login.id, { seconds: 3600, billable: 1800 });
    const none = sim.add(login.id, { seconds: 3600, billable: 0 });
    expect((await b.entries.list(meta(), range)).map((w) => w.billable)).toEqual([true, true, false]);
    await b.entries.update!(meta(), String(full.tempoWorklogId), session("2026-10-14T07:00:00Z", 7200), {});
    await b.entries.update!(meta(), String(part.tempoWorklogId), session("2026-10-14T07:00:00Z", 900), {});
    await b.entries.update!(meta(), String(none.tempoWorklogId), session("2026-10-14T07:00:00Z", 7200), {});
    expect([full, part, none].map((w) => w.billableSeconds)).toEqual([7200, 900, 0]);
    // Said, it is replaced.
    await b.entries.update!(meta(), String(none.tempoWorklogId), session("2026-10-14T07:00:00Z", 7200, { billable: true }), {});
    expect(none.billableSeconds).toBe(7200);
  });

  it("reports what Tempo kept when it keeps whole minutes, not what was sent", async () => {
    const { b, ref, login } = simulated({ roundsToMinutes: true });
    const made = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 3629), { idempotencyKey: "k" });
    expect(made.span.seconds).toBe(3600);
    const tiny = await b.entries.update!(meta(), made.remoteId, session("2026-10-14T07:00:00Z", 20), {});
    expect(tiny.span.seconds).toBe(60);
  });

  it("a duration of no seconds is the service's refusal, not a worklog", async () => {
    const { b, ref, login } = simulated();
    expect((await errorOf(b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 0), { idempotencyKey: "k" })))?.kind).toBe("invalid");
  });
});

describe("tempo, two ids", () => {
  it("the entry is the Tempo id; the Jira worklog it mirrors is in the entry's version, read with jiraWorklogIdOf", async () => {
    const { b, sim, ref, login } = simulated();
    const made = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 600), { idempotencyKey: "k" });
    const row = sim.worklogs[0];
    expect(made.remoteId).toBe(String(row.tempoWorklogId));
    expect(jiraWorklogIdOf(made)).toBe(String(row.jiraWorklogId));
    expect(made.remoteId).not.toBe(jiraWorklogIdOf(made));
    // Whichever way it is read, and after a change, the mirror is the same.
    const [listed] = await b.entries.list(meta(), range);
    const changed = await b.entries.update!(meta(), made.remoteId, session("2026-10-14T07:00:00Z", 1200), {});
    expect([jiraWorklogIdOf(listed), jiraWorklogIdOf(changed)]).toEqual([String(row.jiraWorklogId), String(row.jiraWorklogId)]);
    const feed = await readPass((q) => b.entries.changed!(meta(), q), null);
    expect(jiraWorklogIdOf(feed.items[0])).toBe(String(row.jiraWorklogId));
    // A worklog that doesn't say, or an entry from another service, has none.
    expect(jiraWorklogIdOf({ ...made, version: "2026-10-14T07:00:00Z" })).toBeNull();
    expect(jiraWorklogIdOf({ ...made, version: null })).toBeNull();
  });

  it("Tempo's calls refuse the Jira id: deleting by it is a 404 that deletes nothing, by the Tempo id it is gone", async () => {
    const { b, sim, ref, login } = simulated();
    const made = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 600), { idempotencyKey: "k" });
    const mirror = jiraWorklogIdOf(made)!;
    expect((await sim.fetch(`${sim.apiBase}/worklogs/${mirror}`, { method: "DELETE", headers: { Authorization: `Bearer ${sim.token}` } })).status).toBe(404);
    expect(sim.worklogs.length).toBe(1);
    await b.entries.delete!(meta(), made.remoteId, {});
    expect(sim.worklogs.length).toBe(0);
    expect(sim.seen.at(-1)).toMatchObject({ method: "DELETE", path: `/worklogs/${made.remoteId}` });
  });
});

describe("tempo, changing and deleting", () => {
  it("a change is a PUT of the whole worklog: the stored activity, note head and issue go along, and a new comment replaces the old", async () => {
    const { b, sim, ref, login } = simulated();
    const made = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 3600, { comment: "first", activityId: "QA", billable: true }), { idempotencyKey: "k" });
    const changed = await b.entries.update!(meta(), made.remoteId, session("2026-10-14T08:00:00Z", 1800, { comment: "second" }), {});
    const put = sim.seen.find((s) => s.method === "PUT")!;
    expect(put.body).toMatchObject({ issueId: login.id, authorAccountId: sim.me.accountId, startTime: "10:00:00", timeSpentSeconds: 1800, description: "PROJ-1: Login fails on Safari\nsecond", billableSeconds: 1800, attributes: [{ key: "_WorkType_", value: "QA" }] });
    expect(changed).toMatchObject({ comment: "second", activity: { id: "QA", name: "Testing" }, billable: true, span: { seconds: 1800 } });
    // Said, the activity changes; the other attributes stay.
    sim.worklogs[0].attributes.push({ key: "_Ticket_", value: "T-9" });
    const moved = await b.entries.update!(meta(), made.remoteId, session("2026-10-14T08:00:00Z", 1800, { activityId: "DEV" }), {});
    expect(moved.activity).toEqual({ id: "DEV", name: "Development" });
    expect(sim.worklogs[0].attributes).toEqual([{ key: "_Ticket_", value: "T-9" }, { key: "_WorkType_", value: "DEV" }]);
    // The same service without the carrying over would have cleared them: that is what a PUT does.
    const raw = await sim.fetch(`${sim.apiBase}/worklogs/${made.remoteId}`, { method: "PUT", headers: { Authorization: `Bearer ${sim.token}` }, body: JSON.stringify({ issueId: login.id, authorAccountId: sim.me.accountId, startDate: "2026-10-14", timeSpentSeconds: 60 }) });
    expect(raw.status).toBe(200);
    expect(sim.worklogs[0]).toMatchObject({ attributes: [], billableSeconds: 0, description: "" });
  });

  it("changes a worklog that was edited in Tempo meanwhile from what is stored now, not from an older read", async () => {
    const { b, sim, ref, login } = simulated();
    const made = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 3600, { activityId: "DEV" }), { idempotencyKey: "k" });
    sim.outside.edit(sim.worklogs[0], { description: "PROJ-1: Login fails on Safari\nedited in Tempo" });
    const changed = await b.entries.update!(meta(), made.remoteId, session("2026-10-14T07:00:00Z", 600, { comment: "mine" }), {});
    expect(changed.comment).toBe("mine");
    expect(changed.activity?.id).toBe("DEV");
  });

  it("a worklog that is not there: changing it is notFound, deleting it a success", async () => {
    const { b } = simulated();
    expect((await errorOf(b.entries.update!(meta(), "424242", session("2026-10-14T07:00:00Z", 60), {})))?.kind).toBe("notFound");
    await expect(b.entries.delete!(meta(), "424242", {})).resolves.toBeUndefined();
  });
});

describe("tempo, approved periods", () => {
  it("reads a worklog of an approved timesheet as locked and not editable; one submitted or open is editable", async () => {
    const { b, sim, login } = simulated();
    sim.add(login.id, { date: "2026-10-05" });
    sim.add(login.id, { date: "2026-10-14" });
    sim.add(login.id, { date: "2026-10-20" });
    sim.add(login.id, { date: "2026-10-28" });
    sim.outside.approve("2026-10-01", "2026-10-11");
    sim.outside.submit("2026-10-12", "2026-10-18");
    const got = await b.entries.list(meta(), range);
    expect(got.map((w) => w.approval)).toEqual(["approved", "submitted", "none", "none"]);
    expect(got[0]).toMatchObject({ locked: { cause: "approved" }, editable: { update: false, delete: false } });
    expect(got[1]).toMatchObject({ editable: { update: true, delete: true } });
    expect(got[1].locked).toBeUndefined();
    expect(sim.seen.some((s) => s.path.startsWith("/timesheet-approvals/user/") && s.query.includes("from=2026-10-05"))).toBe(true);
  });

  it("writing into an approved period is forbidden (Tempo says 400), whichever write", async () => {
    const { b, sim, ref, login } = simulated();
    const made = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 600), { idempotencyKey: "k" });
    sim.outside.approve("2026-10-12", "2026-10-18");
    expect(await errorOf(b.entries.update!(meta(), made.remoteId, session("2026-10-14T07:00:00Z", 1200), {}))).toMatchObject({ kind: "forbidden", message: expect.stringContaining("approved") });
    expect((await errorOf(b.entries.delete!(meta(), made.remoteId, {})))?.kind).toBe("forbidden");
    expect((await errorOf(b.entries.create!(meta(), ref(login), null, session("2026-10-15T07:00:00Z", 600), { idempotencyKey: "k2" })))?.kind).toBe("forbidden");
    expect(sim.worklogs.length).toBe(1);
    // Moving a free worklog into the approved period is refused too.
    const free = await b.entries.create!(meta(), ref(login), null, session("2026-10-21T07:00:00Z", 600), { idempotencyKey: "k3" });
    expect((await errorOf(b.entries.update!(meta(), free.remoteId, session("2026-10-15T07:00:00Z", 600), {})))?.kind).toBe("forbidden");
  });

  it("a plan without timesheet approvals (403) still lists worklogs, with no approval known and nothing locked", async () => {
    const { b, sim, login } = simulated();
    sim.add(login.id, { date: "2026-10-05" });
    sim.outside.approve("2026-10-01", "2026-10-11");
    sim.withoutApprovals();
    const [w] = await b.entries.list(meta(), range);
    expect(w.approval).toBeUndefined();
    expect(w.locked).toBeUndefined();
    expect(w.editable).toEqual({ update: true, delete: true });
  });
});

describe("tempo, no idempotency and nothing to retry on", () => {
  it("declares only its own de-duplication: the same create sent twice makes two worklogs", async () => {
    const { b, sim, ref, login } = simulated();
    expect(tempoSinkCapabilities.entries).toMatchObject({ idempotency: "local", concurrency: "none" });
    const one = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 600), { idempotencyKey: "same" });
    const two = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 600), { idempotencyKey: "same" });
    expect(one.remoteId).not.toBe(two.remoteId);
    expect(sim.worklogs.length).toBe(2);
    // The key never reaches Tempo.
    expect(JSON.stringify(sim.seen.map((s) => s.body))).not.toContain("same");
  });

  it("a rate limit on a write lands nothing and says when to come back", async () => {
    const { b, sim, ref, login } = simulated();
    sim.exhaust();
    expect(await errorOf(b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 600), { idempotencyKey: "k" }))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 30_000 } });
    expect(sim.worklogs.length).toBe(0);
  });
});

describe("tempo, activities (work attributes)", () => {
  it("offers the values of the first static list, by their names, and a worklog with one reads it back", async () => {
    const { b, sim, ref, login } = simulated();
    expect(await b.entries.activities!(meta(), {}, 10)).toEqual({
      items: [{ id: "DEV", name: "Development" }, { id: "QA", name: "Testing" }, { id: "MEETING", name: "Meetings" }],
      complete: true,
    });
    expect((await b.entries.activities!(meta(), {}, 2)).complete).toBe(false);
    const made = await b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 600, { activityId: "MEETING" }), { idempotencyKey: "k" });
    expect(made.activity).toEqual({ id: "MEETING", name: "Meetings" });
    expect(sim.worklogs[0].attributes).toEqual([{ key: "_WorkType_", value: "MEETING" }]);
  });

  it("an attribute key chosen in the options is the activity; one that doesn't exist leaves no activities", async () => {
    const { b, sim } = simulated({ options: { accountId: "x", workAttributeKey: "_Ticket_" } });
    expect((await b.entries.activities!(meta(), {}, 10)).items).toEqual([]);
    expect(sim.attributes.length).toBe(2);
  });

  it("an activity Tempo doesn't offer is refused before a call; a work attribute the account requires is the service's 400", async () => {
    const { b, sim, ref, login } = simulated();
    const bad = await errorOf(b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 600, { activityId: "LUNCH" }), { idempotencyKey: "k" }));
    expect(bad).toMatchObject({ kind: "invalid", message: expect.stringContaining("LUNCH") });
    expect(sim.seen.some((s) => s.method === "POST")).toBe(false);
    sim.requireAttribute("_Ticket_");
    expect(await errorOf(b.entries.create!(meta(), ref(login), null, session("2026-10-14T07:00:00Z", 600), { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid", message: expect.stringContaining("required") });
  });
});

describe("tempo, reading in pages", () => {
  it("limit is 1000 at most (more is a 400): a list of 1,005 worklogs is read in two pages by offset", async () => {
    const { b, sim, login } = simulated();
    for (let n = 0; n < 1005; n++) sim.add(login.id, { date: "2026-10-14", time: "08:00:00" });
    expect((await sim.fetch(`${sim.apiBase}/worklogs/user/${sim.me.accountId}?limit=1001`, { headers: { Authorization: `Bearer ${sim.token}` } })).status).toBe(400);
    const all = await b.entries.list(meta(), range);
    expect(all.length).toBe(1005);
    expect(new Set(all.map((w) => w.remoteId)).size).toBe(1005);
    const pages = sim.seen.filter((s) => s.path.startsWith("/worklogs/user/") && s.query.includes("from="));
    expect(pages.map((p) => new URLSearchParams(p.query).get("offset"))).toEqual([null, "1000"]);
    expect(new URLSearchParams(pages[0].query).get("limit")).toBe("1000");
  });

  it("lists only the user's own worklogs", async () => {
    const { b, sim, login } = simulated();
    sim.add(login.id, { author: sim.other.accountId });
    sim.add(login.id);
    expect((await b.entries.list(meta(), range)).map((w) => w.authorRemoteId)).toEqual([sim.me.accountId]);
  });
});

describe("tempo, the feed (updatedFrom)", () => {
  it("a first pass is the last seven days by change, then only what changed since its checkpoint (with the overlap)", async () => {
    const { b, sim, login } = simulated();
    const old = sim.add(login.id, { updated: Date.now() - 10 * 86_400_000 });
    const recent = sim.add(login.id, { updated: Date.now() - 2 * 86_400_000 });
    const justBefore = sim.add(login.id, { updated: Date.now() - 30 * 60_000 });
    const first = await readPass((q) => b.entries.changed!(meta(), q), null);
    expect(first.items.map((w) => w.remoteId)).toEqual([String(recent.tempoWorklogId), String(justBefore.tempoWorklogId)]);
    expect(first.items.map((w) => w.remoteId)).not.toContain(String(old.tempoWorklogId));
    expect(first.gone).toEqual([]);
    expect(first.checkpoint).not.toBeNull();
    // The overlap: the checkpoint is an hour behind the pass, so a change just before it is read again; the older one is not.
    sim.outside.edit(old, { seconds: 120 });
    const again = await readPass((q) => b.entries.changed!(meta(), q), first.checkpoint);
    expect(again.items.map((w) => [w.remoteId, w.span.seconds])).toEqual([[String(old.tempoWorklogId), 120], [String(justBefore.tempoWorklogId), 3600]]);
    const query = sim.seen.filter((s) => s.query.includes("updatedFrom")).at(-1)!.query;
    expect(new URLSearchParams(query).get("updatedFrom")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("refuses an updatedFrom of another stream's checkpoint, and a page token of another pass", async () => {
    const { b } = simulated();
    const first = await readPass((q) => b.entries.changed!(meta(), q), null);
    expect(first.checkpoint).not.toBeNull();
    const other = bindSink(tempoSink, { ...simulated().conn, id: 10 });
    expect((await errorOf(other.entries.changed!(meta(), { since: first.checkpoint, page: null })))?.kind).toBe("invalidCheckpoint");
  });

  it("reads a long pass page after page, each worklog once", async () => {
    const { b, sim, login } = simulated();
    for (let n = 0; n < 1003; n++) sim.add(login.id);
    const pass = await readPass((q) => b.entries.changed!(meta(), q), null);
    expect(pass.pages).toBe(2);
    expect(new Set(pass.items.map((w) => w.remoteId)).size).toBe(1003);
  });
});

describe("tempo, entries as the sync reads them", () => {
  it("every entry is a session by the contract's checks, with its issue by id", async () => {
    const { b, sim, login, csv } = simulated();
    sim.add(login.id);
    sim.add(csv.id, { attributes: [{ key: "_WorkType_", value: "DEV" }] });
    const got: RemoteWorklog[] = await b.entries.list(meta(), range);
    expect(got.map((w) => [w.issue?.remoteId, w.activity?.id ?? null])).toEqual([[String(login.id), null], [String(csv.id), "DEV"]]);
    expect(got.every((w) => w.span.kind === "session")).toBe(true);
  });
});
