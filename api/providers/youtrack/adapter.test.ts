import { describe, expect, it, vi } from "vitest";
import { localDate, markdown, timeZone } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { encodeCheckpoint } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import type { IssueRef } from "../types";
import { youtrackProvider, verifyYouTrackWebhook } from "./adapter";
import { youtrackSimulator } from "./simulator";
import { assignedQuery, checkQuery, textQuery } from "./translate";
import { WEBHOOK_DELIVERY_HEADER, WEBHOOK_SECRET_HEADER } from "./webhook";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.20", family: 4 }]),
}));

const DAY = 86_400_000;

function simulated(site?: string, baseUrl?: (sim: ReturnType<typeof youtrackSimulator>) => string) {
  const sim = youtrackSimulator(site);
  sim.user({ id: "1-2", login: "abianchi", fullName: "Anna Bianchi" });
  const old = Date.now() - 3 * DAY;
  sim.add("APP", "Login fails on Safari", { description: "Steps:\n\n1. open\n2. **fail**", priority: "Major", type: "Bug", estimateMinutes: 90, due: "2026-11-02", tags: ["web"], updated: old });
  sim.add("APP", "Export to CSV", { updated: old });
  sim.add("OPS", "Someone else's", { assignee: "1-2", updated: old });
  // A project the token may not see: its issues are 404, not 403.
  sim.project("SEC", { hidden: true });
  sim.add("SEC", "Secret", { updated: old });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 7,
    userId: 1,
    type: "youtrack" as const,
    baseUrl: baseUrl ? baseUrl(sim) : sim.apiBase,
    remoteAccountId: sim.me.id,
    options: {},
    timeZone: timeZone("Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: sim.token }),
  };
  return { sim, conn, bound: bindTracker(youtrackProvider, conn) };
}

trackerConformance("youtrack (simulated)", async () => {
  const { sim, conn } = simulated();
  return { provider: youtrackProvider, conn, key: "APP-1", writable: true, url: `${sim.web}/issue/APP-1` };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const kindOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ProviderError ? e.kind : String(e)));
const refOf = (i: { remoteId: string; key: string }): IssueRef => ({ remoteId: i.remoteId, key: i.key });
const first = async (b: ReturnType<typeof simulated>["bound"], key: string) => {
  const r = await b.findIssue(meta(), { key });
  if (r.kind !== "found") throw new Error(`no ${key}`);
  return r.issue;
};

describe("youtrack: sync of assigned issues", () => {
  it("lists issues assigned to the user, keyed PROJ-12, with what the issue says (fields asked for by name)", async () => {
    const { sim, bound: b } = simulated();
    const all = await readPass((q) => b.listChanged(meta(), q), null);
    // Not the other user's, not the project the token can't see.
    expect(all.items.map((i) => i.key).sort()).toEqual(["APP-1", "APP-2"]);
    const issue = all.items.find((i) => i.key === "APP-1")!;
    expect(issue).toMatchObject({
      title: "Login fails on Safari",
      url: `${sim.web}/issue/APP-1`,
      container: { key: "APP", name: "Project APP", kind: "project" },
      type: { name: "Bug" },
      priority: { name: "Major" },
      labels: ["web"],
      due: "2026-11-02",
      estimateSeconds: 5400,
      status: { name: "Open", category: "todo", categoryOrigin: { by: "native" } },
    });
    expect(issue.assignees.map((a) => a.handle)).toEqual(["mrossi"]);
    // Without `fields` YouTrack answers ids only (the simulator does too): everything above came from the fields the client names.
    const bare = (await (await sim.fetch(`${sim.apiBase}/issues/APP-1`, { headers: { Authorization: `Bearer ${sim.token}` } })).json()) as object;
    expect(Object.keys(bare).sort()).toEqual(["$type", "id"]);
    expect(sim.state.calls.filter((c) => c.startsWith("GET /api/issues?")).every((c) => c.includes("fields="))).toBe(true);
  });

  it("makes relative avatar paths absolute on the site", async () => {
    const { sim, bound: b } = simulated();
    const me = await b.verify(meta());
    expect(me).toMatchObject({ remoteId: "1-1", name: "Mario Rossi", login: "mrossi", email: "mario@example.com", avatarUrl: `${sim.web}/hub/api/rest/avatar/mrossi` });
  });

  it("reads only what changed since a checkpoint, and the same page twice is harmless", async () => {
    const { sim, bound: b } = simulated();
    const all = await readPass((q) => b.listChanged(meta(), q), null);
    expect(all.items).toHaveLength(2);
    sim.outside.touch("APP-2");
    const since = await readPass((q) => b.listChanged(meta(), q), all.checkpoint);
    expect(since.items.map((i) => i.key)).toEqual(["APP-2"]);
  });

  it("query dates are days in the user's zone: the window is cut wider, the exact cut is on `updated`", async () => {
    const { sim, conn, bound: b } = simulated();
    // The checkpoint: 03:00 UTC on the 20th. A user at UTC-12 reads "2026-10-20" as 12:00 UTC.
    const t = Date.UTC(2026, 9, 20, 3, 0);
    const cp = encodeCheckpoint(conn, "issues", 1, { at: t });
    sim.state.userOffsetMinutes = -12 * 60;
    // The seeded issues changed "now": put them well before the fixed checkpoint, whatever today is.
    for (const i of sim.issues) i.updated = t - 3 * DAY;
    sim.add("APP", "Changed a minute after", { updated: t + 60_000 });
    sim.add("APP", "Changed two days before", { updated: t - 2 * DAY });
    const got = await readPass((q) => b.listChanged(meta(), q), cp);
    expect(got.items.map((i) => i.title)).toEqual(["Changed a minute after"]);
    expect(assignedQuery(t)).toContain("updated: 2026-10-18 .. *");
    // The other extreme, UTC+14.
    sim.state.userOffsetMinutes = 14 * 60;
    expect((await readPass((q) => b.listChanged(meta(), q), cp)).items.map((i) => i.title)).toEqual(["Changed a minute after"]);
  });

  it("pages by $skip against a server that cuts pages short, and loses nothing when an item changes mid-pass", async () => {
    const { sim, bound: b } = simulated();
    sim.state.maxTop = 6;
    const base = Date.now() - 10 * DAY;
    for (let n = 0; n < 12; n++) sim.add("PAGE", `Item ${n}`, { updated: base + n * 60_000 });
    const keys = sim.issues.filter((i) => i.project.shortName === "PAGE").map((i) => `PAGE-${i.number}`);
    let lists = 0;
    // After the first page, the very first item changes: it moves to the end of the order and shifts the rest by one.
    sim.state.onIssueList = () => {
      if (++lists === 2) sim.outside.touch("PAGE-1");
    };
    const pass = await readPass((q) => b.listChanged(meta(), q), null);
    const got = pass.items.map((i) => i.key).filter((k) => k.startsWith("PAGE-"));
    expect(new Set(got)).toEqual(new Set(keys));
    expect(got.length).toBeLessThanOrEqual(keys.length + 1);
    expect(pass.pages).toBeGreaterThan(2);
  });

  it("leaves out projects the user excluded", async () => {
    const { conn } = simulated();
    const narrow = bindTracker(youtrackProvider, { ...conn, options: { excludeProjects: ["app"] } });
    expect((await readPass((q) => narrow.listChanged(meta(), q), null)).items).toEqual([]);
    expect(() => bindTracker(youtrackProvider, { ...conn, options: { excludeProjects: ["no good"] } })).toThrow(ProviderError);
  });
});

describe("youtrack: keys and links", () => {
  it("reads keys in any case and the links YouTrack gives, cloud or self-hosted, and its internal id", async () => {
    const { sim, bound: b } = simulated();
    expect(b.normalizeKey("app-1")).toBe("APP-1");
    expect(b.normalizeKey("12-1")).toBeNull();
    expect(b.parseRef(`${sim.web}/issue/APP-1/Login-fails-on-Safari`)).toEqual({ key: "APP-1" });
    expect(b.parseRef(`${sim.web}/issue/app-1`)).toEqual({ key: "APP-1" });
    expect(b.parseRef(`${sim.web}/issue/2-41`)).toEqual({ remoteId: "2-41" });
    expect(b.parseRef("https://other.youtrack.cloud/issue/APP-1")).toBeNull();
    expect((await b.findIssue(meta(), { remoteId: "2-41" })).kind).toBe("found");

    const self = simulated("https://yt.corp.example/youtrack");
    expect(self.bound.parseRef("https://yt.corp.example/youtrack/issue/APP-1")).toEqual({ key: "APP-1" });
    expect(self.bound.parseRef("https://yt.corp.example/issue/APP-1")).toBeNull();
    expect((await self.bound.findIssue(meta(), { key: "APP-1" })).kind).toBe("found");
  });

  it("takes the site as base with or without /api", async () => {
    const { bound: b } = simulated(undefined, (s) => s.web);
    expect((await first(b, "APP-1")).title).toBe("Login fails on Safari");
  });

  it("follows an issue that moved: same id, new key, the old key and any case still find it", async () => {
    const { sim, bound: b } = simulated();
    const before = await first(b, "APP-2");
    sim.outside.move("APP-2", "OPS");
    const after = await first(b, "app-2");
    expect(after.remoteId).toBe(before.remoteId);
    expect(after.key).toMatch(/^OPS-\d+$/);
    // A ref with the stale key: the id decides.
    expect((await b.getIssue(meta(), refOf(before)))?.key).toBe(after.key);
    expect((await b.comments!.list(meta(), refOf(before))).length).toBe(0);
  });

  it("an issue the token may not see is not found (YouTrack answers 404), never a permission error", async () => {
    const { bound: b } = simulated();
    expect((await b.findIssue(meta(), { key: "SEC-1" })).kind).toBe("none");
    expect(await b.getIssue(meta(), { remoteId: "x", key: "SEC-1" })).toBeNull();
  });
});

describe("youtrack: workflow", () => {
  it("maps the State to categories from isResolved and the usual names, and moves along the allowed values", async () => {
    const { bound: b } = simulated();
    const issue = await first(b, "APP-1");
    const ways = await b.transitions!.list!(meta(), refOf(issue));
    expect(ways.map((w) => [w.name, w.to.category])).toEqual([
      ["In Progress", "doing"],
      ["Fixed", "done"],
      ["Won't fix", "cancelled"],
    ]);
    expect((await b.transitions!.apply!(meta(), refOf(issue), "state:In Progress", {}))?.status).toMatchObject({ name: "In Progress", category: "doing" });
    expect((await b.transitions!.apply!(meta(), refOf(issue), "state:Fixed", {}))?.status).toMatchObject({ name: "Fixed", category: "done", nativeReason: "Fixed" });
    expect((await b.transitions!.apply!(meta(), refOf(issue), "state:Won't fix", {}))?.status.category).toBe("cancelled");
    expect(await kindOf(b.transitions!.apply!(meta(), refOf(issue), "nonsense", {}))).toBe("invalid");
  });

  it("finds the State field by its type: its name is localized", async () => {
    const { sim, bound: b } = simulated();
    sim.project("IT", { stateFieldName: "Stato", states: [{ name: "Aperto", isResolved: false }, { name: "In corso", isResolved: false }, { name: "Risolto", isResolved: true }] });
    const it = sim.add("IT", "Italiano");
    const issue = await first(b, it.key);
    expect(issue.status).toMatchObject({ name: "Aperto", category: "todo" });
    expect((await b.transitions!.apply!(meta(), refOf(issue), "state:In corso", {}))?.status.category).toBe("doing");
  });

  it("a state machine offers events, which are sent as events", async () => {
    const { sim, bound: b } = simulated();
    sim.project("SM", { machine: true });
    const issue = await first(b, sim.add("SM", "Machine").key);
    const ways = await b.transitions!.list!(meta(), refOf(issue));
    expect(ways.map((w) => w.id)).toEqual(["event:ev-In Progress", "event:ev-Fixed", "event:ev-Won't fix"]);
    expect((await b.transitions!.apply!(meta(), refOf(issue), "event:ev-Fixed", {}))?.status.category).toBe("done");
    // A value sent to a machine is refused by YouTrack.
    expect(await kindOf(b.transitions!.apply!(meta(), refOf(issue), "state:Open", {}))).toBe("invalid");
  });

  it("a workflow that refuses a change is `invalid`, with its message", async () => {
    const { sim, bound: b } = simulated();
    const issue = await first(b, "APP-1");
    // The two reads before the write pass; the refusal is on the POST.
    const real = sim.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") return new Response(JSON.stringify({ error: "Bad Request", error_description: "Workflow: a comment is required to close" }), { status: 400 });
      return real(input, init);
    });
    const err = await b.transitions!.apply!(meta(), refOf(issue), "state:Fixed", {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "invalid", message: expect.stringContaining("comment is required") });
  });

  it("lists every project's states once, in the bundle's order", async () => {
    const { sim, bound: b } = simulated();
    sim.project("IT", { states: [{ name: "Aperto", isResolved: false }, { name: "Fixed", isResolved: true }] });
    const statuses = await b.statuses!(meta(), { kind: "itemState", transitions: "allowedList", ref: { kind: "itemState" }, name: "State" });
    expect(statuses.map((s) => s.name)).toEqual(["Open", "Aperto", "In Progress", "Fixed", "Won't fix"]);
    expect(statuses.find((s) => s.name === "Won't fix")?.category).toBe("cancelled");
  });
});

describe("youtrack: texts", () => {
  it("reads the description and comments as CommonMark; a deleted comment is still listed by YouTrack and skipped here", async () => {
    const { sim, bound: b } = simulated();
    const issue = await first(b, "APP-1");
    expect(await b.description!(meta(), refOf(issue))).toEqual({ kind: "text", format: "commonmark", text: "Steps:\n\n1. open\n2. **fail**" });
    expect(await b.description!(meta(), refOf(await first(b, "APP-2")))).toBeNull();
    sim.outside.comment("APP-1", "kept");
    sim.outside.comment("APP-1", "gone", { deleted: true });
    expect((await b.comments!.list(meta(), refOf(issue))).map((c) => c.body)).toEqual([{ kind: "text", format: "commonmark", text: "kept" }]);
    const added = await b.comments!.add!(meta(), refOf(issue), markdown("Looks **fixed**"), { idempotencyKey: "c1" });
    expect(added.comment?.body).toEqual({ kind: "text", format: "commonmark", text: "Looks **fixed**" });
    expect(added.warnings).toEqual([]);
  });

  it("reads every comment although the server's page is short (default $top is 42, the cap lower)", async () => {
    const { sim, bound: b } = simulated();
    sim.state.maxTop = 30;
    for (let n = 0; n < 75; n++) sim.outside.comment("APP-1", `c${n}`);
    const comments = await b.comments!.list(meta(), refOf(await first(b, "APP-1")));
    expect(comments.map((c) => c.id)).toHaveLength(75);
    expect(new Set(comments.map((c) => c.id)).size).toBe(75);
  });

  it("history: needs its categories, and reads what the State went through", async () => {
    const { sim, bound: b } = simulated();
    const issue = await first(b, "APP-1");
    await b.transitions!.apply!(meta(), refOf(issue), "state:Fixed", {});
    const h = await b.history!(meta(), refOf(issue));
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ field: { name: "State" }, from: [{ text: "Open" }], to: [{ text: "Fixed" }], actor: { name: "Mario Rossi" } });
    const bare = await sim.fetch(`${sim.apiBase}/issues/APP-1/activities?fields=id`, { headers: { Authorization: `Bearer ${sim.token}` } });
    expect(bare.status).toBe(400);
  });

  it("stars and unstars; doing it twice is a success", async () => {
    const { sim, bound: b } = simulated();
    const issue = await first(b, "APP-1");
    await b.watch!(meta(), refOf(issue), true);
    await b.watch!(meta(), refOf(issue), true);
    expect(sim.byKey("APP-1")?.watchers.has(sim.me.id)).toBe(true);
    await b.watch!(meta(), refOf(issue), false);
    expect(sim.byKey("APP-1")?.watchers.size).toBe(0);
  });
});

describe("youtrack: search and the query language", () => {
  it("searches text, with braces and quotes that would break the query taken out", async () => {
    const { bound: b } = simulated();
    expect((await b.searchText!(meta(), "safari", 10)).items.map((i) => i.key)).toEqual(["APP-1"]);
    expect((await b.searchText!(meta(), '{safari"}', 10)).items.map((i) => i.key)).toEqual(["APP-1"]);
    expect(await b.searchText!(meta(), "  {}  ", 10)).toEqual({ items: [], complete: true });
    // limit + 1 read: complete only when nothing more.
    expect((await b.searchText!(meta(), "e", 1)).complete).toBe(false);
  });

  it("runs the service's own queries and refuses the ones it would refuse", async () => {
    const { bound: b } = simulated();
    expect((await b.query!(meta(), "for: me #Unresolved", 10)).items.map((i) => i.key).sort()).toEqual(["APP-1", "APP-2"]);
    expect((await b.query!(meta(), "project: OPS", 10)).items.map((i) => i.key)).toEqual(["OPS-1"]);
    expect(await kindOf(b.query!(meta(), "{unbalanced", 10))).toBe("invalid");
    expect(() => checkQuery("   ")).toThrow(ProviderError);
    expect(textQuery("a  {b}\n\"c\"")).toBe("{a b c}");
    expect(assignedQuery(null)).toBe("for: me sort by: updated asc");
  });
});

describe("youtrack: work items", () => {
  const input = (date: string, seconds: number) => ({ time: { kind: "date" as const, date: localDate(date), seconds }, comment: "work" });

  it("keeps the day as given (stored at 00:00 UTC, no shift in the user's zone) and time in whole minutes", async () => {
    const { sim, bound: b } = simulated();
    const ref = refOf(await first(b, "APP-1"));
    const made = await b.worklogs!.create!(meta(), ref, input("2026-10-14", 5400), { idempotencyKey: "k" });
    expect(made.span).toEqual({ kind: "date", date: "2026-10-14", seconds: 5400 });
    expect(sim.workItems[0].date).toBe(Date.UTC(2026, 9, 14));
    // Sub-minute time rounds to the nearest minute, at least one.
    expect((await b.worklogs!.create!(meta(), ref, input("2026-10-14", 20), { idempotencyKey: "k2" })).span.seconds).toBe(60);
    expect((await b.worklogs!.create!(meta(), ref, input("2026-10-14", 90), { idempotencyKey: "k3" })).span.seconds).toBe(120);
    // A session is not what this service keeps.
    expect(await kindOf(b.worklogs!.create!(meta(), ref, { time: { kind: "session", start: 1 as never, seconds: 60 }, comment: "" }, { idempotencyKey: "k4" }))).toBe("invalid");
  });

  it("work types are the activities of the issue's project; a time for someone else needs the right to", async () => {
    const { sim, bound: b } = simulated();
    const ref = refOf(await first(b, "APP-1"));
    const types = await b.worklogs!.activities!(meta(), { issue: ref }, 10);
    expect(types).toEqual({ items: [{ id: "wt-dev", name: "Development" }, { id: "wt-test", name: "Testing" }], complete: true });
    expect((await b.worklogs!.activities!(meta(), {}, 1)).complete).toBe(false);
    const made = await b.worklogs!.create!(meta(), ref, { ...input("2026-10-14", 3600), activityId: "wt-test" }, { idempotencyKey: "a" });
    expect(made.activity).toEqual({ id: "wt-test", name: "Testing" });
    const forAnna = await b.worklogs!.create!(meta(), ref, { ...input("2026-10-14", 3600), onBehalfOfRemoteId: "1-2" }, { idempotencyKey: "b" });
    expect(forAnna.authorRemoteId).toBe("1-2");
    expect(forAnna.editable).toEqual({ update: false, delete: false });
    sim.state.allowOnBehalf = false;
    expect(await kindOf(b.worklogs!.create!(meta(), ref, { ...input("2026-10-14", 3600), onBehalfOfRemoteId: "1-2" }, { idempotencyKey: "c" }))).toBe("forbidden");
    expect(await kindOf(b.worklogs!.create!(meta(), ref, { ...input("2026-10-14", 60), activityId: "nope" }, { idempotencyKey: "d" }))).toBe("invalid");
  });

  it("updates, and deleting twice is a success", async () => {
    const { b } = (() => {
      const s = simulated();
      return { b: s.bound };
    })();
    const ref = refOf(await first(b, "APP-1"));
    const made = await b.worklogs!.create!(meta(), ref, input("2026-10-14", 3600), { idempotencyKey: "k" });
    const changed = await b.worklogs!.update!(meta(), ref, made.remoteId, input("2026-10-15", 1800), {});
    expect(changed.span).toEqual({ kind: "date", date: "2026-10-15", seconds: 1800 });
    expect(await kindOf(b.worklogs!.update!(meta(), ref, "5-999", input("2026-10-15", 60), {}))).toBe("notFound");
    await b.worklogs!.delete!(meta(), ref, made.remoteId, {});
    await b.worklogs!.delete!(meta(), ref, made.remoteId, {});
    expect(await b.worklogs!.list(meta(), ref)).toEqual([]);
  });

  it("the feed has the user's work items changed since the checkpoint, not other people's, and no removals", async () => {
    const { sim, bound: b } = simulated();
    const ref = refOf(await first(b, "APP-1"));
    const before = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    expect(before.items).toEqual([]);
    const mine = sim.outside.workItem("APP-1", { date: "2026-10-12", minutes: 30 });
    sim.outside.workItem("APP-1", { date: "2026-10-12", minutes: 45, author: "1-2" });
    const feed = await readPass((q) => b.worklogs!.changed!(meta(), q), before.checkpoint);
    expect(feed.items.map((w) => [w.remoteId, w.span.seconds])).toEqual([[mine.id, 1800]]);
    // An edit outside shows again; a deletion outside does not (reconciliation finds it).
    sim.outside.editWorkItem(mine.id, 60);
    const edited = await readPass((q) => b.worklogs!.changed!(meta(), q), feed.checkpoint);
    expect(edited.items.map((w) => w.span.seconds)).toEqual([3600]);
    sim.outside.removeWorkItem(mine.id);
    const removed = await readPass((q) => b.worklogs!.changed!(meta(), q), edited.checkpoint);
    expect(removed.items).toEqual([]);
    expect(removed.gone).toEqual([]);
    expect(await b.worklogs!.list(meta(), ref)).toEqual([expect.objectContaining({ authorRemoteId: "1-2" })]);
  });
});

describe("youtrack: errors", () => {
  it("a wrong token is auth; a guest answer in its place too", async () => {
    const { sim, conn } = simulated();
    const bad = bindTracker(youtrackProvider, { ...conn, credential: async () => ({ kind: "token" as const, token: "perm:wrong" }) });
    expect(await kindOf(bad.verify(meta()))).toBe("auth");
    sim.state.guest = true;
    const err = await bad.verify(meta()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "auth", message: expect.stringContaining("guest") });
  });

  it("a spent quota is a wait: Retry-After in seconds, or a date", async () => {
    const { sim, bound: b } = simulated();
    sim.failNext(429, { "Retry-After": "7" });
    const err = await b.verify(meta()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 7000 } });
    sim.failNext(429, { "Retry-After": new Date(Date.now() + 120_000).toUTCString() });
    const dated = await b.verify(meta()).catch((e: unknown) => e);
    expect((dated as ProviderError).rateLimit?.retryAfterMs).toBeGreaterThan(100_000);
    sim.failNext(429);
    expect(((await b.verify(meta()).catch((e: unknown) => e)) as ProviderError).rateLimit?.retryAfterMs).toBe(30_000);
  });

  it("not found, forbidden and server errors in the layer's words", async () => {
    const { sim, bound: b } = simulated();
    expect(await kindOf(b.comments!.list(meta(), { remoteId: "9-9", key: "NOPE-1" }))).toBe("notFound");
    expect(await b.getIssue(meta(), { remoteId: "9-9", key: "NOPE-1" })).toBeNull();
    sim.failNext(403);
    expect(await kindOf(b.verify(meta()))).toBe("forbidden");
    sim.failNext(503);
    expect(await kindOf(b.verify(meta()))).toBe("unavailable");
  });

  it("the probe narrows the provider and names its State source", async () => {
    const { bound: b } = simulated();
    const probe = await b.probe(meta());
    expect(probe.activeSources).toMatchObject([{ kind: "itemState", transitions: "allowedList" }]);
  });
});

describe("youtrack: webhooks", () => {
  const secret = "s3cret";
  const body = JSON.stringify({ event: "issueChanged", issue: "APP-1", timestamp: 1_790_000_000_000 });

  it("accepts the shared secret, with the delivery id and the time it was sent", () => {
    const ok = verifyYouTrackWebhook({ [WEBHOOK_SECRET_HEADER]: secret, [WEBHOOK_DELIVERY_HEADER]: "d-1" }, body, secret);
    expect(ok).toEqual({ ok: true, deliveryId: "d-1", sentAt: 1_790_000_000_000 });
    // Header names in any case; with no delivery header the id is a hash of the body, the same on a replay.
    const a = verifyYouTrackWebhook(new Headers({ "X-Inkledger-Secret": secret }), body, secret);
    const b = verifyYouTrackWebhook({ "X-INKLEDGER-SECRET": secret }, body, secret);
    expect(a.ok && b.ok && a.deliveryId === b.deliveryId).toBe(true);
    expect(verifyYouTrackWebhook({ [WEBHOOK_SECRET_HEADER]: secret }, "not json", secret)).toMatchObject({ ok: true });
  });

  it("refuses a missing or wrong secret", () => {
    expect(verifyYouTrackWebhook({}, body, secret)).toEqual({ ok: false, reason: "noSecret" });
    expect(verifyYouTrackWebhook({ [WEBHOOK_SECRET_HEADER]: "nope" }, body, secret)).toEqual({ ok: false, reason: "wrongSecret" });
    expect(verifyYouTrackWebhook({ [WEBHOOK_SECRET_HEADER]: "" }, body, secret)).toEqual({ ok: false, reason: "noSecret" });
    expect(verifyYouTrackWebhook({ [WEBHOOK_SECRET_HEADER]: secret }, body, "")).toEqual({ ok: false, reason: "noSecret" });
  });
});
