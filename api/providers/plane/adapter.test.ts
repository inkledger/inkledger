import { describe, expect, it, vi } from "vitest";
import { markdown, timeZone, type LocalDate } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import { planeSimulator, type SimIssue } from "./simulator";
import { planeProvider, planeWebhook } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "172.65.251.78", family: 4 }]),
}));

const DAY = 86_400_000;

function simulated(o: { apiBase?: string; workspace?: string; baseUrl?: string; options?: unknown; token?: string; zone?: string } = {}) {
  const sim = planeSimulator(o.apiBase, o.workspace);
  sim.add("PROJ", "Login fails on Safari", { description: "<p>Steps:</p><ol><li>open</li><li><strong>fail</strong></li></ol>", target: "2026-11-05", priority: "high", labels: ["bug"], author: sim.anna.id });
  sim.add("PROJ", "Export to CSV");
  sim.add("OPS", "Rate limit headers");
  // Someone else's, and one I wrote for someone else: not assigned to me.
  sim.add("PROJ", "Anna's", { assignee: sim.anna.id });
  sim.add("PROJ", "Delegated", { assignee: sim.anna.id, author: sim.me.id });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 7,
    userId: 1,
    type: "plane" as const,
    baseUrl: o.baseUrl ?? sim.apiBase,
    remoteAccountId: sim.me.id,
    options: o.options ?? { workspace: sim.workspace },
    timeZone: timeZone(o.zone ?? "Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, conn, b: bindTracker(planeProvider, conn) };
}

trackerConformance("plane (simulated)", async () => {
  const { conn } = simulated();
  return { provider: planeProvider, conn, key: "PROJ-1", writable: true, url: "https://app.plane.so/acme/browse/PROJ-1/" };
});

trackerConformance("plane (simulated, workspace in the address, nothing in the options)", async () => {
  const { conn } = simulated({ baseUrl: "https://api.plane.so/acme", options: {} });
  return { provider: planeProvider, conn, key: "PROJ-1", writable: true, url: "https://app.plane.so/acme/browse/PROJ-1/" };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const pass = (b: ReturnType<typeof simulated>["b"], since: Parameters<typeof b.listChanged>[1]["since"] = null) => readPass((q) => b.listChanged(meta(), q), since);
const feed = (b: ReturnType<typeof simulated>["b"]) => readPass((q) => b.worklogs!.changed!(meta(), q), null);
const ref = (sim: ReturnType<typeof simulated>["sim"], i: SimIssue) => ({ remoteId: i.id, key: sim.keyOf(i), container: { remoteId: i.project, key: sim.projects.get(i.project)!.identifier } });
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; rateLimit?: { retryAfterMs?: number; remaining?: number }; message: string; fields?: Record<string, string> });
const localToday = (zone = "Europe/Rome") => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

describe("plane, issues", () => {
  it("lists what is assigned to the user, not what they wrote, with the project's identifier and the sequence id as key", async () => {
    const { b, sim } = simulated();
    const all = await pass(b);
    expect(all.items.map((i) => i.key).sort()).toEqual(["OPS-1", "PROJ-1", "PROJ-2"]);
    const first = all.items.find((i) => i.key === "PROJ-1")!;
    expect(first).toMatchObject({
      title: "Login fails on Safari",
      due: "2026-11-05",
      url: "https://app.plane.so/acme/browse/PROJ-1/",
      type: { id: "issue", level: "standard" },
      labels: ["bug"],
      priority: { id: "high", name: "High", rank: 1 },
      container: { key: "PROJ", name: "Proj project", kind: "project" },
      status: { name: "Todo", category: "todo", categoryOrigin: { by: "native" }, source: { kind: "itemState", containerRemoteId: first.container.remoteId } },
    });
    expect(first.assignees[0]).toMatchObject({ remoteId: sim.me.id, name: "Mario Rossi", handle: "mrossi" });
    expect(first.reporter).toMatchObject({ name: "Anna Bianchi" });
    // createdAt keeps its instant though Plane writes microseconds.
    expect(first.createdAt).toBe(sim.issues[0].created);
    expect(await b.description!(meta(), ref(sim, sim.issues[0]))).toEqual({ kind: "text", format: "html", text: "<p>Steps:</p><ol><li>open</li><li><strong>fail</strong></li></ol>" });
  });

  it("an item with no description has '<p></p>' on Plane: that is no description", async () => {
    const { b, sim } = simulated();
    const raw = await sim.fetch(`${sim.apiBase}/api/v1/workspaces/acme/projects/${sim.issues[1].project}/work-items/${sim.issues[1].id}/`, { headers: { "X-API-Key": sim.token } });
    expect(((await raw.json()) as { description_html: string }).description_html).toBe("<p></p>");
    expect(await b.description!(meta(), ref(sim, sim.issues[1]))).toBeNull();
  });

  it("reads a pass one project page at a time (per_page tops out at 100; next_cursor is there on the last page too), then only what changed since its checkpoint", async () => {
    const { b, sim } = simulated();
    // The trap itself: a small list still carries a next cursor, and says there is no next page.
    const small = (await (await sim.fetch(`${sim.apiBase}/api/v1/workspaces/acme/projects/${sim.issues[2].project}/work-items/?per_page=500`, { headers: { "X-API-Key": sim.token } })).json()) as { next_cursor: string; next_page_results: boolean; count: number };
    expect(small).toMatchObject({ next_cursor: "100:1:0", next_page_results: false, count: 1 });
    const first = await pass(b);
    expect(first.pages).toBe(2);
    for (let n = 0; n < 130; n++) sim.add("BULK", `Bulk ${n}`);
    const all = await pass(b);
    expect(all.pages).toBe(2 + 3);
    expect(all.items.length).toBe(133);
    expect(new Set(all.items.map((i) => i.remoteId)).size).toBe(133);
    expect(all.checkpoint).not.toBeNull();
    const calls = sim.state.calls;
    expect((await pass(b, all.checkpoint)).items).toEqual([]);
    // Newest change first: each project's reading stops at its first page (a project list and a page per project, not 130 items' worth).
    expect(sim.state.calls - calls).toBeLessThanOrEqual(2 * 4);
    // The oldest by creation, changed now: the default order (-created_at) would bury it on the last page.
    const oldest = sim.issues.find((i) => i.name === "Bulk 0")!;
    sim.outside.retitle(oldest, "Bulk zero");
    const again = await pass(b, all.checkpoint);
    expect(again.items.map((i) => [i.key, i.title])).toEqual([["BULK-1", "Bulk zero"]]);
  });

  it("a state, a person or a label comes as an object only with expand: a server that ignores it still reads", async () => {
    const { b, sim } = simulated();
    sim.state.ignoreExpand = true;
    const all = await pass(b);
    const first = all.items.find((i) => i.key === "PROJ-1")!;
    expect(first.status).toMatchObject({ name: "Todo", category: "todo" });
    expect(first.assignees[0]).toMatchObject({ name: "Mario Rossi" });
    expect(first.reporter).toMatchObject({ name: "Anna Bianchi" });
    // Labels can't be named from uuids alone.
    expect(first.labels).toEqual([]);
  });

  it("the key is the project's current identifier: renamed, the old key is none, the uuid still finds the item, and a project that takes the old identifier is not mistaken for it", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    const before = await b.getIssue(meta(), ref(sim, i));
    sim.outside.renameIdentifier(sim.projects.get(i.project)!, "WEB");
    expect((await b.findIssue(meta(), { key: "PROJ-1" })).kind).toBe("none");
    const after = await b.findIssue(meta(), { key: "WEB-1" });
    expect(after.kind === "found" && after.issue.remoteId).toBe(before?.remoteId);
    const stale = { remoteId: i.id, key: "PROJ-1", container: { remoteId: i.project, key: "PROJ" } };
    expect((await b.getIssue(meta(), stale))?.key).toBe("WEB-1");
    // The identifier is free: another project takes it, and its first item is PROJ-1 as well.
    const squatter = sim.add("PROJ", "Squatter");
    expect(sim.keyOf(squatter)).toBe("PROJ-1");
    expect((await b.getIssue(meta(), { remoteId: i.id, key: "PROJ-1" }))?.title).toBe("Login fails on Safari");
    expect((await b.getIssue(meta(), { remoteId: i.id, key: "PROJ-1" }))?.key).toBe("WEB-1");
    expect((await b.getIssue(meta(), { remoteId: squatter.id, key: "PROJ-1" }))?.title).toBe("Squatter");
    // The pass carries the new key under the same uuid.
    expect((await pass(b)).items.map((x) => [x.remoteId, x.key])).toContainEqual([i.id, "WEB-1"]);
  });

  it("a sequence id is never given twice: deleting the last item does not free its number", async () => {
    const { b, sim } = simulated();
    const gone = sim.add("PROJ", "Short lived");
    expect(sim.keyOf(gone)).toBe("PROJ-5");
    sim.outside.remove(gone);
    expect(sim.keyOf(sim.add("PROJ", "Next"))).toBe("PROJ-6");
    expect((await b.findIssue(meta(), { key: "PROJ-5" })).kind).toBe("none");
  });

  it("a deleted item is gone from lists and reads (404); an archived one is out of the lists but can be read; drafts are never listed", async () => {
    const { b, sim } = simulated();
    const [safari, csv] = sim.issues;
    const draft = sim.add("PROJ", "Half written", { draft: true });
    expect((await pass(b)).items.map((i) => i.key)).not.toContain(sim.keyOf(draft));
    sim.outside.remove(safari);
    sim.outside.archive(csv);
    expect((await pass(b)).items.map((i) => i.key)).toEqual(["OPS-1"]);
    expect(await b.getIssue(meta(), ref(sim, safari))).toBeNull();
    expect((await b.findIssue(meta(), { key: "PROJ-1" })).kind).toBe("none");
    expect((await b.getIssue(meta(), ref(sim, csv)))?.title).toBe("Export to CSV");
    expect(await errorOf(b.comments!.list(meta(), ref(sim, safari)))).toMatchObject({ kind: "notFound" });
  });

  it("an archived project drops out of the passes; its items can still be read", async () => {
    const { b, sim } = simulated();
    sim.outside.archiveProject("OPS");
    expect((await pass(b)).items.map((i) => i.key).sort()).toEqual(["PROJ-1", "PROJ-2"]);
    expect((await b.findIssue(meta(), { key: "OPS-1" })).kind).toBe("found");
    expect((await b.probe(meta())).activeSources.map((s) => s.name)).toEqual(["Proj project"]);
  });

  it("a project the user left answers 403 on its own paths and 404 by key: both read as not there for a lookup, 403 is said where an operation needs it", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[2];
    sim.outside.access("OPS", false);
    expect(await b.getIssue(meta(), ref(sim, i))).toBeNull();
    expect((await b.findIssue(meta(), { key: "OPS-1" })).kind).toBe("none");
    expect((await pass(b)).items.map((x) => x.key).sort()).toEqual(["PROJ-1", "PROJ-2"]);
    expect(await errorOf(b.comments!.list(meta(), ref(sim, i)))).toMatchObject({ kind: "forbidden" });
  });

  it("an item changed by someone else shows in the next pass; one given to someone else stops being the user's", async () => {
    const { b, sim } = simulated();
    const first = await pass(b);
    sim.outside.setState(sim.issues[1], "Done");
    const next = await pass(b, first.checkpoint);
    expect(next.items.map((i) => [i.key, i.status.name, i.status.category])).toEqual([["PROJ-2", "Done", "done"]]);
    expect(next.items[0].statusChangedAt).not.toBeNull();
    // Given away: no longer assigned to me (the feed is the user's items; an engine reconciliation sees the rest).
    sim.outside.assign(sim.issues[1], sim.anna.id);
    expect((await pass(b)).items.map((i) => i.key).sort()).toEqual(["OPS-1", "PROJ-1"]);
  });

  it("a self-managed server sends avatars as paths: they become links on its site; the address may carry a prefix", async () => {
    const { b, conn, sim } = simulated({ apiBase: "https://plane.example.org/plane", workspace: "team", options: { workspace: "team" } });
    const got = await b.getIssue(meta(), ref(sim, sim.issues[0]));
    expect(got?.assignees[0].avatarUrl).toMatch(/^https:\/\/plane\.example\.org\/api\/users\/avatar\/[0-9]+\.png$/);
    expect(got?.url).toBe("https://plane.example.org/plane/team/browse/PROJ-1/");
    expect(b.parseRef("https://plane.example.org/plane/team/browse/PROJ-1/")).toEqual({ key: "PROJ-1" });
    expect(b.parseRef("https://plane.example.org/team/browse/PROJ-1/")).toBeNull();
    // /api/v1 at the end of the address is the same root.
    const sameRoot = bindTracker(planeProvider, { ...conn, baseUrl: "https://plane.example.org/plane/api/v1" });
    expect((await sameRoot.getIssue(meta(), ref(sim, sim.issues[0])))?.key).toBe("PROJ-1");
  });

  it("searches the workspace's items by text, whole, complete when nothing was cut", async () => {
    const { b } = simulated();
    const r = await b.searchText!(meta(), "export", 10);
    expect(r.items.map((i) => i.key)).toEqual(["PROJ-2"]);
    expect(r.complete).toBe(true);
    // What the user can see, not only what is theirs.
    expect((await b.searchText!(meta(), "delegated", 10)).items.map((i) => i.key)).toEqual(["PROJ-4"]);
    const cut = await b.searchText!(meta(), "e", 1);
    expect(cut.items.length).toBe(1);
    expect(cut.complete).toBe(false);
  });
});

describe("plane, keys and links", () => {
  it("reads keys (the identifier in capitals), and the links of the web app, old and new", () => {
    const { b } = simulated();
    expect(b.normalizeKey("proj-12")).toBe("PROJ-12");
    expect(b.normalizeKey("PROJ12")).toBeNull();
    expect(b.normalizeKey("PROJ-x")).toBeNull();
    expect(b.normalizeKey("TOOLONGIDENTIFIER-1")).toBeNull();
    expect(b.parseRef("https://app.plane.so/acme/browse/PROJ-12/")).toEqual({ key: "PROJ-12" });
    expect(b.parseRef("https://app.plane.so/acme/browse/proj-12")).toEqual({ key: "PROJ-12" });
    expect(b.parseRef("https://app.plane.so/acme/projects/5a1f0000-0000-4000-8000-000000000001/issues/5a1f0000-0000-4000-8000-000000000002/")).toEqual({
      remoteId: "5a1f0000-0000-4000-8000-000000000002",
      container: { remoteId: "5a1f0000-0000-4000-8000-000000000001", key: "" },
    });
    // Another workspace, another host, another page.
    expect(b.parseRef("https://app.plane.so/other/browse/PROJ-12/")).toBeNull();
    expect(b.parseRef("https://api.plane.so/acme/browse/PROJ-12/")).toBeNull();
    expect(b.parseRef("https://app.plane.so/acme/cycles/PROJ-12/")).toBeNull();
  });

  it("finds an item by a pasted link, and by a key typed in lower case", async () => {
    const { b } = simulated();
    const handle = b.parseRef("https://app.plane.so/acme/browse/OPS-1/");
    const found = handle && (await b.findIssue(meta(), handle));
    expect(found && found.kind === "found" && found.issue.title).toBe("Rate limit headers");
    const typed = b.normalizeKey("ops-1");
    expect(typed && (await b.findIssue(meta(), { key: typed })).kind).toBe("found");
  });

  it("finds an item by its uuid alone, looking in each project", async () => {
    const { b, sim } = simulated();
    const found = await b.findIssue(meta(), { remoteId: sim.issues[2].id });
    expect(found.kind === "found" && found.issue.key).toBe("OPS-1");
  });
});

describe("plane, workflow", () => {
  it("categorizes a state by its group, never by its name, and offers every other state as a way out", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[1];
    const r = ref(sim, i);
    // A state named like another group's: the group decides.
    const p = sim.projects.get(i.project)!;
    p.states.find((s) => s.group === "started")!.name = "Done";
    const ways = await b.transitions!.list!(meta(), r);
    expect(ways.map((t) => [t.to.name, t.to.category, t.to.nativeReason])).toEqual([
      ["Backlog", "backlog", "backlog"],
      ["Done", "doing", "started"],
      ["Done", "done", "completed"],
      ["Cancelled", "cancelled", "cancelled"],
    ]);
    expect(ways[0].remoteUrl).toBe("https://app.plane.so/acme/browse/PROJ-2/");
  });

  it("sets a state directly; the answer of a change has only uuids, so the item is read again", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[1];
    const r = ref(sim, i);
    const done = (await b.transitions!.list!(meta(), r)).find((t) => t.to.category === "done")!;
    const after = await b.transitions!.apply!(meta(), r, done.id, {});
    expect(after?.status).toMatchObject({ name: "Done", category: "done" });
    expect(after?.statusChangedAt).not.toBeNull();
    expect((await b.transitions!.list!(meta(), r)).map((t) => t.to.name)).not.toContain("Done");
    // Back to a started state: the completion goes with it.
    const doing = (await b.transitions!.list!(meta(), r)).find((t) => t.to.category === "doing")!;
    expect((await b.transitions!.apply!(meta(), r, doing.id, {}))?.statusChangedAt).toBeNull();
  });

  it("refuses a state that isn't one of the project's, and never offers intake (triage)", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[1];
    const r = ref(sim, i);
    sim.projects.get(i.project)!.states.push({ id: "5a1f0000-0000-4000-8000-0000000fffff", name: "Intake", group: "triage", sequence: 1, project: i.project });
    expect((await b.transitions!.list!(meta(), r)).map((t) => t.to.category)).not.toContain("triage");
    expect(await errorOf(b.transitions!.apply!(meta(), r, "5a1f0000-0000-4000-8000-0000000fffff", {}))).toMatchObject({ kind: "invalid" });
    const other = sim.projects.get(sim.issues[2].project)!.states[0].id;
    expect(await errorOf(b.transitions!.apply!(meta(), r, other, {}))).toMatchObject({ kind: "invalid" });
  });

  it("an intake item reads as triage", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[1];
    const p = sim.projects.get(i.project)!;
    p.states.push({ id: "5a1f0000-0000-4000-8000-0000000ffffe", name: "Triage", group: "triage", sequence: 1, project: p.id });
    i.state = "5a1f0000-0000-4000-8000-0000000ffffe";
    expect((await b.getIssue(meta(), ref(sim, i)))?.status).toMatchObject({ category: "triage" });
  });

  it("an unknown state group is the service answering outside the contract", async () => {
    const { b, sim } = simulated();
    sim.projects.get(sim.issues[1].project)!.states[1].group = "paused" as never;
    expect(await errorOf(b.getIssue(meta(), ref(sim, sim.issues[1])))).toMatchObject({ kind: "incompatible" });
  });

  it("lists a project's states in order, one source per project, and the typical budget of 60 a minute", async () => {
    const { b, sim } = simulated();
    const probe = await b.probe(meta());
    expect(probe.activeSources.map((s) => [s.name, s.kind, s.transitions])).toEqual([
      ["Proj project", "itemState", "direct"],
      ["Ops project", "itemState", "direct"],
    ]);
    expect(probe.rateLimit).toEqual({ perHour: 3600, origin: "typical" });
    const states = await b.statuses!(meta(), probe.activeSources[0]);
    expect(states.map((s) => [s.name, s.category, s.order])).toEqual([
      ["Backlog", "backlog", 15000],
      ["Todo", "todo", 25000],
      ["In Progress", "doing", 35000],
      ["Done", "done", 45000],
      ["Cancelled", "cancelled", 55000],
    ]);
    expect(states[0].source).toEqual({ kind: "itemState", containerRemoteId: sim.issues[0].project });
  });
});

describe("plane, comments", () => {
  it("reads HTML comments with their authors (Plane gives uuids), writes paragraphs", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    const r = ref(sim, i);
    sim.outside.comment(i, '<p class="editor-paragraph-block">Reproduced on <strong>iOS</strong> 18</p>');
    const added = await b.comments!.add!(meta(), r, markdown("Looks fine\n\nbut <b>check</b> & retest\nagain"), { idempotencyKey: "c1" });
    expect(added.comment?.body).toEqual({ kind: "text", format: "html", text: "<p>Looks fine</p><p>but &lt;b&gt;check&lt;/b&gt; &amp; retest<br>again</p>" });
    expect(added.warnings).toEqual([]);
    const list = await b.comments!.list(meta(), r);
    expect(list.map((c) => [c.author.name, c.body.kind === "text" ? c.body.text : ""])).toEqual([
      ["Anna Bianchi", '<p class="editor-paragraph-block">Reproduced on <strong>iOS</strong> 18</p>'],
      ["Mario Rossi", "<p>Looks fine</p><p>but &lt;b&gt;check&lt;/b&gt; &amp; retest<br>again</p>"],
    ]);
  });

  it("Markdown beyond paragraphs is sent as text, with a warning for each feature (the server detail never leaves)", async () => {
    const { b, sim } = simulated();
    const added = await b.comments!.add!(meta(), ref(sim, sim.issues[0]), markdown("**bold** and `code`\n\n- a list"), { idempotencyKey: "c2" });
    expect(added.warnings.map((w) => w.feature).sort()).toEqual(["code", "list", "strong"]);
    for (const w of added.warnings) expect(w).not.toHaveProperty("serverDetail");
  });

  it("an empty comment is refused with its field", async () => {
    const { b, sim } = simulated();
    const err = await errorOf(b.comments!.add!(meta(), ref(sim, sim.issues[0]), markdown("  \n\n "), { idempotencyKey: "c3" }));
    expect(err).toMatchObject({ kind: "invalid", fields: { comment_html: "This field is required." } });
  });
});

describe("plane, history", () => {
  it("joins the activities in time order: creation, state, title, people added and removed", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[1];
    sim.outside.setState(i, "In Progress");
    sim.outside.retitle(i, "Export to CSV and XLSX");
    sim.outside.assign(i, sim.anna.id);
    const h = await b.history!(meta(), ref(sim, i));
    expect(h.map((c) => [c.field.id ?? c.field.name, c.from.map((v) => v.text), c.to.map((v) => v.text)])).toEqual([
      ["Work item", [], ["created"]],
      ["state", ["Todo"], ["In Progress"]],
      ["name", ["Export to CSV"], ["Export to CSV and XLSX"]],
      ["assignees", ["mrossi"], []],
      ["assignees", [], ["anna.b"]],
    ]);
    expect(h[1]).toMatchObject({ field: { name: "State" }, actor: { name: "Anna Bianchi" } });
    expect(h[1].to[0].id).toBeTruthy();
    expect(h.map((c) => c.at)).toEqual([...h.map((c) => c.at)].sort((a, c) => a - c));
  });
});

describe("plane, time", () => {
  it("reads the worklogs of an item (all authors): whole minutes on a day", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    sim.worklog(i, { minutes: 90, day: "2026-10-14", description: "debugging" });
    sim.worklog(i, { minutes: 10, day: "2026-10-15", user: sim.anna.id });
    const list = await b.worklogs!.list(meta(), ref(sim, i));
    expect(list.map((w) => [w.span, w.comment, w.authorRemoteId, w.editable])).toEqual([
      [{ kind: "date", date: "2026-10-14", seconds: 5400 }, "debugging", sim.me.id, { update: false, delete: false }],
      [{ kind: "date", date: "2026-10-15", seconds: 600 }, "", sim.anna.id, { update: false, delete: false }],
    ]);
    expect(list[0].issue).toMatchObject({ remoteId: i.id, key: "PROJ-1", container: { key: "PROJ" } });
    // Created only: Plane's update and delete wait for a check on a real account.
    expect(b.worklogs!.update).toBeUndefined();
    expect(b.worklogs!.delete).toBeUndefined();
    expect(b.worklogs!.setDayTotal).toBeUndefined();
  });

  it("an entry with no day of its own is on the day it was created, counted in the user's zone, not in UTC", async () => {
    const { b, sim } = simulated({ zone: "Europe/Rome" });
    const i = sim.issues[0];
    // 23:30 UTC on the 20th is half past one on the 21st in Rome (UTC+2).
    sim.worklog(i, { minutes: 30, at: Date.parse("2026-10-20T23:30:00Z") });
    expect((await b.worklogs!.list(meta(), ref(sim, i)))[0].span).toMatchObject({ date: "2026-10-21" });
    const u = simulated({ zone: "UTC" });
    u.sim.worklog(u.sim.issues[0], { minutes: 30, at: Date.parse("2026-10-20T23:30:00Z") });
    expect((await u.b.worklogs!.list(meta(), ref(u.sim, u.sim.issues[0])))[0].span).toMatchObject({ date: "2026-10-20" });
  });

  it("writes whole minutes (nearest, at least one) on the chosen day", async () => {
    const { b, sim } = simulated();
    const r = ref(sim, sim.issues[0]);
    const day = (d: string) => ({ kind: "date" as const, date: d as LocalDate });
    const made = await b.worklogs!.create!(meta(), r, { time: { ...day("2026-10-14"), seconds: 5400 }, comment: "review" }, { idempotencyKey: "k1" });
    expect(made).toMatchObject({ span: { kind: "date", date: "2026-10-14", seconds: 5400 }, comment: "review", authorRemoteId: sim.me.id, editable: { update: false, delete: false } });
    expect((await b.worklogs!.create!(meta(), r, { time: { ...day("2026-10-14"), seconds: 100 }, comment: "" }, { idempotencyKey: "k2" })).span.seconds).toBe(120);
    expect((await b.worklogs!.create!(meta(), r, { time: { ...day("2026-10-14"), seconds: 20 }, comment: "" }, { idempotencyKey: "k3" })).span.seconds).toBe(60);
    expect(sim.issues[0].worklogs.map((w) => w.minutes)).toEqual([90, 2, 1]);
    expect(await errorOf(b.worklogs!.create!(meta(), r, { time: { kind: "session", start: Date.now() as never, seconds: 60 }, comment: "" }, { idempotencyKey: "k4" }))).toMatchObject({ kind: "invalid" });
  });

  it("a server with no day on its worklogs files the entry on the day it was created", async () => {
    const { b, sim } = simulated();
    sim.state.noLoggedAt = true;
    const r = ref(sim, sim.issues[0]);
    const made = await b.worklogs!.create!(meta(), r, { time: { kind: "date", date: "2026-10-14" as LocalDate, seconds: 3600 }, comment: "" }, { idempotencyKey: "k5" });
    expect(made.span.kind === "date" && made.span.date).toBe(localToday());
  });

  it("the feed re-reads a window of the user's own entries by their day", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    const now = Date.now();
    const mine = (daysAgo: number) => sim.worklog(i, { minutes: 5, at: now - daysAgo * DAY }).id;
    const recent = mine(1);
    const edge = mine(31);
    const old = mine(45);
    sim.worklog(i, { minutes: 5, at: now - DAY, user: sim.anna.id });
    // An item the user holds in another project counts too.
    const ops = sim.worklog(sim.issues[2], { minutes: 7, day: localToday() }).id;
    const f = await feed(b);
    const ids = f.items.map((w) => w.remoteId);
    expect(ids).toEqual(expect.arrayContaining([recent, edge, ops]));
    expect(ids).not.toContain(old);
    expect(f.items.every((w) => w.authorRemoteId === sim.me.id)).toBe(true);
    expect(f.items.find((w) => w.remoteId === ops)?.issue).toMatchObject({ key: "OPS-1" });
    expect(f.gone).toEqual([]);
    expect(f.checkpoint).not.toBeNull();
    // Re-read whole on the next pass, from any checkpoint.
    expect((await readPass((q) => b.worklogs!.changed!(meta(), q), f.checkpoint)).items.length).toBe(f.items.length);
  });

  it("known limit: an item not changed within the window is not read for time (Plane lists no person's time)", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    const w = sim.worklog(i, { minutes: 5, day: localToday() });
    i.updated = Date.now() - 60 * DAY;
    expect((await feed(b)).items.map((x) => x.remoteId)).not.toContain(w.id);
    // The item's own list always has it.
    expect((await b.worklogs!.list(meta(), ref(sim, i))).map((x) => x.remoteId)).toContain(w.id);
  });

  it("pages the feed by project and by cursor", async () => {
    const { b, sim } = simulated();
    // One call per item for its worklogs: 60 a minute would stop a feed this big (spikes: plane-worklog-feed).
    sim.state.limit = 1000;
    for (let n = 0; n < 120; n++) sim.add("BULK", `Bulk ${n}`);
    for (const i of sim.issues.filter((x) => x.name.startsWith("Bulk"))) sim.worklog(i, { minutes: 1, day: localToday() });
    const f = await feed(b);
    expect(f.pages).toBe(2 + 3);
    expect(f.items.length).toBe(120);
    expect(new Set(f.items.map((w) => w.remoteId)).size).toBe(120);
  });
});

describe("plane, webhooks", () => {
  const secret = "s3cret-key";

  it("accepts the delivery signed with the secret (hex HMAC-SHA256 of the raw body), and refuses any other", () => {
    const { sim } = simulated();
    const d = sim.delivery(secret, "issue", "update");
    expect(planeProvider.webhook!.verify(d, secret)).toBe(true);
    expect(planeProvider.webhook!.verify(d, "other")).toBe(false);
    // The body as sent: a re-serialized or touched one fails.
    expect(planeProvider.webhook!.verify({ ...d, body: d.body.replace("update", "delete") }, secret)).toBe(false);
    expect(planeProvider.webhook!.verify({ ...d, body: `${d.body} ` }, secret)).toBe(false);
    expect(planeProvider.webhook!.verify({ ...d, headers: { ...d.headers, "x-plane-signature": "not-hex" } }, secret)).toBe(false);
    expect(planeProvider.webhook!.verify({ ...d, headers: { ...d.headers, "x-plane-signature": d.headers["x-plane-signature"].toUpperCase() } }, secret)).toBe(true);
    const unsigned = Object.fromEntries(Object.entries(d.headers).filter(([name]) => name !== "x-plane-signature"));
    expect(planeProvider.webhook!.verify({ ...d, headers: unsigned }, secret)).toBe(false);
    // No secret key: never accepted, signed with an empty one or not.
    expect(planeProvider.webhook!.verify(sim.delivery("", "issue", "update"), "")).toBe(false);
  });

  it("names the delivery and its event; no moment is documented, so none is claimed", () => {
    const { sim } = simulated();
    const d = sim.delivery(secret, "issue", "delete", "dlv-1");
    expect(planeProvider.webhook!.deliveryId(d)).toBe("dlv-1");
    expect(planeProvider.webhook!.deliveryId({ headers: {}, body: "{}" })).toBeNull();
    expect("sentAt" in planeProvider.webhook!).toBe(false);
    expect(planeWebhook.event(d.headers, d.body)).toBe("issueRemoved");
    expect(planeWebhook.event(sim.delivery(secret, "issue", "create").headers, sim.delivery(secret, "issue", "create").body)).toBe("issueChanged");
    const c = sim.delivery(secret, "issue_comment", "create");
    expect(planeWebhook.event(c.headers, c.body)).toBe("commentAdded");
    expect(planeWebhook.event({ "x-plane-event": "cycle" }, JSON.stringify({ action: "update" }))).toBeNull();
    expect(planeWebhook.event({ "x-plane-event": "issue" }, "not json")).toBeNull();
  });
});

describe("plane, errors and limits", () => {
  it("a bad token is auth (401)", async () => {
    const { b } = simulated({ token: "plane_api_wrong" });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "auth" });
  });

  it("a revoked token is auth on every call", async () => {
    const { b, sim } = simulated();
    expect((await b.verify(meta())).remoteId).toBe(sim.me.id);
    sim.revoke();
    expect(await errorOf(pass(b))).toMatchObject({ kind: "auth" });
  });

  it("a spent quota is a wait: 429 with Retry-After, the throttle's own text and all", async () => {
    const { b, sim } = simulated();
    sim.exhaust();
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 30_000, remaining: 0 } });
    sim.refill();
    expect((await b.verify(meta())).name).toBe("Mario Rossi");
  });

  it("60 calls a minute really are the limit: the call past it waits until the window's reset", async () => {
    const { b, sim } = simulated();
    sim.state.limit = 3;
    for (let n = 0; n < 3; n++) await b.verify(meta());
    const err = await errorOf(b.verify(meta()));
    expect(err).toMatchObject({ kind: "rateLimit", rateLimit: { remaining: 0 } });
    expect(err?.rateLimit?.retryAfterMs).toBeGreaterThan(0);
    expect(err?.rateLimit?.retryAfterMs).toBeLessThanOrEqual(61_000);
  });

  it("without Retry-After the wait comes from X-RateLimit-Reset (epoch seconds), else from the throttle's text", async () => {
    const { b } = simulated();
    const reset = Math.ceil(Date.now() / 1000) + 20;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ detail: "Request was throttled." }), { status: 429, headers: { "X-RateLimit-Reset": String(reset) } }));
    const err = await errorOf(b.verify(meta()));
    expect(err).toMatchObject({ kind: "rateLimit" });
    expect(err?.rateLimit?.retryAfterMs).toBeGreaterThan(15_000);
    expect(err?.rateLimit?.retryAfterMs).toBeLessThanOrEqual(21_000);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ detail: "Request was throttled. Expected available in 12 seconds." }), { status: 429 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 12_000 } });
    vi.stubGlobal("fetch", async () => new Response("slow down", { status: 429 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 60_000 } });
  });

  it("a missing item is notFound where an operation needs it, null where a lookup asks", async () => {
    const { b, sim } = simulated();
    const ghost = { remoteId: "5a1f0000-0000-4000-8000-00000000dead", key: "PROJ-404", container: { remoteId: sim.issues[0].project, key: "PROJ" } };
    expect(await b.getIssue(meta(), ghost)).toBeNull();
    expect(await errorOf(b.comments!.list(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.transitions!.list!(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.worklogs!.list(meta(), { remoteId: ghost.remoteId, key: "PROJ-404" }))).toMatchObject({ kind: "notFound" });
  });

  it("a workspace that isn't there is notFound; no workspace at all is said, not guessed", async () => {
    const { conn, sim } = simulated();
    const wrong = bindTracker(planeProvider, { ...conn, options: { workspace: "nope" } });
    expect(await errorOf(wrong.probe(meta()))).toMatchObject({ kind: "notFound", message: expect.stringContaining("Workspace") });
    // The token alone says who it is; the rest needs the workspace.
    const none = bindTracker(planeProvider, { ...conn, options: {} });
    expect((await none.verify(meta())).remoteId).toBe(sim.me.id);
    expect(await errorOf(none.probe(meta()))).toMatchObject({ kind: "invalid", message: expect.stringContaining("workspace") });
  });

  it("validation errors come with their fields", async () => {
    const { b, sim } = simulated();
    const r = ref(sim, sim.issues[0]);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ duration: ["Ensure this value is greater than or equal to 1."] }), { status: 400 }));
    const err = await errorOf(b.worklogs!.create!(meta(), r, { time: { kind: "date", date: "2026-10-14" as LocalDate, seconds: 60 }, comment: "" }, { idempotencyKey: "k" }));
    expect(err).toMatchObject({ kind: "invalid", fields: { duration: "Ensure this value is greater than or equal to 1." } });
  });

  it("knows who the token belongs to", async () => {
    const { b, sim } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: sim.me.id, name: "Mario Rossi", handle: "mrossi", login: "mrossi", email: "mario@acme.example" });
  });

  it("options: a workspace slug or nothing; anything else is refused", () => {
    expect(planeProvider.parseOptions(undefined)).toEqual({ workspace: null });
    expect(planeProvider.parseOptions({ workspace: "acme-2" })).toEqual({ workspace: "acme-2" });
    expect(() => planeProvider.parseOptions({ workspace: "not a slug" })).toThrow(/slug/);
    expect(() => planeProvider.parseOptions({ workspace: "a", extra: 1 })).toThrow();
  });
});
