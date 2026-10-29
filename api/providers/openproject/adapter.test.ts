import { describe, expect, it, vi } from "vitest";
import { localDate, markdown, timeZone } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { encodeCheckpoint } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import type { IssueRef } from "../types";
import { isoDuration } from "../core/time";
import { categoryOf, openprojectProvider, secondsOf, verifyOpenProjectWebhook, openProjectEvent } from "./adapter";
import { apiRootOf, networkOf, webBaseOf } from "./client";
import { openprojectSimulator } from "./simulator";
import { openProjectDeliveryId, openProjectSentAt, signWebhook } from "./webhook";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.20", family: 4 }]),
}));

const DAY = 86_400_000;

function simulated(site?: string, baseUrl?: (sim: ReturnType<typeof openprojectSimulator>) => string) {
  const sim = openprojectSimulator(site);
  sim.user({ id: 6, name: "Anna Bianchi", login: "abianchi" });
  const old = Date.now() - 3 * DAY;
  sim.add("web", "Login fails on Safari", { description: "Steps:\n\n1. open\n2. **fail**", priority: "High", type: "Bug", estimateSeconds: 5400, due: "2026-11-02", updated: old });
  sim.add("web", "Export to CSV", { updated: old });
  sim.add("ops", "Someone else's", { assignee: 6, updated: old });
  // A project the token may not see: its work packages are 404, not 403.
  sim.project("sec", { hidden: true });
  sim.add("sec", "Secret", { updated: old });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 7,
    userId: 1,
    type: "openproject" as const,
    baseUrl: baseUrl ? baseUrl(sim) : sim.apiBase,
    remoteAccountId: String(sim.me.id),
    options: {},
    timeZone: timeZone("Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: sim.token }),
  };
  return { sim, conn, bound: bindTracker(openprojectProvider, conn) };
}

trackerConformance("openproject (simulated)", async () => {
  const { sim, conn } = simulated();
  return { provider: openprojectProvider, conn, key: "#1", writable: true, url: `${sim.web}/work_packages/1` };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const kindOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ProviderError ? e.kind : String(e)));
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ProviderError);
const refOf = (i: { remoteId: string; key: string }): IssueRef => ({ remoteId: i.remoteId, key: i.key });
type Bound = ReturnType<typeof simulated>["bound"];
const first = async (b: Bound, key: string) => {
  const r = await b.findIssue(meta(), { key });
  if (r.kind !== "found") throw new Error(`no ${key}`);
  return r.issue;
};
const pass = (b: Bound, since: Parameters<Bound["listChanged"]>[1]["since"] = null) => readPass((q) => b.listChanged(meta(), q), since);

describe("openproject: sync of assigned work packages", () => {
  it("lists work packages assigned to the user, keyed #12, with what they say", async () => {
    const { sim, bound: b } = simulated();
    const all = await pass(b);
    // Not the other user's, not the project the token can't see.
    expect(all.items.map((i) => i.key)).toEqual(["#1", "#2"]);
    expect(all.items[0]).toMatchObject({
      remoteId: "1",
      title: "Login fails on Safari",
      url: `${sim.web}/work_packages/1`,
      container: { remoteId: "3", key: "web", name: "Project web", kind: "project" },
      type: { id: "7", name: "Bug", level: "standard" },
      priority: { id: "9", name: "High", rank: null },
      due: "2026-11-02",
      estimateSeconds: 5400,
      spentSeconds: 0,
      labels: [],
      status: { id: "1", name: "New", category: "todo", categoryOrigin: { by: "native" } },
    });
    expect(all.items[0].assignees).toEqual([expect.objectContaining({ remoteId: "5", name: "Mario Rossi", handle: "mrossi" })]);
    expect(all.items[0].reporter?.name).toBe("Mario Rossi");
    expect(all.checkpoint).not.toBeNull();
  });

  it("closed work packages stay in the feed: without filters OpenProject would keep only the open ones", async () => {
    const { sim, bound: b } = simulated();
    sim.outside.setStatus(2, "Closed");
    // The trap, as the server has it: a list asked with no filters is "status: open".
    const bare = (await (await sim.fetch(`${sim.apiBase}/work_packages`, { headers: { Authorization: `Basic ${Buffer.from(`apikey:${sim.token}`).toString("base64")}` } })).json()) as { total: number };
    expect(bare.total).toBe(2);
    const all = await pass(b);
    expect(all.items.find((i) => i.key === "#2")?.status).toMatchObject({ name: "Closed", category: "done", nativeReason: "Closed" });
    expect(sim.state.calls.filter((c) => c.startsWith("GET /api/v3/work_packages?")).every((c) => c.includes("filters="))).toBe(true);
  });

  it("reads only what changed since a checkpoint, and the same page twice is harmless", async () => {
    const { sim, bound: b } = simulated();
    const all = await pass(b);
    expect(all.items).toHaveLength(2);
    sim.outside.touch(2);
    const since = await pass(b, all.checkpoint);
    expect(since.items.map((i) => i.key)).toEqual(["#2"]);
    expect((await pass(b, all.checkpoint)).items.map((i) => i.key)).toEqual(["#2"]);
  });

  it("dates in a filter are days in the user's zone, so the filter carries an instant: the window is the same in any zone", async () => {
    const { sim, conn, bound: b } = simulated();
    const t = Date.now() - DAY;
    const cp = encodeCheckpoint(conn, "issues", 1, { at: t });
    sim.add("web", "Changed a minute after", { updated: t + 60_000 });
    sim.add("web", "Changed two days before", { updated: t - 2 * DAY });
    for (const offset of [0, -12 * 60, 14 * 60]) {
      sim.state.userOffsetMinutes = offset;
      expect((await pass(b, cp)).items.map((i) => i.title)).toEqual(["Changed a minute after"]);
    }
    // What a bare date would have done: the same day is a different instant in each zone.
    const asked = sim.state.calls.filter((c) => c.includes("updatedAt"));
    expect(asked.every((c) => /updatedAt":\{"operator":"<>d","values":\["\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z",""\]/.test(c))).toBe(true);
    const auth = { Authorization: `Basic ${Buffer.from(`apikey:${sim.token}`).toString("base64")}` };
    const onDay = async (offset: number) => {
      sim.state.userOffsetMinutes = offset;
      const filters = encodeURIComponent(JSON.stringify([{ updatedAt: { operator: "<>d", values: [new Date(t).toISOString().slice(0, 10), ""] } }]));
      return ((await (await sim.fetch(`${sim.apiBase}/work_packages?filters=${filters}`, { headers: auth })).json()) as { total: number }).total;
    };
    sim.add("web", "Early that day", { updated: Date.parse(`${new Date(t).toISOString().slice(0, 10)}T06:00:00Z`) });
    expect(await onDay(-12 * 60)).toBeLessThan(await onDay(14 * 60));
  });

  it("pages by page number (offset counts pages from 1) against a server that caps the page size, and loses nothing when one is edited mid-pass", async () => {
    const { sim, bound: b } = simulated();
    sim.state.maxPageSize = 7;
    for (let n = 0; n < 20; n++) sim.add("page", `Item ${n}`);
    const expected = sim.workPackages.filter((w) => w.assigneeId === sim.me.id && !w.project.hidden).map((w) => `#${w.id}`);
    let lists = 0;
    // After the first page, the very first work package is edited: it keeps its place (the order is by id).
    sim.state.onWorkPackageList = () => {
      if (++lists === 2) sim.outside.touch(1);
    };
    const got = await pass(b);
    expect(got.items.map((i) => i.key)).toEqual(expected);
    expect(got.pages).toBe(Math.ceil(expected.length / 7));
    // Asked for pages of 100, answered 7 at a time: the answer's own size is what counts.
    const offsets = sim.state.calls.filter((c) => c.startsWith("GET /api/v3/work_packages?")).map((c) => /offset=(\d+)/.exec(c)![1]);
    expect(offsets).toEqual(["1", "2", "3", "4"]);
  });

  it("leaves out projects the user excluded", async () => {
    const { conn } = simulated();
    const narrow = bindTracker(openprojectProvider, { ...conn, options: { excludeProjects: ["web"] } });
    expect((await pass(narrow)).items).toEqual([]);
    expect(() => bindTracker(openprojectProvider, { ...conn, options: { excludeProjects: ["no good"] } })).toThrow(ProviderError);
    expect(() => bindTracker(openprojectProvider, { ...conn, options: { other: 1 } })).toThrow(ProviderError);
  });

  it("falls back on the links when nothing is embedded: statuses are read once, the project is its id", async () => {
    const { sim, bound: b } = simulated();
    sim.state.embed = false;
    sim.outside.setStatus(2, "Rejected");
    const all = await pass(b);
    expect(all.items.find((i) => i.key === "#2")).toMatchObject({ status: { name: "Rejected", category: "cancelled" }, container: { remoteId: "3", key: "3", name: "Project web" }, type: { name: "Task" } });
    expect(all.items[0].assignees[0]).toMatchObject({ remoteId: "5", name: "Mario Rossi" });
    expect(sim.state.calls.filter((c) => c === "GET /api/v3/statuses?pageSize=100&offset=1")).toHaveLength(1);
  });

  it("an unassigned work package has assignee { href: null }, and a child is a sub-item of its parent", async () => {
    const { sim, bound: b } = simulated();
    const parent = sim.add("web", "Epic", { type: "Epic", assignee: null });
    const child = sim.add("web", "Child", { parent: parent.id });
    expect((await first(b, parent.key)).assignees).toEqual([]);
    expect(await first(b, parent.key)).toMatchObject({ type: { name: "Epic", level: "epic" }, parent: null });
    expect(await first(b, child.key)).toMatchObject({ type: { level: "sub" }, parent: { remoteId: String(parent.id), key: parent.key } });
  });

  it("spent time is absent where the time module is off", async () => {
    const { sim, bound: b } = simulated();
    sim.project("notime", { timeTracking: false });
    const w = sim.add("notime", "No time module");
    expect((await first(b, w.key)).spentSeconds).toBeNull();
    sim.outside.timeEntry(1, { date: "2026-10-12", seconds: 3600 });
    expect((await first(b, "#1")).spentSeconds).toBe(3600);
  });
});

describe("openproject: keys and links", () => {
  it("reads #12 and WP#12, and the links OpenProject gives, with or without a context path", async () => {
    const { sim, bound: b } = simulated();
    expect(b.normalizeKey("#12")).toBe("#12");
    expect(b.normalizeKey(" wp#12 ")).toBe("#12");
    expect(["12", "#", "#0", "#012", "#1234567890", "ENG-1", "#1x"].map(b.normalizeKey)).toEqual([null, null, null, null, null, null, null]);
    expect(b.parseRef("#12")).toEqual({ key: "#12" });
    for (const path of ["/work_packages/12", "/work_packages/12/activity", "/projects/web/work_packages/12/overview", "/work_packages/details/12/overview", "/projects/web/work_packages/details/12/activity", "/wp/12", "/notifications/details/12/activity", "/api/v3/work_packages/12"]) {
      expect(b.parseRef(`${sim.web}${path}`), path).toEqual({ key: "#12" });
    }
    expect(b.parseRef(`${sim.web}/projects/web`)).toBeNull();
    expect(b.parseRef(`${sim.web}/work_packages`)).toBeNull();
    expect(b.parseRef("https://other.example.com/work_packages/12")).toBeNull();
    const self = simulated("https://corp.example/openproject");
    expect(self.bound.parseRef("https://corp.example/openproject/work_packages/1")).toEqual({ key: "#1" });
    expect(self.bound.parseRef("https://corp.example/work_packages/1")).toBeNull();
    expect((await self.bound.findIssue(meta(), { key: "#1" })).kind).toBe("found");
  });

  it("takes the site as base with or without /api/v3", async () => {
    const { bound: b } = simulated(undefined, (s) => s.web);
    expect((await first(b, "#1")).title).toBe("Login fails on Safari");
    expect(apiRootOf("https://x.example/")).toBe("https://x.example/api/v3");
    expect(apiRootOf("https://x.example/api/v3/")).toBe("https://x.example/api/v3");
    expect(webBaseOf("https://x.example/op/api/v3")).toBe("https://x.example/op");
  });

  it("a moved work package keeps its id and its key; only its project changes", async () => {
    const { sim, bound: b } = simulated();
    const before = await first(b, "#2");
    sim.outside.move(2, "ops");
    const after = await first(b, "#2");
    expect(after.remoteId).toBe(before.remoteId);
    expect(after.key).toBe("#2");
    expect(after.container).toMatchObject({ key: "ops" });
    expect((await pass(b)).items.find((i) => i.key === "#2")?.container.key).toBe("ops");
  });

  it("a work package the token may not see, or that was deleted, is a 404: none, never a permission error", async () => {
    const { sim, bound: b } = simulated();
    expect((await b.findIssue(meta(), { key: "#4" })).kind).toBe("none");
    expect(await b.getIssue(meta(), { remoteId: "4", key: "#4" })).toBeNull();
    sim.outside.remove(2);
    expect(await b.getIssue(meta(), { remoteId: "2", key: "#2" })).toBeNull();
    expect((await b.findIssue(meta(), { remoteId: "2" })).kind).toBe("none");
    expect(await b.getIssue(meta(), { remoteId: "x", key: "ENG-1" })).toBeNull();
    expect((await b.findIssue(meta(), { key: "not a key" })).kind).toBe("none");
  });
});

describe("openproject: workflow", () => {
  it("maps the status to categories from isClosed and the usual names, and lists the ways out from the form", async () => {
    const { bound: b } = simulated();
    const issue = await first(b, "#1");
    const ways = await b.transitions!.list!(meta(), refOf(issue));
    // The current status is among the form's allowed values and is left out.
    expect(ways.map((w) => [w.id, w.name, w.to.category])).toEqual([
      ["status:7", "In progress", "doing"],
      ["status:12", "On hold", "todo"],
      ["status:13", "Closed", "done"],
      ["status:14", "Rejected", "cancelled"],
    ]);
    expect(ways[0].remoteUrl).toMatch(/\/work_packages\/1$/);
    expect(ways[2].to.nativeReason).toBe("Closed");
    expect(categoryOf("Fertig", true)).toBe("done");
    expect(categoryOf("Scartato", true)).toBe("cancelled");
    expect(categoryOf("In corso", false)).toBe("doing");
  });

  it("offers only what the workflow of the type and role allows, whether the form embeds the statuses or only links them", async () => {
    const { sim, bound: b } = simulated();
    sim.state.workflow = { 1: [7], 7: [12, 13] };
    const issue = await first(b, "#1");
    for (const allowedAs of ["embedded", "links"] as const) {
      sim.state.allowedAs = allowedAs;
      const ways = await b.transitions!.list!(meta(), refOf(issue));
      // A form that only links its statuses has no isClosed: the instance's statuses give it.
      expect(ways.map((w) => [w.name, w.to.category]), allowedAs).toEqual([["In progress", "doing"]]);
    }
    await b.transitions!.apply!(meta(), refOf(issue), "status:7", {});
    sim.state.allowedAs = "links";
    expect((await b.transitions!.list!(meta(), refOf(issue))).map((w) => [w.name, w.to.category])).toEqual([
      ["On hold", "todo"],
      ["Closed", "done"],
    ]);
  });

  it("moves along an allowed status; the one the workflow forbids is invalid, with the attribute", async () => {
    const { sim, bound: b } = simulated();
    sim.state.workflow = { 1: [7] };
    const issue = await first(b, "#1");
    expect((await b.transitions!.apply!(meta(), refOf(issue), "status:7", {}))?.status).toMatchObject({ name: "In progress", category: "doing" });
    sim.state.workflow = { 7: [13] };
    const err = await errorOf(b.transitions!.apply!(meta(), refOf(issue), "status:1", {}));
    expect(err).toMatchObject({ kind: "invalid", fields: { status: expect.stringContaining("no valid transition") } });
    expect((await b.transitions!.apply!(meta(), refOf(issue), "status:13", {}))?.status).toMatchObject({ name: "Closed", category: "done" });
    expect(await kindOf(b.transitions!.apply!(meta(), refOf(issue), "nonsense", {}))).toBe("invalid");
    expect(await kindOf(b.transitions!.apply!(meta(), { remoteId: "99", key: "#99" }, "status:7", {}))).toBe("notFound");
  });

  it("a change is made at the revision just read: someone changing it meanwhile is a conflict, a missing lockVersion is refused", async () => {
    const { sim, bound: b } = simulated();
    const issue = await first(b, "#1");
    const real = sim.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") sim.outside.touch(1);
      return real(input, init);
    });
    expect(await kindOf(b.transitions!.apply!(meta(), refOf(issue), "status:7", {}))).toBe("conflict");
    vi.stubGlobal("fetch", real);
    const auth = { Authorization: `Basic ${Buffer.from(`apikey:${sim.token}`).toString("base64")}` };
    const bare = await sim.fetch(`${sim.apiBase}/work_packages/1`, { method: "PATCH", headers: auth, body: JSON.stringify({ _links: { status: { href: "/api/v3/statuses/7" } } }) });
    expect(bare.status).toBe(422);
    expect((await b.transitions!.apply!(meta(), refOf(issue), "status:7", {}))?.status.name).toBe("In progress");
  });

  it("lists the instance's statuses in order, once", async () => {
    const { bound: b } = simulated();
    const statuses = await b.statuses!(meta(), { kind: "itemState", transitions: "allowedList", ref: { kind: "itemState" }, name: "Status" });
    expect(statuses.map((s) => [s.name, s.category])).toEqual([
      ["New", "todo"],
      ["In progress", "doing"],
      ["On hold", "todo"],
      ["Closed", "done"],
      ["Rejected", "cancelled"],
    ]);
    expect(statuses.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it("the probe narrows the provider and names its status source", async () => {
    const { bound: b } = simulated();
    expect((await b.probe(meta())).activeSources).toMatchObject([{ kind: "itemState", transitions: "allowedList" }]);
  });
});

describe("openproject: texts", () => {
  it("reads the description as CommonMark (Markdown since 8.0, Textile before) and comments apart from changes and revisions", async () => {
    const { sim, bound: b } = simulated();
    const issue = await first(b, "#1");
    expect(await b.description!(meta(), refOf(issue))).toEqual({ kind: "text", format: "commonmark", text: "Steps:\n\n1. open\n2. **fail**" });
    expect(await b.description!(meta(), refOf(await first(b, "#2")))).toBeNull();
    sim.state.textFormat = "textile";
    expect(await b.description!(meta(), refOf(issue))).toMatchObject({ format: "textile" });
    sim.state.textFormat = "markdown";
    sim.outside.comment(1, "kept", { by: 6 });
    sim.outside.revision(1, "Fix #1 in the login form");
    sim.outside.setStatus(1, "In progress");
    const comments = await b.comments!.list(meta(), refOf(issue));
    expect(comments.map((c) => [c.body, c.author.name])).toEqual([[{ kind: "text", format: "commonmark", text: "kept" }, "Anna Bianchi"]]);
    const added = await b.comments!.add!(meta(), refOf(issue), markdown("Looks **fixed**"), { idempotencyKey: "c1" });
    expect(added.comment?.body).toEqual({ kind: "text", format: "commonmark", text: "Looks **fixed**" });
    expect(added.warnings).toEqual([]);
    expect((await b.comments!.list(meta(), refOf(issue))).map((c) => c.id)).toContain(added.comment!.id);
    expect(await kindOf(b.comments!.list(meta(), { remoteId: "99", key: "#99" }))).toBe("notFound");
    expect(await kindOf(b.comments!.add!(meta(), refOf(issue), markdown("  "), { idempotencyKey: "c2" }))).toBe("invalid");
  });

  it("history: a change is only text, read apart when it is the English sentence and kept whole otherwise", async () => {
    const { sim, bound: b } = simulated();
    const issue = await first(b, "#1");
    await b.transitions!.apply!(meta(), refOf(issue), "status:13", {});
    sim.workPackages[0].activities.push({ id: 900, kind: "comment", comment: "", details: [{ html: "<strong>Assignee</strong> set to <i>Anna &amp; Co</i>" }, { html: "<strong>Due date</strong> deleted (<i>2026-11-02</i>)" }, { html: "Stato modificato da <i>Nuovo</i> <strong>a</strong> <i>Chiuso</i>" }], createdAt: Date.now(), userId: 6 });
    const h = await b.history!(meta(), refOf(issue));
    expect(h).toHaveLength(4);
    expect(h[0]).toMatchObject({ field: { name: "Status" }, from: [{ text: "New" }], to: [{ text: "Closed" }], actor: { name: "Mario Rossi" } });
    expect(h[1]).toMatchObject({ field: { name: "Assignee" }, from: [], to: [{ text: "Anna & Co" }], actor: { name: "Anna Bianchi" } });
    expect(h[2]).toMatchObject({ field: { name: "Due date" }, from: [{ text: "2026-11-02" }], to: [] });
    // The Italian sentence can't be taken apart: it stays whole.
    expect(h[3]).toMatchObject({ field: { name: "Change" }, from: [], to: [{ text: "Stato modificato da Nuovo a Chiuso" }] });
  });

  it("watches and unwatches; doing either twice is a success", async () => {
    const { sim, bound: b } = simulated();
    const issue = await first(b, "#1");
    await b.watch!(meta(), refOf(issue), true);
    await b.watch!(meta(), refOf(issue), true);
    expect(sim.byId(1)?.watchers.has(sim.me.id)).toBe(true);
    await b.watch!(meta(), refOf(issue), false);
    await b.watch!(meta(), refOf(issue), false);
    expect(sim.byId(1)?.watchers.size).toBe(0);
  });

  it("searches by subject or id, with the closed ones, up to a limit", async () => {
    const { sim, bound: b } = simulated();
    sim.outside.setStatus(2, "Closed");
    expect((await b.searchText!(meta(), "safari", 10)).items.map((i) => i.key)).toEqual(["#1"]);
    expect((await b.searchText!(meta(), "csv", 10)).items.map((i) => i.key)).toEqual(["#2"]);
    expect((await b.searchText!(meta(), "3", 10)).items.map((i) => i.key)).toEqual(["#3"]);
    expect(await b.searchText!(meta(), "   ", 10)).toEqual({ items: [], complete: true });
    expect((await b.searchText!(meta(), "e", 1)).complete).toBe(false);
    expect((await b.searchText!(meta(), "secret", 10)).items).toEqual([]);
  });
});

describe("openproject: time entries", () => {
  const input = (date: string, seconds: number) => ({ time: { kind: "date" as const, date: localDate(date), seconds }, comment: "work" });

  it("keeps the day as given and the time as an ISO duration; a session is not what this service keeps", async () => {
    const { sim, bound: b } = simulated();
    const ref = refOf(await first(b, "#1"));
    const made = await b.worklogs!.create!(meta(), ref, input("2026-10-14", 5400), { idempotencyKey: "k" });
    expect(made).toMatchObject({ span: { kind: "date", date: "2026-10-14", seconds: 5400 }, comment: "work", authorRemoteId: "5", issue: { remoteId: "1", key: "#1" }, editable: { update: true, delete: true } });
    expect(sim.timeEntries[0]).toMatchObject({ spentOn: "2026-10-14", seconds: 5400, activityId: 3 });
    expect(sim.state.calls.some((c) => c === "POST /api/v3/time_entries")).toBe(true);
    expect((await b.worklogs!.create!(meta(), ref, input("2026-10-14", 45), { idempotencyKey: "k2" })).span.seconds).toBe(45);
    expect(await kindOf(b.worklogs!.create!(meta(), ref, { time: { kind: "session", start: 1 as never, seconds: 60 }, comment: "" }, { idempotencyKey: "k4" }))).toBe("invalid");
    expect(secondsOf("PT1H30M")).toBe(5400);
    expect(secondsOf("P1DT2H")).toBe(93_600);
    expect(secondsOf("PT0.5H")).toBe(1800);
    expect(secondsOf("PT")).toBeNull();
    expect(secondsOf("90 minutes")).toBeNull();
    expect([isoDuration(5400), isoDuration(3600), isoDuration(45), isoDuration(3725)]).toEqual(["PT1H30M", "PT1H", "PT45S", "PT1H2M5S"]);
    expect((await b.worklogs!.get!(meta(), ref, String(made.remoteId)))?.remoteId).toBe(made.remoteId);
    expect(await b.worklogs!.get!(meta(), ref, "999")).toBeNull();
  });

  it("the revision is the entry's lockVersion; a stale one is a conflict before and at the server", async () => {
    const { sim, bound: b } = simulated();
    const ref = refOf(await first(b, "#1"));
    const made = await b.worklogs!.create!(meta(), ref, input("2026-10-14", 3600), { idempotencyKey: "k" });
    expect(made.version).toBe("0");
    sim.outside.editTimeEntry(Number(made.remoteId), 7200);
    expect(await kindOf(b.worklogs!.update!(meta(), ref, made.remoteId, input("2026-10-14", 60), { expectedVersion: "0" }))).toBe("conflict");
    expect(await kindOf(b.worklogs!.delete!(meta(), ref, made.remoteId, { expectedVersion: "0" }))).toBe("conflict");
    expect(sim.timeEntries).toHaveLength(1);
    const changed = await b.worklogs!.update!(meta(), ref, made.remoteId, input("2026-10-15", 1800), { expectedVersion: "1" });
    expect(changed).toMatchObject({ span: { date: "2026-10-15", seconds: 1800 }, version: "2" });
    // Between the read and the write: the server's own check.
    const real = sim.fetch;
    vi.stubGlobal("fetch", async (i: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") sim.outside.editTimeEntry(Number(made.remoteId), 60);
      return real(i, init);
    });
    expect(await kindOf(b.worklogs!.update!(meta(), ref, made.remoteId, input("2026-10-15", 900), { expectedVersion: "2" }))).toBe("conflict");
  });

  it("without a lockVersion on entries, the revision is the update time, compared before the write", async () => {
    const { sim, bound: b } = simulated();
    sim.state.timeEntryLockVersion = false;
    const ref = refOf(await first(b, "#1"));
    const made = await b.worklogs!.create!(meta(), ref, input("2026-10-14", 3600), { idempotencyKey: "k" });
    expect(made.version).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    sim.outside.editTimeEntry(Number(made.remoteId), 7200);
    expect(await kindOf(b.worklogs!.update!(meta(), ref, made.remoteId, input("2026-10-14", 60), { expectedVersion: made.version! }))).toBe("conflict");
    const fresh = (await b.worklogs!.list(meta(), ref))[0];
    expect((await b.worklogs!.update!(meta(), ref, made.remoteId, input("2026-10-14", 60), { expectedVersion: fresh.version! })).span.seconds).toBe(60);
  });

  it("updates, and deleting twice is a success; an entry of someone else is not editable, and not changeable", async () => {
    const { sim, bound: b } = simulated();
    const ref = refOf(await first(b, "#1"));
    const made = await b.worklogs!.create!(meta(), ref, input("2026-10-14", 3600), { idempotencyKey: "k" });
    expect(await kindOf(b.worklogs!.update!(meta(), ref, "999", input("2026-10-15", 60), {}))).toBe("notFound");
    await b.worklogs!.delete!(meta(), ref, made.remoteId, {});
    await b.worklogs!.delete!(meta(), ref, made.remoteId, {});
    expect(await b.worklogs!.list(meta(), ref)).toEqual([]);
    const theirs = sim.outside.timeEntry(1, { date: "2026-10-12", seconds: 600, userId: 6 });
    const [listed] = await b.worklogs!.list(meta(), ref);
    expect(listed).toMatchObject({ authorRemoteId: "6", editable: { update: false, delete: false } });
    expect(await kindOf(b.worklogs!.update!(meta(), ref, String(theirs.id), input("2026-10-15", 60), {}))).toBe("forbidden");
    expect(await kindOf(b.worklogs!.delete!(meta(), ref, String(theirs.id), {}))).toBe("forbidden");
  });

  it("who logged an entry is fixed; for someone else it is a right of its own, and the user must exist", async () => {
    const { sim, bound: b } = simulated();
    const ref = refOf(await first(b, "#1"));
    const forAnna = await b.worklogs!.create!(meta(), ref, { ...input("2026-10-14", 3600), onBehalfOfRemoteId: "6" }, { idempotencyKey: "b" });
    expect(forAnna).toMatchObject({ authorRemoteId: "6", editable: { update: false, delete: false } });
    const mine = await b.worklogs!.create!(meta(), ref, input("2026-10-14", 3600), { idempotencyKey: "a" });
    expect(await errorOf(b.worklogs!.update!(meta(), ref, mine.remoteId, { ...input("2026-10-14", 60), onBehalfOfRemoteId: "6" }, {}))).toMatchObject({ kind: "invalid", message: expect.stringContaining("can't be changed") });
    expect((await b.worklogs!.update!(meta(), ref, mine.remoteId, { ...input("2026-10-14", 60), onBehalfOfRemoteId: "5" }, {})).authorRemoteId).toBe("5");
    expect(await kindOf(b.worklogs!.create!(meta(), ref, { ...input("2026-10-14", 60), onBehalfOfRemoteId: "77" }, { idempotencyKey: "u" }))).toBe("invalid");
    sim.state.canLogForOthers = false;
    expect(await kindOf(b.worklogs!.create!(meta(), ref, { ...input("2026-10-14", 60), onBehalfOfRemoteId: "6" }, { idempotencyKey: "c" }))).toBe("forbidden");
  });

  it("logging needs the right in the project and the module on; a comment is at most 255 characters", async () => {
    const { sim, bound: b } = simulated();
    const ref = refOf(await first(b, "#1"));
    const long = await errorOf(b.worklogs!.create!(meta(), ref, { ...input("2026-10-14", 60), comment: "x".repeat(256) }, { idempotencyKey: "l" }));
    expect(long).toMatchObject({ kind: "invalid", fields: { comment: expect.stringContaining("too long") } });
    expect((await b.worklogs!.create!(meta(), ref, { ...input("2026-10-14", 60), comment: "x".repeat(255) }, { idempotencyKey: "l2" })).comment).toHaveLength(255);
    sim.projects.get("web")!.logTime = false;
    expect(await kindOf(b.worklogs!.create!(meta(), ref, input("2026-10-14", 60), { idempotencyKey: "p" }))).toBe("forbidden");
    sim.project("notime", { timeTracking: false });
    const w = sim.add("notime", "No module");
    expect(await kindOf(b.worklogs!.create!(meta(), refOf(await first(b, w.key)), input("2026-10-14", 60), { idempotencyKey: "m" }))).toBe("forbidden");
  });

  it("entries of others are listed only where the right to see them is given", async () => {
    const { sim, bound: b } = simulated();
    const ref = refOf(await first(b, "#1"));
    sim.outside.timeEntry(1, { date: "2026-10-12", seconds: 600, userId: 6 });
    sim.outside.timeEntry(1, { date: "2026-10-13", seconds: 900 });
    expect((await b.worklogs!.list(meta(), ref)).map((w) => w.authorRemoteId)).toEqual(["6", "5"]);
    sim.state.viewOthersTime = false;
    expect((await b.worklogs!.list(meta(), ref)).map((w) => w.authorRemoteId)).toEqual(["5"]);
  });

  it("the feed has the user's entries changed since the checkpoint, not other people's, not project time, and no removals", async () => {
    const { sim, bound: b } = simulated();
    const ref = refOf(await first(b, "#1"));
    const before = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    expect(before.items).toEqual([]);
    const mine = sim.outside.timeEntry(1, { date: "2026-10-12", seconds: 1800 });
    sim.outside.timeEntry(1, { date: "2026-10-12", seconds: 2700, userId: 6 });
    sim.outside.projectTime("web", { date: "2026-10-12", seconds: 3600 });
    const feed = await readPass((q) => b.worklogs!.changed!(meta(), q), before.checkpoint);
    expect(feed.items.map((w) => [w.remoteId, w.span.seconds, w.issue?.key])).toEqual([[String(mine.id), 1800, "#1"]]);
    sim.outside.editTimeEntry(mine.id, 3600);
    const edited = await readPass((q) => b.worklogs!.changed!(meta(), q), feed.checkpoint);
    expect(edited.items.map((w) => w.span.seconds)).toEqual([3600]);
    // A deletion outside does not show (declared): reconciliation finds it.
    sim.outside.removeTimeEntry(mine.id);
    const removed = await readPass((q) => b.worklogs!.changed!(meta(), q), edited.checkpoint);
    expect(removed.items).toEqual([]);
    expect(removed.gone).toEqual([]);
    expect((await b.worklogs!.list(meta(), ref)).map((w) => w.authorRemoteId)).toEqual(["6"]);
  });

  it("the feed pages like the work packages, in a stable order", async () => {
    const { sim, bound: b } = simulated();
    sim.state.maxPageSize = 4;
    for (let n = 0; n < 10; n++) sim.outside.timeEntry(1, { date: "2026-10-12", seconds: 60 * (n + 1) });
    const feed = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    expect(feed.items.map((w) => w.span.seconds)).toEqual(Array.from({ length: 10 }, (_, n) => 60 * (n + 1)));
    expect(feed.pages).toBe(3);
  });

  it("activities are the form's allowed values for the entry: per project, whether the form embeds them or links them", async () => {
    const { sim, bound: b } = simulated();
    sim.project("ops", { disabledActivities: [1, 4] });
    const ref = refOf(await first(b, "#1"));
    const other = sim.add("ops", "In another project");
    for (const allowedAs of ["embedded", "links"] as const) {
      sim.state.allowedAs = allowedAs;
      expect((await b.worklogs!.activities!(meta(), { issue: ref }, 10)).items.map((a) => a.name), allowedAs).toEqual(["Management", "Specification", "Development", "Testing"]);
      expect((await b.worklogs!.activities!(meta(), { issue: refOf(await first(b, other.key)) }, 10)).items.map((a) => a.name), allowedAs).toEqual(["Specification", "Development"]);
    }
    expect(await b.worklogs!.activities!(meta(), {}, 2)).toMatchObject({ complete: false, items: [{ id: "1" }, { id: "2" }] });
    const made = await b.worklogs!.create!(meta(), ref, { ...input("2026-10-14", 3600), activityId: "4" }, { idempotencyKey: "a" });
    expect(made.activity).toEqual({ id: "4", name: "Testing" });
    // No activity asked for: the default one.
    expect((await b.worklogs!.create!(meta(), ref, input("2026-10-14", 60), { idempotencyKey: "d" })).activity).toEqual({ id: "3", name: "Development" });
    // One the project switched off is refused, as is one that doesn't exist.
    expect(await errorOf(b.worklogs!.create!(meta(), refOf(await first(b, other.key)), { ...input("2026-10-14", 60), activityId: "4" }, { idempotencyKey: "x" }))).toMatchObject({ kind: "invalid", fields: { activity: expect.any(String) } });
    expect(await kindOf(b.worklogs!.create!(meta(), ref, { ...input("2026-10-14", 60), activityId: "99" }, { idempotencyKey: "y" }))).toBe("invalid");
  });
});

describe("openproject: errors", () => {
  it("a wrong token is auth (a 401 with a challenge); an anonymous answer in its place too", async () => {
    const { sim, conn } = simulated();
    const bad = bindTracker(openprojectProvider, { ...conn, credential: async () => ({ kind: "token" as const, token: "wrong-token" }) });
    expect(await kindOf(bad.verify(meta()))).toBe("auth");
    expect(await kindOf(bad.listChanged(meta(), { since: null, page: null }))).toBe("auth");
    sim.state.anonymous = true;
    expect(await errorOf(bad.verify(meta()))).toMatchObject({ kind: "auth", message: expect.stringContaining("anonymous") });
  });

  it("sends the token as Basic auth with the user name apikey", async () => {
    const { sim, bound: b } = simulated();
    const seen: string[] = [];
    const real = sim.fetch;
    vi.stubGlobal("fetch", async (i: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return real(i, init);
    });
    await b.verify(meta());
    expect(seen).toEqual([`Basic ${Buffer.from(`apikey:${sim.token}`).toString("base64")}`]);
    const me = await b.verify(meta());
    expect(me).toMatchObject({ remoteId: "5", name: "Mario Rossi", login: "mrossi", email: "mario@example.com", avatarUrl: `${sim.web}/users/5/avatar` });
  });

  it("a spent budget is a wait: Retry-After in seconds or a date, else the reset, else a minute", async () => {
    const { sim, bound: b } = simulated();
    sim.failNext(429, { "Retry-After": "7", "X-RateLimit-Remaining": "0" });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 7000, remaining: 0 } });
    sim.failNext(429, { "Retry-After": new Date(Date.now() + 120_000).toUTCString() });
    expect(((await errorOf(b.verify(meta())))!).rateLimit?.retryAfterMs).toBeGreaterThan(100_000);
    sim.failNext(429, { "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 20) });
    expect(((await errorOf(b.verify(meta())))!).rateLimit?.retryAfterMs).toBeGreaterThan(10_000);
    sim.failNext(429);
    expect(((await errorOf(b.verify(meta())))!).rateLimit?.retryAfterMs).toBe(60_000);
  });

  it("not found, forbidden, validation and server errors in the layer's words", async () => {
    const { sim, bound: b } = simulated();
    expect(await kindOf(b.history!(meta(), { remoteId: "99", key: "#99" }))).toBe("notFound");
    expect(await b.getIssue(meta(), { remoteId: "99", key: "#99" })).toBeNull();
    sim.failNext(403);
    expect(await kindOf(b.verify(meta()))).toBe("forbidden");
    sim.failNext(503);
    expect(await kindOf(b.verify(meta()))).toBe("unavailable");
    sim.failNext(422, undefined, { _type: "Error", message: "multiple", _embedded: { errors: [{ message: "Hours must be greater than 0.", _embedded: { details: { attribute: "hours" } } }, { message: "Date can't be blank.", _embedded: { details: { attribute: "spentOn" } } }] } });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "invalid", fields: { hours: "Hours must be greater than 0.", spentOn: "Date can't be blank." } });
  });

  it("an unknown filter or a bad one is the server's 400, never silently an unfiltered list", async () => {
    const { sim } = simulated();
    const auth = { Authorization: `Basic ${Buffer.from(`apikey:${sim.token}`).toString("base64")}` };
    const ask = (filters: string) => sim.fetch(`${sim.apiBase}/work_packages?filters=${encodeURIComponent(filters)}`, { headers: auth });
    expect((await ask('[{"nonsense":{"operator":"=","values":["1"]}}]')).status).toBe(400);
    expect((await ask('[{"assignee":{"operator":"~","values":["me"]}}]')).status).toBe(400);
    expect((await ask("not json")).status).toBe(400);
  });
});

describe("openproject: the network", () => {
  it("OpenProject's own cloud is public; any other server may be on the user's network", () => {
    expect(networkOf("https://acme.openproject.com")).toBe("public");
    expect(networkOf("https://community.openproject.com/api/v3")).toBe("public");
    expect(networkOf("https://openproject.com.evil.example")).toBe("private");
    expect(networkOf("https://op.corp.example/openproject")).toBe("private");
    expect(networkOf("https://10.0.0.5:8080")).toBe("private");
  });
});

describe("openproject: webhooks", () => {
  const secret = "s3cret";

  it("accepts a delivery signed with the secret (HMAC-SHA1 in X-OP-Signature), with an id that repeats on a redelivery and the time of the change", () => {
    const { sim } = simulated();
    const d = sim.webhook("work_package:updated", { work_package: { id: 1, updatedAt: "2026-10-21T10:00:00.000Z" } }, { secret });
    const req = { headers: d.headers, body: d.rawBody };
    expect(openprojectProvider.webhook!.verify(req, secret)).toBe(true);
    expect(d.headers["x-op-signature"]).toBe(signWebhook(secret, d.rawBody));
    expect(d.headers["x-op-signature"]).toMatch(/^sha1=[0-9a-f]{40}$/);
    // Header names in any case.
    expect(verifyOpenProjectWebhook({ "X-OP-Signature": d.headers["x-op-signature"] }, d.rawBody, secret)).toBe(true);
    expect(openprojectProvider.webhook!.deliveryId(req)).toBe(openProjectDeliveryId(d.rawBody));
    expect(openprojectProvider.webhook!.deliveryId({ headers: {}, body: d.rawBody })).toBe(openprojectProvider.webhook!.deliveryId(req));
    expect(openprojectProvider.webhook!.deliveryId({ headers: {}, body: d.rawBody + " " })).not.toBe(openprojectProvider.webhook!.deliveryId(req));
    expect(openprojectProvider.webhook!.sentAt!(req)).toBe(Date.parse("2026-10-21T10:00:00.000Z"));
    expect(openProjectSentAt("not json")).toBeNull();
    expect(openProjectSentAt('{"action":"x"}')).toBeNull();
    expect(openProjectSentAt('{"time_entry":{"updatedAt":"2026-10-21T10:00:00Z"}}')).toBe(Date.parse("2026-10-21T10:00:00Z"));
  });

  it("refuses a missing, wrong, tampered or malformed signature, and a hook with no secret", () => {
    const { sim } = simulated();
    const ok = sim.webhook("work_package:updated", { work_package: { id: 1 } }, { secret });
    const verify = (headers: Record<string, string>, body: string, s = secret) => openprojectProvider.webhook!.verify({ headers, body }, s);
    expect(verify({}, ok.rawBody)).toBe(false);
    expect(verify(sim.webhook("work_package:updated", { work_package: { id: 1 } }, { secret, signWith: "other" }).headers, ok.rawBody)).toBe(false);
    expect(verify(ok.headers, ok.rawBody.replace("updated", "created"))).toBe(false);
    expect(verify({ "x-op-signature": "sha1=zz" }, ok.rawBody)).toBe(false);
    expect(verify({ "x-op-signature": ok.headers["x-op-signature"].slice(5) }, ok.rawBody)).toBe(false);
    expect(verify({ "x-op-signature": ok.headers["x-op-signature"].replace("sha1", "sha256") }, ok.rawBody)).toBe(false);
    expect(verify(ok.headers, ok.rawBody, "")).toBe(false);
    // A hook with no secret sends no signature: never accepted.
    expect(verify(sim.webhook("work_package:updated", { work_package: { id: 1 } }).headers, ok.rawBody)).toBe(false);
  });

  it("names the declared event an action stands for", () => {
    expect(openProjectEvent('{"action":"work_package:created"}')).toBe("issueChanged");
    expect(openProjectEvent('{"action":"work_package:updated"}')).toBe("issueChanged");
    expect(openProjectEvent('{"action":"work_package_comment:comment"}')).toBe("commentAdded");
    expect(openProjectEvent('{"action":"time_entry:created"}')).toBe("worklogChanged");
    expect(openProjectEvent('{"action":"project:updated"}')).toBeNull();
    expect(openProjectEvent("nope")).toBeNull();
  });
});
