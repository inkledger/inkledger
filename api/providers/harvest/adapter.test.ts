import { describe, expect, it, vi } from "vitest";
import type { TimeSinkType } from "@contracts/providers";
import { instant, localDate, timeZone } from "@contracts/values";
import { bindSink, type StoredSinkConn } from "../core/bind";
import { readPass } from "../core/paging";
import { sinkConformance } from "../conformance/suite";
import type { ExternalRef, SinkTarget, WorklogInput } from "../types";
import { harvestSimulator } from "./simulator";
import { harvestSink } from "./adapter";
import { USER_AGENT } from "./client";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "52.200.10.20", family: 4 }]),
}));

const REF: ExternalRef = {
  trackerType: "jira",
  trackerConnectionId: 3,
  issue: { remoteId: "10042", key: "ABC-12", container: { remoteId: "10000", key: "ABC" } },
  snapshot: { url: "https://jira.example.com/browse/ABC-12", title: "Fix the login" },
};

function simulated(o: { timestamps?: boolean; zone?: string; accountId?: string; token?: string } = {}) {
  const sim = harvestSimulator(undefined, { timestamps: o.timestamps });
  vi.stubGlobal("fetch", sim.fetch);
  const conn: StoredSinkConn<"harvest"> = {
    id: 7,
    userId: 1,
    type: "harvest" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: String(sim.me.id),
    options: { accountId: o.accountId ?? sim.accountId },
    timeZone: timeZone(o.zone ?? "Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, conn, b: bindSink(harvestSink, conn) };
}

sinkConformance("harvest (simulated, duration account)", async () => {
  const { conn } = simulated();
  return { provider: harvestSink, conn, ref: REF, writable: true };
});

sinkConformance("harvest (simulated, timestamp account)", async () => {
  const { conn } = simulated({ timestamps: true });
  return { provider: harvestSink, conn, ref: REF, writable: true };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; message: string; rateLimit?: { retryAfterMs?: number } });
const at = (y: number, mo: number, d: number, h = 8, mi = 30) => instant(Date.UTC(y, mo - 1, d, h, mi));
const input = (seconds: number, start = at(2026, 10, 14), comment = "worked"): WorklogInput => ({ time: { kind: "session", start, seconds }, comment });
const range = { from: localDate("2026-10-01"), to: localDate("2026-10-31") };

async function target(b: ReturnType<typeof simulated>["b"], query = "web"): Promise<SinkTarget> {
  const found = (await b.targets!(meta(), query, 10)).items;
  if (!found[0]) throw new Error(`no target for ${query}`);
  return found[0];
}

describe("harvest, the connection", () => {
  it("sends the token as a Bearer, the account id and a User-Agent; knows who the token is", async () => {
    const { b, sim } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: String(sim.me.id), name: "Mario Rossi", email: "mario.rossi@example.com" });
    expect(sim.state.userAgents).toEqual([USER_AGENT]);
    // The simulator holds Harvest's rule: no User-Agent, no answer.
    const bare = await sim.fetch(`${sim.apiBase}/users/me`, { headers: { Authorization: `Bearer ${sim.token}`, "Harvest-Account-Id": sim.accountId } });
    expect(bare.status).toBe(400);
  });

  it("a revoked token is auth, a token that cannot reach the account is forbidden", async () => {
    const { b, sim } = simulated();
    sim.revoke();
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "auth" });
    const other = simulated({ accountId: "999" });
    expect(await errorOf(other.b.verify(meta()))).toMatchObject({ kind: "forbidden" });
  });

  it("a deactivated user is forbidden", async () => {
    const { b, sim } = simulated();
    sim.outside.deactivateMe();
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "forbidden" });
  });

  it("takes the account id as a number or a string, and nothing else", () => {
    expect(harvestSink.parseOptions({ accountId: 1234567 })).toEqual({ accountId: "1234567" });
    expect(harvestSink.parseOptions({ accountId: "1234567" })).toEqual({ accountId: "1234567" });
    for (const bad of [{}, null, { accountId: "abc" }, { accountId: "1", token: "x" }]) expect(() => harvestSink.parseOptions(bad)).toThrow();
  });

  it("its probe keeps to the provider and reports the published budget (100 calls per 15 s)", async () => {
    const { b } = simulated();
    expect((await b.probe(meta())).rateLimit).toEqual({ perHour: 24_000, origin: "typical" });
  });

  it("over 100 requests in 15 seconds the 101st is a rateLimit, with the wait Harvest asks for", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 100; n++) await b.verify(meta());
    const err = await errorOf(b.verify(meta()));
    expect(err).toMatchObject({ kind: "rateLimit" });
    expect(err?.rateLimit?.retryAfterMs).toBeGreaterThan(0);
    expect(err?.rateLimit?.retryAfterMs).toBeLessThanOrEqual(15_000);
    sim.state.window = [];
    expect((await b.verify(meta())).name).toBe("Mario Rossi");
  });

  it("an exhausted account waits Retry-After", async () => {
    const { b, sim } = simulated();
    sim.exhaust();
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 12_000 } });
  });
});

describe("harvest, targets (the user's project assignments)", () => {
  it("finds a task by its project, client, code or own name; the id keeps project and task", async () => {
    const { b, sim } = simulated();
    const web = (await b.targets!(meta(), "website", 10)).items;
    expect(web.map((t) => t.name)).toEqual(["Development", "Meetings", "Design"]);
    expect(web[0]).toEqual({ remoteId: `${sim.website.id}:1`, name: "Development", path: [{ remoteId: String(sim.website.id), name: "Acme / Website" }] });
    expect((await b.targets!(meta(), "PLT", 10)).items.map((t) => t.remoteId)).toEqual([`${sim.platform.id}:1`]);
    expect((await b.targets!(meta(), "acme", 50)).items.length).toBe(4);
    expect((await b.targets!(meta(), "design", 10)).items.map((t) => t.name)).toEqual(["Design"]);
    expect((await b.targets!(meta(), "nothing like it", 10)).items).toEqual([]);
  });

  it("leaves out archived projects and unassigned tasks, and says when the list was cut", async () => {
    const { b, sim } = simulated();
    sim.outside.archive(sim.platform);
    sim.outside.unassign(sim.website, 3);
    const all = await b.targets!(meta(), "", 1);
    expect(all.items.length).toBe(1);
    expect(all.complete).toBe(false);
    const rest = await b.targets!(meta(), "", 50);
    expect(rest.items.map((t) => t.remoteId).sort()).toEqual([`${sim.website.id}:1`, `${sim.website.id}:2`].sort());
    expect(rest.complete).toBe(true);
  });

  it("reads every page of assignments (pages of 100)", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 130; n++) sim.project(`Bulk ${n}`, { code: `B${n}`, tasks: [1] });
    const all = await b.targets!(meta(), "bulk", 500);
    expect(all.items.length).toBe(130);
    expect(all.complete).toBe(true);
    expect(new Set(all.items.map((t) => t.remoteId)).size).toBe(130);
  });
});

describe("harvest, filing an entry", () => {
  it("files under project and task, points back with external_reference, and puts the key and title first in the notes", async () => {
    const { b, sim } = simulated();
    const t = await target(b);
    const made = await b.entries.create!(meta(), REF, t, input(3600, at(2026, 10, 14), "fixed the form"), { idempotencyKey: "k-1" });
    const stored = sim.entries.find((e) => String(e.id) === made.remoteId)!;
    expect(stored).toMatchObject({ projectId: sim.website.id, taskId: 1, date: "2026-10-14", hours: 1 });
    expect(stored.notes).toBe("[ABC-12] Fix the login\n\nfixed the form");
    expect(stored.external).toEqual({ id: "10042", group_id: "10000", account_id: "jira:3", permalink: "https://jira.example.com/browse/ABC-12" });
    expect(made).toMatchObject({ issue: { remoteId: "10042", key: "ABC-12" }, comment: "fixed the form", span: { kind: "session", seconds: 3600 }, authorRemoteId: String(sim.me.id), billable: true, approval: "none", editable: { update: true, delete: true } });
  });

  it("an entry with no comment still says which issue it is", async () => {
    const { b, sim } = simulated();
    await b.entries.create!(meta(), REF, await target(b), input(1800, at(2026, 10, 14), ""), { idempotencyKey: "k" });
    expect(sim.entries[0].notes).toBe("[ABC-12] Fix the login");
  });

  it("a title on several lines is one line in the notes; a missing link leaves out the permalink", async () => {
    const { b, sim } = simulated();
    const ref: ExternalRef = { ...REF, issue: { remoteId: "7", key: "ABC-7" }, snapshot: { url: "", title: "Two\nlines   here" } };
    await b.entries.create!(meta(), ref, await target(b), input(1800), { idempotencyKey: "k" });
    expect(sim.entries[0].notes.startsWith("[ABC-7] Two lines here")).toBe(true);
    expect(sim.entries[0].external).toEqual({ id: "7", group_id: null, account_id: "jira:3", permalink: null });
  });

  it("an entry nobody linked is read with no issue; one with only a header keeps the key", async () => {
    const { b, sim } = simulated();
    sim.add({ date: "2026-10-14", hours: 1, notes: "just a note" });
    sim.add({ date: "2026-10-14", hours: 1, notes: "[XYZ-1] Something\n\nand more" });
    const list = await b.entries.list(meta(), range);
    expect(list.map((w) => [w.issue, w.comment])).toEqual(
      expect.arrayContaining([
        [null, "just a note"],
        [{ key: "XYZ-1" }, "and more"],
      ]),
    );
  });

  it("a retried create makes a second entry: Harvest has no idempotency key", async () => {
    const { b, sim } = simulated();
    const t = await target(b);
    const a = await b.entries.create!(meta(), REF, t, input(3600), { idempotencyKey: "same" });
    const c = await b.entries.create!(meta(), REF, t, input(3600), { idempotencyKey: "same" });
    expect(a.remoteId).not.toBe(c.remoteId);
    expect(sim.entries.length).toBe(2);
    expect(harvestSink.capabilities.entries).toMatchObject({ idempotency: "local" });
  });

  it("updates in place, keeping the entry, its link to the issue and the header of its notes", async () => {
    const { b, sim } = simulated();
    const made = await b.entries.create!(meta(), REF, await target(b), input(3600, at(2026, 10, 14), "first"), { idempotencyKey: "k" });
    const changed = await b.entries.update!(meta(), made.remoteId, input(5400, at(2026, 10, 15), "second"), {});
    expect(changed).toMatchObject({ remoteId: made.remoteId, comment: "second", span: { seconds: 5400 }, issue: { remoteId: "10042", key: "ABC-12" } });
    const stored = sim.entries[0];
    expect(stored).toMatchObject({ date: "2026-10-15", hours: 1.5 });
    expect(stored.notes).toBe("[ABC-12] Fix the login\n\nsecond");
    expect(stored.external?.id).toBe("10042");
    expect(sim.entries.length).toBe(1);
  });

  it("deletes, and deleting what is gone is a success", async () => {
    const { b, sim } = simulated();
    const made = await b.entries.create!(meta(), REF, await target(b), input(3600), { idempotencyKey: "k" });
    await b.entries.delete!(meta(), made.remoteId, {});
    await b.entries.delete!(meta(), made.remoteId, {});
    expect(sim.entries).toEqual([]);
  });
});

describe("harvest, project and task are required", () => {
  it("refuses an entry with no target before calling, and a target that is not project:task", async () => {
    const { b, sim } = simulated();
    const calls = sim.state.calls;
    expect(await errorOf(b.entries.create!(meta(), REF, null, input(3600), { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid" });
    expect(await errorOf(b.entries.create!(meta(), REF, { remoteId: "123", name: "x", path: [] }, input(3600), { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid" });
    expect(sim.state.calls).toBe(calls);
  });

  it("Harvest itself refuses a call with no project or task", async () => {
    const { sim } = simulated();
    const headers = { Authorization: `Bearer ${sim.token}`, "Harvest-Account-Id": sim.accountId, "User-Agent": "t", "Content-Type": "application/json" };
    const post = async (body: unknown) => sim.fetch(`${sim.apiBase}/time_entries`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(await (await post({ spent_date: "2026-10-14", hours: 1 })).json()).toEqual({ message: "Project can't be blank" });
    expect(await (await post({ project_id: sim.website.id, spent_date: "2026-10-14", hours: 1 })).json()).toEqual({ message: "Task can't be blank" });
  });

  it("a task not assigned to the project, an archived project and a withdrawn assignment are invalid", async () => {
    const { b, sim } = simulated();
    expect(await errorOf(b.entries.create!(meta(), REF, { remoteId: `${sim.platform.id}:3`, name: "Design", path: [] }, input(3600), { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid", message: expect.stringContaining("Task is not assigned") as string });
    const web = await target(b);
    sim.outside.unassign(sim.website, 1);
    expect(await errorOf(b.entries.create!(meta(), REF, web, input(3600), { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid" });
    sim.outside.archive(sim.website);
    expect(await errorOf(b.entries.create!(meta(), REF, { remoteId: `${sim.website.id}:2`, name: "Meetings", path: [] }, input(3600), { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid", message: expect.stringContaining("not active") as string });
    expect(sim.entries).toEqual([]);
  });
});

describe("harvest, hours are decimal (rounding)", () => {
  it("keeps two decimals of an hour, 36 seconds: what is sent is rounded, and the entry reads back as Harvest holds it", async () => {
    const { b, sim } = simulated();
    const t = await target(b);
    // 90 s is 0.025 h: 0.03 h, which reads back as 108 s.
    const made = await b.entries.create!(meta(), REF, t, input(90), { idempotencyKey: "a" });
    expect(sim.entries[0].hours).toBe(0.03);
    expect(made.span.seconds).toBe(108);
    // 1 h 1 min is 1.01667 h: 1.02 h, twelve seconds more than logged.
    const b2 = await b.entries.create!(meta(), REF, t, input(3660), { idempotencyKey: "b" });
    expect(sim.entries[1].hours).toBe(1.02);
    expect(b2.span.seconds).toBe(3672);
    // A whole quarter hour is exact.
    expect((await b.entries.create!(meta(), REF, t, input(900), { idempotencyKey: "c" })).span.seconds).toBe(900);
  });

  it("refuses what rounds to nothing, and more than a day", async () => {
    const { b, sim } = simulated();
    const t = await target(b);
    expect(await errorOf(b.entries.create!(meta(), REF, t, input(10), { idempotencyKey: "a" }))).toMatchObject({ kind: "invalid" });
    expect(await errorOf(b.entries.create!(meta(), REF, t, input(25 * 3600), { idempotencyKey: "b" }))).toMatchObject({ kind: "invalid" });
    expect(sim.entries).toEqual([]);
  });
});

describe("harvest, days have no zone but the clock has", () => {
  it("the entry is dated by the user's zone, not UTC's", async () => {
    const { b, sim } = simulated();
    const t = await target(b);
    // 22:30 UTC on the 14th is 00:30 on the 15th in Rome (UTC+2 in October).
    await b.entries.create!(meta(), REF, t, input(3600, at(2026, 10, 14, 22, 30)), { idempotencyKey: "a" });
    expect(sim.entries[0].date).toBe("2026-10-15");
    // 03:00 UTC on the 15th is still the 14th in Los Angeles.
    const la = simulated({ zone: "America/Los_Angeles" });
    await la.b.entries.create!(meta(), REF, await target(la.b), input(3600, at(2026, 10, 15, 3, 0)), { idempotencyKey: "a" });
    expect(la.sim.entries[0].date).toBe("2026-10-14");
  });

  it("a period is read by spent date, both days included", async () => {
    const { b, sim } = simulated();
    for (const d of ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) sim.add({ date: d, hours: 1 });
    const got = await b.entries.list(meta(), { from: localDate("2026-10-14"), to: localDate("2026-10-15") });
    expect(got.map((w) => w.span.kind === "session" && sim.entries.find((e) => String(e.id) === w.remoteId)?.date).sort()).toEqual(["2026-10-14", "2026-10-15"]);
  });

  it("a duration account has no time of day: the entry reads as starting at the day's start in the user's zone", async () => {
    const { b } = simulated();
    const made = await b.entries.create!(meta(), REF, await target(b), input(3600, at(2026, 10, 14, 13, 45)), { idempotencyKey: "a" });
    // Midnight in Rome on the 14th is 22:00 UTC on the 13th.
    expect(made.span).toMatchObject({ kind: "session", start: Date.UTC(2026, 9, 13, 22, 0) });
  });

  it("the offset of the day itself counts (summer time ends on 25 October)", async () => {
    const { b } = simulated();
    const made = await b.entries.create!(meta(), REF, await target(b), input(3600, at(2026, 10, 26, 10, 0)), { idempotencyKey: "a" });
    // Midnight in Rome on the 26th is UTC+1: 23:00 UTC on the 25th.
    expect(made.span).toMatchObject({ start: Date.UTC(2026, 9, 25, 23, 0) });
  });
});

describe("harvest, a timestamp account", () => {
  it("keeps a start and an end to the minute, and reads the start back", async () => {
    const { b, sim } = simulated({ timestamps: true });
    const made = await b.entries.create!(meta(), REF, await target(b), input(5400, at(2026, 10, 14, 8, 30)), { idempotencyKey: "a" });
    expect(sim.entries[0]).toMatchObject({ date: "2026-10-14", hours: 1.5, startedMinute: 10 * 60 + 30 });
    expect(made.span).toEqual({ kind: "session", start: Date.UTC(2026, 9, 14, 8, 30), seconds: 5400 });
    // An update moves the start along.
    const moved = await b.entries.update!(meta(), made.remoteId, input(3600, at(2026, 10, 14, 13, 0)), {});
    expect(moved.span).toEqual({ kind: "session", start: Date.UTC(2026, 9, 14, 13, 0), seconds: 3600 });
  });

  it("rounds the length to the minute, and refuses what would cross midnight, before calling", async () => {
    const { b, sim } = simulated({ timestamps: true });
    const t = await target(b);
    expect((await b.entries.create!(meta(), REF, t, input(100, at(2026, 10, 14, 8, 0)), { idempotencyKey: "a" })).span.seconds).toBe(120);
    expect(await errorOf(b.entries.create!(meta(), REF, t, input(20, at(2026, 10, 14, 8, 0)), { idempotencyKey: "b" }))).toMatchObject({ kind: "invalid" });
    // 23:30 in Rome is 21:30 UTC; two hours would end the next day.
    expect(await errorOf(b.entries.create!(meta(), REF, t, input(7200, at(2026, 10, 14, 21, 30)), { idempotencyKey: "c" }))).toMatchObject({ kind: "invalid", message: expect.stringContaining("midnight") as string });
    expect(sim.entries.length).toBe(1);
  });

  it("Harvest itself refuses an end before the start", async () => {
    const { sim } = simulated({ timestamps: true });
    const headers = { Authorization: `Bearer ${sim.token}`, "Harvest-Account-Id": sim.accountId, "User-Agent": "t", "Content-Type": "application/json" };
    const res = await sim.fetch(`${sim.apiBase}/time_entries`, { method: "POST", headers, body: JSON.stringify({ project_id: sim.website.id, task_id: 1, spent_date: "2026-10-14", started_time: "11:00pm", ended_time: "1:00am" }) });
    expect(res.status).toBe(422);
  });
});

describe("harvest, running timers", () => {
  it("an entry created without hours would start a timer: the adapter always sends the length, so its entries never run", async () => {
    const { b, sim } = simulated();
    const headers = { Authorization: `Bearer ${sim.token}`, "Harvest-Account-Id": sim.accountId, "User-Agent": "t", "Content-Type": "application/json" };
    const res = await sim.fetch(`${sim.apiBase}/time_entries`, { method: "POST", headers, body: JSON.stringify({ project_id: sim.website.id, task_id: 1, spent_date: "2026-10-14" }) });
    expect(((await res.json()) as { is_running: boolean }).is_running).toBe(true);
    sim.entries.length = 0;
    await b.entries.create!(meta(), REF, await target(b), input(3600), { idempotencyKey: "a" });
    expect(sim.entries[0].running).toBe(false);
  });

  it("a timer still counting is not listed; once stopped it arrives in the feed like any change", async () => {
    const { b, sim } = simulated();
    const timer = sim.outside.startTimer(sim.website, 1, "2026-10-14");
    expect(await b.entries.list(meta(), range)).toEqual([]);
    const first = await readPass((q) => b.entries.changed!(meta(), q), null);
    expect(first.items).toEqual([]);
    sim.outside.stopTimer(timer, 1.5);
    const next = await readPass((q) => b.entries.changed!(meta(), q), first.checkpoint);
    expect(next.items.map((w) => [w.remoteId, w.span.seconds])).toEqual([[String(timer.id), 5400]]);
  });
});

describe("harvest, locked, approved and invoiced entries", () => {
  it("an approved entry reads as approved and locked, not editable; changing it is a conflict", async () => {
    const { b, sim } = simulated();
    const made = await b.entries.create!(meta(), REF, await target(b), input(3600), { idempotencyKey: "a" });
    sim.outside.approve(sim.entries[0]);
    const [seen] = await b.entries.list(meta(), range);
    expect(seen).toMatchObject({ remoteId: made.remoteId, approval: "approved", locked: { cause: "approved" }, editable: { update: false, delete: false } });
    expect(await errorOf(b.entries.update!(meta(), made.remoteId, input(1800), {}))).toMatchObject({ kind: "conflict" });
    expect(await errorOf(b.entries.delete!(meta(), made.remoteId, {}))).toMatchObject({ kind: "conflict" });
    expect(sim.entries.length).toBe(1);
  });

  it("an invoiced entry and one in a locked period say why", async () => {
    const { b, sim } = simulated();
    const one = sim.add({ date: "2026-10-14", hours: 1 });
    const two = sim.add({ date: "2026-10-14", hours: 1 });
    sim.outside.invoice(one);
    sim.outside.lock(two);
    const seen = new Map((await b.entries.list(meta(), range)).map((w) => [w.remoteId, w]));
    expect(seen.get(String(one.id))).toMatchObject({ locked: { cause: "invoiced" }, approval: "none", editable: { update: false, delete: false } });
    expect(seen.get(String(two.id))).toMatchObject({ locked: { cause: "other", message: "Locked: the timesheet period is closed" }, editable: { update: false, delete: false } });
    expect(await errorOf(b.entries.update!(meta(), String(one.id), input(60 * 30), {}))).toMatchObject({ kind: "conflict" });
  });

  it("an entry gone from Harvest is notFound for an update, a success for a delete", async () => {
    const { b } = simulated();
    expect(await errorOf(b.entries.update!(meta(), "404", input(3600), {}))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.entries.delete!(meta(), "404", {}))).toBeNull();
  });
});

describe("harvest, reading", () => {
  it("lists only the user's entries (an admin's list holds everyone's), every page", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 130; n++) sim.add({ date: "2026-10-14", hours: 1 });
    for (let n = 0; n < 5; n++) sim.add({ date: "2026-10-14", hours: 1, user: sim.colleague.id });
    const all = await b.entries.list(meta(), range);
    expect(all.length).toBe(130);
    expect(new Set(all.map((w) => w.remoteId)).size).toBe(130);
    expect(all.every((w) => w.authorRemoteId === String(sim.me.id))).toBe(true);
    // Unfiltered, Harvest shows the admin the others' too.
    const raw = await sim.fetch(`${sim.apiBase}/time_entries?per_page=2000`, { headers: { Authorization: `Bearer ${sim.token}`, "Harvest-Account-Id": sim.accountId, "User-Agent": "t" } });
    expect(((await raw.json()) as { total_entries: number }).total_entries).toBe(135);
  });

  it("the feed is a window of the last 7 days by change; then only what changed since its checkpoint", async () => {
    const { b, sim } = simulated();
    const old = sim.add({ date: "2026-09-01", hours: 1 });
    old.updated = Date.now() - 8 * 86_400_000;
    for (let n = 0; n < 130; n++) sim.add({ date: "2026-10-14", hours: 1 });
    const first = await readPass((q) => b.entries.changed!(meta(), q), null);
    expect(first.pages).toBe(2);
    expect(first.items.length).toBe(130);
    expect(first.items.map((w) => w.remoteId)).not.toContain(String(old.id));
    expect(first.checkpoint).not.toBeNull();
    // The overlap of an hour re-reads recent changes: all of them, idempotently.
    expect((await readPass((q) => b.entries.changed!(meta(), q), first.checkpoint)).items.length).toBe(130);
    // An older checkpoint's overlap never reaches past the window.
    const touched = sim.entries[5];
    touched.updated = Date.now() - 2 * 3_600_000;
    for (const e of sim.entries) if (e !== touched) e.updated = Date.now() - 3 * 3_600_000;
    const later = await readPass((q) => b.entries.changed!(meta(), q), first.checkpoint);
    expect(later.items).toEqual([]);
    sim.outside.edit(touched, { hours: 2 });
    const again = await readPass((q) => b.entries.changed!(meta(), q), first.checkpoint);
    expect(again.items.map((w) => [w.remoteId, w.span.seconds])).toEqual([[String(touched.id), 7200]]);
  });

  it("asks updated_since in UTC, and reads a change as an update by the user elsewhere", async () => {
    const { b, sim } = simulated();
    const e = sim.add({ date: "2026-10-14", hours: 1, notes: "[ABC-12] Fix the login\n\nold" });
    const spy = vi.fn(sim.fetch);
    vi.stubGlobal("fetch", spy);
    const first = await readPass((q) => b.entries.changed!(meta(), q), null);
    const asked = new URL(String(spy.mock.calls.find(([u]) => String(u).includes("/time_entries"))?.[0]));
    expect(asked.searchParams.get("updated_since")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(asked.searchParams.get("user_id")).toBe(String(sim.me.id));
    expect(asked.searchParams.get("is_running")).toBe("false");
    sim.outside.edit(e, { notes: "[ABC-12] Fix the login\n\nnew words" });
    const next = await readPass((q) => b.entries.changed!(meta(), q), first.checkpoint);
    expect(next.items.find((w) => w.remoteId === String(e.id))?.comment).toBe("new words");
  });

  it("refuses a checkpoint or page token of another connection, stream or pass", async () => {
    const { b, conn } = simulated();
    const mine = (await readPass((q) => b.entries.changed!(meta(), q), null)).checkpoint;
    const other = bindSink(harvestSink, { ...conn, id: conn.id + 1 });
    expect(await errorOf(other.entries.changed!(meta(), { since: mine, page: null }))).toMatchObject({ kind: "invalidCheckpoint" });
    expect(await errorOf(b.entries.changed!(meta(), { since: "garbage" as never, page: null }))).toMatchObject({ kind: "invalidCheckpoint" });
  });

  it("an external reference with no key in the notes is still the issue", async () => {
    const { b, sim } = simulated();
    sim.add({ date: "2026-10-14", hours: 1, notes: "from elsewhere", external: { id: "55", group_id: null, account_id: "jira:3", permalink: null } });
    expect((await b.entries.list(meta(), range))[0].issue).toEqual({ remoteId: "55" });
  });
});

describe("harvest, the contract", () => {
  it("declares what the catalogue says, on the type the registry expects", () => {
    const type: TimeSinkType = harvestSink.type;
    expect(type).toBe("harvest");
    expect(harvestSink.capabilities.references).toEqual(["external", "projectTask", "description"]);
    expect(harvestSink.capabilities.target).toEqual({ use: "required", lookup: "search" });
    expect("activities" in harvestSink.entries).toBe(false);
    expect("setDayTotal" in harvestSink.entries).toBe(false);
  });
});
