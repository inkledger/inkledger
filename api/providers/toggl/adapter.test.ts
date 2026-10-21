import { describe, expect, it, vi } from "vitest";
import { instant, localDate, timeZone } from "@contracts/values";
import { bindSink } from "../core/bind";
import { readPass } from "../core/paging";
import { sinkConformance } from "../conformance/suite";
import { registryProblems, sinkAdapter, sinkStatus } from "../registry";
import type { ExternalRef, SinkTarget, WorklogInput } from "../types";
import { MAX_DESCRIPTION, noteHead, noteOf, readNote, togglSink, dayStart } from "./adapter";
import { togglSimulator } from "./simulator";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "104.16.100.29", family: 4 }]),
}));

const REF: ExternalRef = {
  trackerType: "jira",
  trackerConnectionId: 1,
  issue: { remoteId: "10001", key: "ACME-12" },
  snapshot: { url: "https://jira.example/browse/ACME-12", title: "Login fails on Safari" },
};

function simulated(o: { options?: unknown; token?: string; zone?: string; cap?: number } = {}) {
  const sim = togglSimulator(undefined, { cap: o.cap });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 7,
    userId: 1,
    type: "toggl" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: String(sim.me.id),
    options: o.options ?? { workspaceId: 9001 },
    timeZone: timeZone(o.zone ?? "Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, conn, b: bindSink(togglSink, conn) };
}

sinkConformance("toggl (simulated)", async () => {
  const { sim, conn } = simulated();
  sim.project("Website");
  return { provider: togglSink, conn, ref: REF, writable: true };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; status?: number; rateLimit?: { retryAfterMs?: number }; message: string });
const at = (iso: string) => instant(Date.parse(iso));
const input = (iso: string, seconds: number, extra: Partial<WorklogInput> = {}): WorklogInput => ({ time: { kind: "session", start: at(iso), seconds }, comment: "", ...extra });
const day = (from: string, to = from) => ({ from: localDate(from), to: localDate(to) });
const target = (id: number): SinkTarget => ({ remoteId: String(id), name: "p", path: [] });
const posts = (sim: ReturnType<typeof simulated>["sim"]) => sim.log.filter((l) => l.method === "POST");
const gets = (sim: ReturnType<typeof simulated>["sim"]) => sim.log.filter((l) => l.method === "GET" && l.path === "/me/time_entries");

describe("toggl, connection", () => {
  it("options: the workspace id, as a number or as text; nothing else is a connection", () => {
    expect(togglSink.parseOptions({ workspaceId: "9001" })).toEqual({ workspaceId: 9001 });
    expect(togglSink.parseOptions({ workspaceId: 9001 })).toEqual({ workspaceId: 9001 });
    expect(() => togglSink.parseOptions({})).toThrow(/workspaceId/);
    expect(() => togglSink.parseOptions({ workspaceId: "acme" })).toThrow();
    expect(() => togglSink.parseOptions({ workspaceId: -1 })).toThrow();
  });

  it("auth: the token is sent as Basic <token>:api_token, and a wrong one is 'auth' although Toggl answers 403", async () => {
    const { sim, b } = simulated();
    expect((await b.verify(meta())).remoteId).toBe("4001");
    expect(sim.log).toHaveLength(1);
    const wrong = simulated({ token: "nope" });
    expect((await errorOf(wrong.b.verify(meta())))?.kind).toBe("auth");
    expect(wrong.sim.log[0].path).toBe("/me");
    const revoked = simulated();
    revoked.sim.revoke();
    expect((await errorOf(revoked.b.verify(meta())))?.kind).toBe("auth");
  });

  it("verify names the user", async () => {
    const { b } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: "4001", name: "Mario Rossi", email: "mario.rossi@example.com" });
  });

  it("probe: the free plan is 30 requests an hour and has no billable rates; a paid plan keeps billable and has a bigger budget", async () => {
    const free = simulated();
    const p = await free.b.probe(meta());
    expect(p.rateLimit).toEqual({ perHour: 30, origin: "typical" });
    expect(p.capabilities.entries).toMatchObject({ billable: { read: true, write: false } });
    const paid = simulated();
    paid.sim.plan("starter");
    const q = await paid.b.probe(meta());
    expect(q.rateLimit).toEqual({ perHour: 240, origin: "typical" });
    expect(q.capabilities.entries).toMatchObject({ billable: { read: true, write: true } });
  });

  it("probe: a workspace the user isn't in is refused as forbidden, not found", async () => {
    const { b } = simulated({ options: { workspaceId: 12345 } });
    expect((await errorOf(b.probe(meta())))?.kind).toBe("forbidden");
  });
});

describe("toggl, targets", () => {
  it("projects are searched here, by part of the name and ignoring case (the API's name filter is exact); archived ones are not offered", async () => {
    const { sim, b } = simulated();
    sim.project("Website");
    sim.project("Webshop");
    sim.project("Mobile app");
    sim.project("Web legacy", { active: false });
    sim.project("Elsewhere", { workspace: 9002 });
    const found = await b.targets!(meta(), "WEB", 10);
    expect(found.items.map((t) => t.name)).toEqual(["Webshop", "Website"]);
    expect(found.complete).toBe(true);
    expect(found.items[0]).toEqual({ remoteId: expect.stringMatching(/^\d+$/), name: "Webshop", path: [] });
    expect(sim.log).toHaveLength(1);
  });

  it("an empty workspace answers null for its projects: no projects", async () => {
    const { b } = simulated();
    expect(await b.targets!(meta(), "", 10)).toEqual({ items: [], complete: true });
  });

  it("projects come 200 a page (151 by default): more than a page are all read; a limit says when it cut", async () => {
    const { sim, b } = simulated();
    sim.plan("premium");
    for (let n = 0; n < 230; n++) sim.project(`Project ${String(n).padStart(3, "0")}`);
    const all = await b.targets!(meta(), "project", 500);
    expect(all.items).toHaveLength(230);
    expect(all.complete).toBe(true);
    expect(sim.log.map((l) => l.query.get("per_page"))).toEqual(["200", "200"]);
    const some = await b.targets!(meta(), "project", 5);
    expect(some).toMatchObject({ complete: false });
    expect(some.items).toHaveLength(5);
  });
});

describe("toggl, writing", () => {
  it("files an entry as a start and a duration in seconds, under the project, with the issue in the note", async () => {
    const { sim, b } = simulated();
    const project = sim.project("Website");
    const made = await b.entries.create!(meta(), REF, target(project.id), input("2026-10-14T08:30:00.000Z", 5400, { comment: "fixed the redirect" }), { idempotencyKey: "k-1" });
    const [post] = posts(sim);
    expect(post.path).toBe("/workspaces/9001/time_entries");
    expect(post.body).toEqual({
      created_with: "inkledger",
      workspace_id: 9001,
      start: "2026-10-14T08:30:00Z",
      duration: 5400,
      description: "[ACME-12] Login fails on Safari — fixed the redirect",
      project_id: project.id,
    });
    const [e] = sim.live();
    expect(e).toMatchObject({ project: project.id, duration: 5400, stop: Date.parse("2026-10-14T10:00:00Z") });
    expect(made).toMatchObject({
      remoteId: String(e.id),
      issue: { key: "ACME-12" },
      span: { kind: "session", start: Date.parse("2026-10-14T08:30:00Z"), seconds: 5400 },
      comment: "fixed the redirect",
      authorRemoteId: "4001",
      editable: { update: true, delete: true },
    });
  });

  it("an entry with no target is filed under no project", async () => {
    const { sim, b } = simulated();
    await b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "k" });
    expect(posts(sim)[0].body).not.toHaveProperty("project_id");
    expect(sim.live()[0].project).toBeNull();
  });

  it("a workspace that requires a project refuses an entry without one, in Toggl's words; with one it is filed", async () => {
    const { sim, b } = simulated();
    sim.outside.require({ project: true });
    const project = sim.project("Website");
    const refused = await errorOf(b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "k" }));
    expect(refused).toMatchObject({ kind: "invalid", message: expect.stringContaining("Project is required") });
    await b.entries.create!(meta(), REF, target(project.id), input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "k" });
    expect(sim.live()).toHaveLength(1);
  });

  it("an archived project is refused", async () => {
    const { sim, b } = simulated();
    const old = sim.project("Old", { active: false });
    expect((await errorOf(b.entries.create!(meta(), REF, target(old.id), input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "k" })))?.kind).toBe("invalid");
  });

  it("billable is for paid plans: refused on the free one, kept on a paid one and read back", async () => {
    const free = simulated();
    expect(await errorOf(free.b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 600, { billable: true }), { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid" });
    const paid = simulated();
    paid.sim.plan("starter");
    const made = await paid.b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 600, { billable: true }), { idempotencyKey: "k" });
    expect(made.billable).toBe(true);
    // Not asked: not sent (the free plan would refuse even false? it doesn't, but nothing is said either).
    const plain = simulated();
    await plain.b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "k" });
    expect(posts(plain.sim)[0].body).not.toHaveProperty("billable");
  });

  it("a target with an ancestor is a task: filed with its project and task; a plan without tasks answers 402, which is not a rate limit", async () => {
    const paid = simulated();
    paid.sim.plan("premium");
    const project = paid.sim.project("Website");
    const task = paid.sim.task("Fixes", project);
    const asTask: SinkTarget = { remoteId: String(task.id), name: "Fixes", path: [{ remoteId: String(project.id), name: "Website" }] };
    await paid.b.entries.create!(meta(), REF, asTask, input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "k" });
    expect(posts(paid.sim)[0].body).toMatchObject({ project_id: project.id, task_id: task.id });
    expect(paid.sim.live()[0]).toMatchObject({ project: project.id, task: task.id });

    const free = simulated();
    const fp = free.sim.project("Website");
    const ft = free.sim.task("Fixes", fp);
    const refused = await errorOf(free.b.entries.create!(meta(), REF, { remoteId: String(ft.id), name: "Fixes", path: [{ remoteId: String(fp.id), name: "Website" }] }, input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "k" }));
    expect(refused).toMatchObject({ kind: "forbidden", status: 402 });
  });

  it("a note longer than Toggl takes is cut in the comment, never in the issue; a title can't break the note's reading", async () => {
    const { sim, b } = simulated();
    const long = "x".repeat(5000);
    const made = await b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 600, { comment: long }), { idempotencyKey: "k" });
    const description = sim.live()[0].description;
    expect(description).toHaveLength(MAX_DESCRIPTION);
    expect(description.startsWith("[ACME-12] Login fails on Safari — x")).toBe(true);
    expect(made.issue).toEqual({ key: "ACME-12" });
    expect(made.comment).toHaveLength(MAX_DESCRIPTION - "[ACME-12] Login fails on Safari — ".length);

    const tricky: ExternalRef = { ...REF, issue: { remoteId: "1", key: "ACME-13" }, snapshot: { url: "", title: "Cache — and [brackets] — again" } };
    const again = await b.entries.create!(meta(), tricky, null, input("2026-10-14T09:00:00Z", 600, { comment: "a — b" }), { idempotencyKey: "k2" });
    expect(again).toMatchObject({ issue: { key: "ACME-13" }, comment: "a — b" });
    // A title is cut by itself when it is the whole of the room.
    expect(noteOf(noteHead({ ...REF, snapshot: { url: "", title: "t".repeat(4000) } }), "c")).toHaveLength(MAX_DESCRIPTION);
    expect(noteOf("", "only a comment")).toBe("only a comment");
  });

  it("a note not made by inkledger reads back as a comment with no issue", () => {
    expect(readNote("stand-up")).toEqual({ head: "", issue: null, comment: "stand-up" });
    expect(readNote(null)).toEqual({ head: "", issue: null, comment: "" });
    expect(readNote("[ACME-1] Title")).toEqual({ head: "[ACME-1] Title", issue: { key: "ACME-1" }, comment: "" });
  });

  it("Toggl has no idempotency key: the same key twice makes two entries (so nothing is retried unprotected)", async () => {
    const { sim, b } = simulated();
    const a = await b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "same" });
    const c = await b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "same" });
    expect(a.remoteId).not.toBe(c.remoteId);
    expect(sim.live()).toHaveLength(2);
    expect(togglSink.capabilities.entries).toMatchObject({ idempotency: "local" });
  });

  it("input that isn't a session of whole positive seconds never reaches Toggl", async () => {
    const { sim, b } = simulated();
    expect((await errorOf(b.entries.create!(meta(), REF, null, { time: { kind: "date", date: localDate("2026-10-14"), seconds: 600 }, comment: "" }, { idempotencyKey: "k" })))?.kind).toBe("invalid");
    expect((await errorOf(b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 0), { idempotencyKey: "k" })))?.kind).toBe("invalid");
    expect(sim.log).toHaveLength(0);
  });

  it("a running timer: a span is never written as one (duration is positive), another timer keeps running, and it is not an entry to read or change", async () => {
    const { sim, b } = simulated();
    sim.plan("premium");
    const timer = sim.outside.timer("2026-10-14T07:00:00Z", "Doing something");
    expect(timer.duration).toBeLessThan(0);
    const made = await b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "k" });
    expect((posts(sim)[0].body as { duration: number }).duration).toBe(600);
    expect(timer.stop).toBeNull();
    expect((await b.entries.list(meta(), day("2026-10-14"))).map((w) => w.remoteId)).toEqual([made.remoteId]);
    const feed = await readPass((q) => b.entries.changed!(meta(), q), null);
    expect(feed.items.map((w) => w.remoteId)).toEqual([made.remoteId]);
    expect(await errorOf(b.entries.update!(meta(), String(timer.id), input("2026-10-14T07:00:00Z", 900), {}))).toMatchObject({ kind: "conflict", message: expect.stringContaining("running timer") });
    expect(timer.stop).toBeNull();
  });

  it("changes only what changes: the project, the task and the head of the note stay, start, stop and duration move together, in two calls", async () => {
    const { sim, b } = simulated();
    sim.plan("premium");
    const project = sim.project("Website");
    const made = await b.entries.create!(meta(), REF, target(project.id), input("2026-10-14T08:30:00Z", 5400, { comment: "first" }), { idempotencyKey: "k" });
    sim.log.length = 0;
    const changed = await b.entries.update!(meta(), made.remoteId, input("2026-10-14T09:00:00Z", 1800, { comment: "second" }), {});
    expect(sim.log.map((l) => `${l.method} ${l.path}`)).toEqual([`GET /me/time_entries/${made.remoteId}`, `PATCH /workspaces/9001/time_entries/${made.remoteId}`]);
    const [e] = sim.live();
    expect(e).toMatchObject({ project: project.id, duration: 1800, start: Date.parse("2026-10-14T09:00:00Z"), stop: Date.parse("2026-10-14T09:30:00Z"), description: "[ACME-12] Login fails on Safari — second" });
    expect(changed).toMatchObject({ remoteId: made.remoteId, issue: { key: "ACME-12" }, comment: "second", span: { seconds: 1800, start: Date.parse("2026-10-14T09:00:00Z") } });
    const back = await b.entries.list(meta(), day("2026-10-14"));
    expect(back[0].span).toMatchObject({ seconds: 1800 });
  });

  it("a change to billable is a patch of billable only where the input says so", async () => {
    const { sim, b } = simulated();
    sim.plan("premium");
    const made = await b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "k" });
    await b.entries.update!(meta(), made.remoteId, input("2026-10-14T08:30:00Z", 600, { billable: true }), {});
    expect(sim.live()[0].billable).toBe(true);
    const patch = sim.log.filter((l) => l.method === "PATCH");
    expect((patch[0].body as { path: string }[]).map((op) => op.path)).toEqual(["/start", "/stop", "/duration", "/description", "/billable"]);
  });

  it("an entry that isn't there, or is in another workspace, can't be changed: not found; deleting it is a success", async () => {
    const { sim, b } = simulated();
    expect((await errorOf(b.entries.update!(meta(), "999", input("2026-10-14T08:30:00Z", 600), {})))?.kind).toBe("notFound");
    const other = sim.entry({ start: "2026-10-14T08:30:00Z", seconds: 600, workspace: 9002 });
    expect((await errorOf(b.entries.update!(meta(), String(other.id), input("2026-10-14T08:30:00Z", 600), {})))?.kind).toBe("notFound");
    await b.entries.delete!(meta(), "999", {});
    await b.entries.delete!(meta(), String(other.id), {});
    expect(other.deletedAt).toBeNull();
  });

  it("deleting twice is fine, and a deleted entry is not listed", async () => {
    const { sim, b } = simulated();
    const made = await b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "k" });
    await b.entries.delete!(meta(), made.remoteId, {});
    await b.entries.delete!(meta(), made.remoteId, {});
    expect(sim.live()).toHaveLength(0);
    expect(await b.entries.list(meta(), day("2026-10-14"))).toEqual([]);
  });

  it("a locked period: create, change and delete are refused as a conflict with the reason (Toggl says it as a 403, or inside a bulk answer)", async () => {
    const { sim, b } = simulated();
    const made = await b.entries.create!(meta(), REF, null, input("2026-09-10T08:30:00Z", 600), { idempotencyKey: "k" });
    sim.outside.lock("2026-10-01");
    const create = await errorOf(b.entries.create!(meta(), REF, null, input("2026-09-12T08:30:00Z", 600), { idempotencyKey: "k2" }));
    expect(create).toMatchObject({ kind: "conflict", message: expect.stringContaining("locked") });
    expect(await errorOf(b.entries.update!(meta(), made.remoteId, input("2026-09-10T08:30:00Z", 900), {}))).toMatchObject({ kind: "conflict", message: expect.stringContaining("locked") });
    expect((await errorOf(b.entries.delete!(meta(), made.remoteId, {})))?.kind).toBe("conflict");
    expect(sim.live()).toHaveLength(1);
    expect(sim.live()[0].duration).toBe(600);
  });
});

describe("toggl, reading", () => {
  it("a day is the user's day, not UTC: Rome's 14 October runs from 22:00Z on the 13th; a bare date in start_date is UTC and would miss it", async () => {
    const { sim, b } = simulated();
    const late = sim.entry({ start: "2026-10-13T22:30:00Z", seconds: 600, description: "[ACME-12] Login fails on Safari" });
    const evening = sim.entry({ start: "2026-10-14T21:30:00Z", seconds: 600 });
    const nextDay = sim.entry({ start: "2026-10-14T22:30:00Z", seconds: 600 });
    const before = sim.entry({ start: "2026-10-13T21:59:00Z", seconds: 600 });
    const ids = (await b.entries.list(meta(), day("2026-10-14"))).map((w) => w.remoteId);
    expect(ids).toEqual([String(late.id), String(evening.id)]);
    expect(ids).not.toContain(String(nextDay.id));
    expect(ids).not.toContain(String(before.id));
    // What a naive date range would have asked.
    const naive = await sim.fetch(`${sim.apiBase}/me/time_entries?start_date=2026-10-14&end_date=2026-10-15`, { headers: { Authorization: `Basic ${Buffer.from(`${sim.token}:api_token`).toString("base64")}` } });
    const rows = (await naive.json()) as { id: number }[];
    expect(rows.map((r) => r.id)).not.toContain(late.id);
    // The adapter asks in instants.
    expect(gets(sim)[0].query.get("start_date")).toBe("2026-10-13T21:59:59Z");
    expect(gets(sim)[0].query.get("end_date")).toBe("2026-10-14T22:00:01Z");
  });

  it("the day a clock change makes 25 hours long is read whole", async () => {
    const { sim, b } = simulated();
    const lastHour = sim.entry({ start: "2026-10-25T22:30:00Z", seconds: 600 });
    const next = sim.entry({ start: "2026-10-25T23:30:00Z", seconds: 600 });
    expect((await b.entries.list(meta(), day("2026-10-25"))).map((w) => w.remoteId)).toEqual([String(lastHour.id)]);
    expect((await b.entries.list(meta(), day("2026-10-26"))).map((w) => w.remoteId)).toEqual([String(next.id)]);
    expect(new Date(dayStart("2026-10-26", timeZone("Europe/Rome"))).toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(new Date(dayStart("2026-07-01", timeZone("Asia/Kolkata"))).toISOString()).toBe("2026-06-30T18:30:00.000Z");
    expect(new Date(dayStart("2026-07-01", timeZone("America/New_York"))).toISOString()).toBe("2026-07-01T04:00:00.000Z");
  });

  it("another zone is another day", async () => {
    const { sim, b } = simulated({ zone: "America/New_York" });
    const e = sim.entry({ start: "2026-10-14T02:00:00Z", seconds: 600 });
    expect(await b.entries.list(meta(), day("2026-10-14"))).toEqual([]);
    expect((await b.entries.list(meta(), day("2026-10-13"))).map((w) => w.remoteId)).toEqual([String(e.id)]);
  });

  it("/me/time_entries spans every workspace: only the connection's is read; entries of other people are not the user's", async () => {
    const { sim, b } = simulated();
    const mine = sim.entry({ start: "2026-10-14T08:30:00Z", seconds: 600 });
    sim.entry({ start: "2026-10-14T08:30:00Z", seconds: 600, workspace: 9002 });
    sim.entry({ start: "2026-10-14T08:30:00Z", seconds: 600, user: 4999 });
    expect((await b.entries.list(meta(), day("2026-10-14"))).map((w) => w.remoteId)).toEqual([String(mine.id)]);
  });

  it("an entry made by hand is read with no issue and its note as the comment", async () => {
    const { sim, b } = simulated();
    sim.entry({ start: "2026-10-14T08:30:00Z", seconds: 600, description: "stand-up", billable: false });
    expect(await b.entries.list(meta(), day("2026-10-14"))).toMatchObject([{ issue: null, comment: "stand-up", billable: false }]);
  });

  it("an answer cut at the cap (1000, with no sign of more) is read again in halves until nothing is lost", async () => {
    const { sim, b } = simulated();
    sim.plan("premium");
    for (let n = 0; n < 1100; n++) sim.entry({ start: new Date(Date.parse("2026-10-14T00:00:00Z") + n * 60_000).toISOString(), seconds: 30 });
    const all = await b.entries.list(meta(), day("2026-10-14"));
    expect(all).toHaveLength(1100);
    expect(new Set(all.map((w) => w.remoteId)).size).toBe(1100);
    expect(gets(sim).length).toBeGreaterThan(1);
  });

  it("a range longer than the API takes (three months) is read in pieces", async () => {
    const { sim, b } = simulated();
    sim.plan("premium");
    const feb = sim.entry({ start: "2026-02-10T09:00:00Z", seconds: 600 });
    const jun = sim.entry({ start: "2026-06-20T09:00:00Z", seconds: 600 });
    const all = await b.entries.list(meta(), day("2026-01-01", "2026-06-30"));
    expect(all.map((w) => w.remoteId)).toEqual([String(feb.id), String(jun.id)]);
    expect(gets(sim)).toHaveLength(3);
  });

  it("the feed asks for changes since a Unix timestamp in seconds (milliseconds are refused), within the window", async () => {
    const { sim, b } = simulated();
    const first = sim.entry({ start: "2026-10-14T08:30:00Z", seconds: 600 });
    const all = await readPass((q) => b.entries.changed!(meta(), q), null);
    expect(all.items.map((w) => w.remoteId)).toEqual([String(first.id)]);
    expect(all.checkpoint).not.toBeNull();
    const since = Number(gets(sim)[0].query.get("since"));
    expect(since).toBeLessThan(1e11);
    expect(Math.abs(since * 1000 - (Date.now() - 7 * 86_400_000))).toBeLessThan(60_000);
    // The simulator holds Toggl's rule.
    const ms = await sim.fetch(`${sim.apiBase}/me/time_entries?since=${Date.now()}`, { headers: { Authorization: `Basic ${Buffer.from(`${sim.token}:api_token`).toString("base64")}` } });
    expect(ms.status).toBe(400);
  });

  it("the feed lists what changed, an edit on the service included; entries deleted since come marked by Toggl and are left out (a window reports no removals)", async () => {
    const { sim, b } = simulated();
    const kept = sim.entry({ start: "2026-10-14T08:30:00Z", seconds: 600, description: "[ACME-12] Login fails on Safari" });
    const gone = sim.entry({ start: "2026-10-14T09:30:00Z", seconds: 600 });
    expect((await readPass((q) => b.entries.changed!(meta(), q), null)).items).toHaveLength(2);
    sim.outside.remove(gone);
    sim.outside.edit(kept, { seconds: 900, description: "[ACME-12] Login fails on Safari — edited" });
    expect(gets(sim)).toHaveLength(1);
    const again = await readPass((q) => b.entries.changed!(meta(), q), null);
    expect(again.items).toMatchObject([{ remoteId: String(kept.id), comment: "edited", span: { seconds: 900 } }]);
    expect(again.gone).toEqual([]);
    // Toggl does send the deleted one, marked.
    const raw = await sim.fetch(`${sim.apiBase}/me/time_entries?since=${Math.floor(Date.now() / 1000) - 3600}`, { headers: { Authorization: `Basic ${Buffer.from(`${sim.token}:api_token`).toString("base64")}` } });
    expect(((await raw.json()) as { id: number; server_deleted_at: string | null }[]).find((e) => e.id === gone.id)?.server_deleted_at).toMatch(/^\d{4}-/);
  });

  it("a later feed pass reads from its checkpoint, so only newer changes (after the overlap) arrive", async () => {
    const { sim, b } = simulated();
    const old = sim.entry({ start: "2026-10-14T08:30:00Z", seconds: 600 });
    // The entry changed long before the checkpoint's overlap.
    old.at = Date.now() - 3_600_000;
    const first = await readPass((q) => b.entries.changed!(meta(), q), null);
    expect(first.items.map((w) => w.remoteId)).toContain(String(old.id));
    const quiet = await readPass((q) => b.entries.changed!(meta(), q), first.checkpoint);
    expect(quiet.items).toEqual([]);
    const edited = sim.entry({ start: "2026-10-14T10:30:00Z", seconds: 600 });
    sim.outside.edit(edited, { seconds: 900 });
    const next = await readPass((q) => b.entries.changed!(meta(), q), first.checkpoint);
    expect(next.items.map((w) => [w.remoteId, w.span.seconds])).toEqual([[String(edited.id), 900]]);
    sim.outside.remove(edited);
    const after = await readPass((q) => b.entries.changed!(meta(), q), first.checkpoint);
    expect(after.items).toEqual([]);
    expect(after.gone).toEqual([]);
  });

  it("a checkpoint older than the window is held to it (Toggl refuses a 'since' older than three months)", async () => {
    const { sim, b } = simulated();
    sim.entry({ start: "2026-10-14T08:30:00Z", seconds: 600 });
    const first = await readPass((q) => b.entries.changed!(meta(), q), null);
    const stale = first.checkpoint;
    // A checkpoint written a year ago is read as the window's start.
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 400 * 86_400_000);
    try {
      expect(await errorOf(readPass((q) => b.entries.changed!(meta(), q), stale))).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
    expect(Number(gets(sim).at(-1)?.query.get("since")) * 1000).toBeGreaterThan(realNow() + 392 * 86_400_000);
  });

  it("a checkpoint of another connection is refused", async () => {
    const { b, sim, conn } = simulated();
    sim.entry({ start: "2026-10-14T08:30:00Z", seconds: 600 });
    const mine = (await readPass((q) => b.entries.changed!(meta(), q), null)).checkpoint;
    const other = bindSink(togglSink, { ...conn, id: 8 });
    expect((await errorOf(other.entries.changed!(meta(), { since: mine, page: null })))?.kind).toBe("invalidCheckpoint");
  });
});

describe("toggl, limits", () => {
  it("over the hourly quota Toggl answers 402: a wait until the quota resets, not a refusal; the calls before it went through", async () => {
    const { sim, b } = simulated();
    sim.quota.limit = 3;
    await b.verify(meta());
    await b.verify(meta());
    await b.verify(meta());
    const over = await errorOf(b.verify(meta()));
    expect(over).toMatchObject({ kind: "rateLimit", status: 402 });
    expect(over?.rateLimit?.retryAfterMs).toBeGreaterThan(3_500_000);
    expect(over?.rateLimit?.retryAfterMs).toBeLessThanOrEqual(3_600_000);
  });

  it("a burst answers 429 with Retry-After", async () => {
    const { sim, b } = simulated();
    sim.throttle();
    const over = await errorOf(b.verify(meta()));
    expect(over).toMatchObject({ kind: "rateLimit", status: 429 });
    expect(over?.rateLimit?.retryAfterMs).toBe(2000);
  });

  it("the free plan's budget is what the catalogue says, and a sync of one entry makes few calls", async () => {
    const { sim, b } = simulated();
    expect(togglSink.capabilities.typicalRateLimit).toEqual({ perHour: 30 });
    await b.entries.create!(meta(), REF, null, input("2026-10-14T08:30:00Z", 600), { idempotencyKey: "k" });
    expect(sim.quota.used).toBe(1);
  });
});

describe("toggl, registry", () => {
  it("is registered as experimental, and keeps to its catalogue entry", () => {
    expect(sinkStatus("toggl")).toBe("experimental");
    expect(sinkAdapter("toggl")).toBe(togglSink);
    expect(registryProblems()).toEqual([]);
  });
});
