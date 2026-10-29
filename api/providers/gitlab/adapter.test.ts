import { describe, expect, it, vi } from "vitest";
import { instant, timeZone } from "@contracts/values";
import { markdown } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { statusHistoryConformance, trackerConformance } from "../conformance/suite";
import { gitlabSimulator } from "./simulator";
import { gitlabProvider, gitlabWebhook, withoutQuickActions, type GitLabOptions } from "./adapter";
import { entriesOfNotes, forgetTimeMode, parseDuration, parseSpendNote, spendDuration } from "./legacyTime";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "172.65.251.78", family: 4 }]),
}));

const WORKFLOW: GitLabOptions = {
  workflow: { scope: "workflow", categories: { todo: "todo", doing: "doing", review: "doing", done: "done", wontdo: "cancelled" } },
};

function simulated(o: { apiBase?: string; options?: unknown; token?: string; version?: "13.6" | "16" } = {}) {
  const sim = gitlabSimulator(o.apiBase, undefined, { version: o.version });
  // What a server can do is kept an hour per address: each test's server is a new one.
  forgetTimeMode({ apiBase: sim.apiBase, token: "" });
  sim.add("acme/web", "Login fails on Safari", { description: "Steps:\n\n1. open\n2. **fail**", due: "2026-11-05" });
  sim.add("acme/web", "Export to CSV", { labels: ["bug"] });
  sim.add("acme/platform/api", "Rate limit headers", { type: "task" });
  // Someone else's, and one I wrote for someone else: not assigned to me.
  sim.add("acme/web", "Anna's", { assignee: 78 });
  sim.add("acme/web", "Delegated", { assignee: 78, author: sim.me.id });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 7,
    userId: 1,
    type: "gitlab" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: String(sim.me.id),
    options: o.options ?? {},
    timeZone: timeZone("Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, conn, b: bindTracker(gitlabProvider, conn) };
}

trackerConformance("gitlab (simulated)", async () => {
  const { conn } = simulated();
  return { provider: gitlabProvider, conn, key: "acme/web#1", writable: true, url: "https://gitlab.com/acme/web/-/issues/1" };
});

trackerConformance("gitlab (simulated, scoped label workflow)", async () => {
  const { conn, sim } = simulated({ options: WORKFLOW });
  sim.outside.label(sim.issues[0], "workflow::todo");
  return { provider: gitlabProvider, conn, key: "acme/web#1", writable: true, url: "https://gitlab.com/acme/web/-/issues/1" };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const pass = (b: ReturnType<typeof simulated>["b"], since: Parameters<typeof b.listChanged>[1]["since"] = null) => readPass((q) => b.listChanged(meta(), q), since);
const ref = (i: { id: number; projectId: number }, key: string) => ({ remoteId: String(i.id), key, container: { remoteId: String(i.projectId), key: key.slice(0, key.lastIndexOf("#")) } });
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; rateLimit?: { retryAfterMs?: number; remaining?: number }; message: string });

describe("gitlab, issues", () => {
  it("lists what is assigned to the user, not what they wrote (scope defaults to created_by_me), with the project's number as key", async () => {
    const { b } = simulated();
    const all = await pass(b);
    expect(all.items.map((i) => [i.key, i.container.key, i.status.name, i.status.category])).toEqual([
      ["acme/web#1", "acme/web", "Open", "todo"],
      ["acme/web#2", "acme/web", "Open", "todo"],
      ["acme/platform/api#1", "acme/platform/api", "Open", "todo"],
    ]);
    const [first, , task] = all.items;
    expect(first).toMatchObject({ title: "Login fails on Safari", due: "2026-11-05", url: "https://gitlab.com/acme/web/-/issues/1", type: { id: "issue", level: "standard" } });
    expect(first.assignees[0]).toMatchObject({ name: "Mario Rossi", handle: "mrossi" });
    expect(task.type).toMatchObject({ id: "task", level: "sub" });
    expect((await b.description!(meta(), { remoteId: first.remoteId, key: first.key }))).toEqual({ kind: "text", format: "glfm", text: "Steps:\n\n1. open\n2. **fail**" });
  });

  it("closed issues are in the feed too (state=all; the state of the API is 'opened', not 'open')", async () => {
    const { b, sim } = simulated();
    sim.outside.close(sim.issues[1]);
    expect((await pass(b)).items.find((i) => i.key === "acme/web#2")?.status).toMatchObject({ name: "Closed", category: "done", categoryOrigin: { by: "native" } });
    // The simulator holds GitLab's validation: the wrong word is a 400.
    expect((await sim.fetch(`${sim.apiBase}/issues?scope=all&state=open`, { headers: { "PRIVATE-TOKEN": sim.token } })).status).toBe(400);
  });

  it("the id is the instance's, the iid the project's: two issues number 1 stay two issues", async () => {
    const { b, sim } = simulated();
    const other = sim.add("acme/mobile", "Same number");
    const all = await pass(b);
    expect(all.items.filter((i) => i.key.endsWith("#1")).length).toBe(3);
    expect(new Set(all.items.map((i) => i.remoteId)).size).toBe(all.items.length);
    const found = await b.findIssue(meta(), { key: "acme/mobile#1" });
    expect(found.kind === "found" && found.issue.remoteId).toBe(String(other.id));
    expect((await b.getIssue(meta(), ref(other, "acme/mobile#1")))?.title).toBe("Same number");
  });

  it("reads a pass page by page (per_page tops out at 100), then only what changed since its checkpoint", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 130; n++) sim.add("acme/bulk", `Bulk ${n}`);
    const all = await pass(b);
    expect(all.pages).toBeGreaterThanOrEqual(3);
    expect(all.items.length).toBe(133);
    expect(new Set(all.items.map((i) => i.remoteId)).size).toBe(133);
    expect(all.checkpoint).not.toBeNull();
    expect((await pass(b, all.checkpoint)).items).toEqual([]);
    sim.outside.retitle(sim.issues[0], "Login fails on Safari 18");
    const again = await pass(b, all.checkpoint);
    expect(again.items.map((i) => [i.key, i.title])).toEqual([["acme/web#1", "Login fails on Safari 18"]]);
  });

  it("a moved issue stays behind, closed: reported as transferred, with its successor", async () => {
    const { b, sim } = simulated();
    const first = await pass(b);
    const moved = sim.outside.move(sim.issues[0], "acme/platform/web");
    const next = await pass(b, first.checkpoint);
    expect(next.gone).toEqual([{ remoteId: String(sim.issues[0].id), reason: "transferred", successor: { remoteId: String(moved.id), key: "acme/platform/web#1", container: { remoteId: String(moved.projectId), key: "acme/platform/web" } } }]);
    expect(next.items.map((i) => i.key)).toEqual(["acme/platform/web#1"]);
  });

  it("a renamed project keeps its id: the key changes, the issue is still found by its hint, and a reused old path isn't mistaken for it", async () => {
    const { b, sim } = simulated();
    const first = await pass(b);
    const before = first.items[0];
    sim.outside.renameProject("acme/web", "acme/website");
    const after = await pass(b, first.checkpoint);
    expect(after.items.map((i) => [i.remoteId, i.key])).toContainEqual([before.remoteId, "acme/website#1"]);
    // The old key alone is a 404 (and none); with the project's id the issue is found.
    expect((await b.findIssue(meta(), { key: "acme/web#1" })).kind).toBe("none");
    const stale = { remoteId: before.remoteId, key: "acme/web#1", container: { remoteId: before.container.remoteId, key: "acme/web" } };
    expect((await b.getIssue(meta(), stale))?.key).toBe("acme/website#1");
    // Another project takes the freed path: same path and number, not the same issue.
    const squatter = sim.add("acme/web", "Squatter");
    expect(squatter.iid).toBe(1);
    expect((await b.getIssue(meta(), { remoteId: before.remoteId, key: "acme/web#1" }))?.key).toBe("acme/website#1");
  });

  it("what the user can't see is a 404 and reads as not there, never as forbidden", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    sim.outside.access("acme/web", false);
    expect(await b.getIssue(meta(), ref(i, "acme/web#1"))).toBeNull();
    expect((await b.findIssue(meta(), { key: "acme/web#1" })).kind).toBe("none");
    expect((await pass(b)).items.map((x) => x.key)).toEqual(["acme/platform/api#1"]);
    expect(await errorOf(b.comments!.list(meta(), ref(i, "acme/web#1")))).toMatchObject({ kind: "notFound" });
  });

  it("an avatar sent as a path on a self-managed site becomes a full link", async () => {
    const { sim, conn } = simulated({ apiBase: "https://git.example.org/api/v4" });
    sim.add("ops/infra", "Patch the host", { assignee: 78 });
    sim.outside.assign(sim.issues.at(-1)!, 78);
    const b = bindTracker(gitlabProvider, conn);
    const got = await b.getIssue(meta(), ref(sim.issues.at(-1)!, "ops/infra#1"));
    expect(got?.assignees[0].avatarUrl).toBe("https://git.example.org/uploads/-/system/user/avatar/78/avatar.png");
    expect(got?.url).toBe("https://git.example.org/ops/infra/-/issues/1");
  });

  it("searches only the user's own (assigned or written), complete when nothing was cut", async () => {
    const { b } = simulated();
    const r = await b.searchText!(meta(), "export", 10);
    expect(r.items.map((i) => i.key)).toEqual(["acme/web#2"]);
    expect(r.complete).toBe(true);
    const delegated = await b.searchText!(meta(), "delegated", 10);
    expect(delegated.items.map((i) => i.key)).toEqual(["acme/web#4"]);
    const cut = await b.searchText!(meta(), "a", 1);
    expect(cut.items.length).toBe(1);
    expect(cut.complete).toBe(false);
  });
});

describe("gitlab, keys and links", () => {
  it("reads keys with subgroups, and the links of the web UI (with or without /-/, work items, a path prefix)", () => {
    const { b } = simulated();
    expect(b.normalizeKey("acme/platform/api#12")).toBe("acme/platform/api#12");
    expect(b.normalizeKey("api#12")).toBeNull();
    expect(b.normalizeKey("acme/api#x")).toBeNull();
    expect(b.parseRef("https://gitlab.com/acme/platform/api/-/issues/12")).toEqual({ key: "acme/platform/api#12" });
    expect(b.parseRef("https://gitlab.com/acme/api/-/issues/12#note_55")).toEqual({ key: "acme/api#12" });
    expect(b.parseRef("https://gitlab.com/acme/api/-/work_items/12/")).toEqual({ key: "acme/api#12" });
    expect(b.parseRef("https://gitlab.com/acme/api/issues/12")).toEqual({ key: "acme/api#12" });
    expect(b.parseRef("https://gitlab.com/acme/api/-/merge_requests/12")).toBeNull();
    expect(b.parseRef("https://gitlab.example/acme/api/-/issues/12")).toBeNull();
    const prefixed = bindTracker(gitlabProvider, { ...simulated().conn, baseUrl: "https://example.org/gitlab/api/v4" });
    expect(prefixed.parseRef("https://example.org/gitlab/acme/api/-/issues/3")).toEqual({ key: "acme/api#3" });
    expect(prefixed.parseRef("https://example.org/other/acme/api/-/issues/3")).toBeNull();
  });

  it("finds an issue by a pasted link", async () => {
    const { b } = simulated();
    const handle = b.parseRef("https://gitlab.com/acme/platform/api/-/issues/1");
    const found = handle && (await b.findIssue(meta(), handle));
    expect(found && found.kind === "found" && found.issue.title).toBe("Rate limit headers");
  });
});

describe("gitlab, workflow", () => {
  it("opens and closes: Close and Reopen, the open/closed state as the only source by default", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.issues[0], "acme/web#1");
    expect((await b.transitions!.list!(meta(), r)).map((t) => [t.name, t.to.category])).toEqual([["Close", "done"]]);
    const closed = await b.transitions!.apply!(meta(), r, "close", {});
    expect(closed?.status).toMatchObject({ name: "Closed", category: "done" });
    expect((await b.transitions!.list!(meta(), r)).map((t) => [t.name, t.to.name, t.to.category])).toEqual([["Reopen", "Open", "todo"]]);
    expect((await b.transitions!.apply!(meta(), r, "reopen", {}))?.status.name).toBe("Open");
    expect((await b.probe(meta())).activeSources.map((s) => s.kind)).toEqual(["boolean"]);
    expect((await b.statuses!(meta(), { kind: "boolean", transitions: "direct", reasons: false, ref: { kind: "boolean" }, name: "Open / closed" })).map((s) => s.name)).toEqual(["Open", "Closed"]);
  });

  it("a scoped label set gives statuses whose categories come from the connection's options, never from the names", async () => {
    const { b, sim } = simulated({ options: WORKFLOW });
    const i = sim.issues[0];
    const r = ref(i, "acme/web#1");
    expect((await b.getIssue(meta(), r))?.status).toMatchObject({ name: "Open", category: "todo" });
    sim.outside.label(i, "workflow::review");
    // 'review' is a doing status because the options say so.
    expect((await b.getIssue(meta(), r))?.status).toMatchObject({ id: "review", category: "doing", categoryOrigin: { by: "mapping" }, source: { kind: "labelSet", scope: "workflow" } });
    // A label outside the options means nothing.
    sim.outside.label(i, "workflow::mystery");
    expect((await b.getIssue(meta(), r))?.status.name).toBe("Open");
    const ways = await b.transitions!.list!(meta(), r);
    expect(ways.map((t) => [t.id, t.to.category])).toEqual([
      ["label:todo", "todo"],
      ["label:doing", "doing"],
      ["label:review", "doing"],
      ["label:done", "done"],
      ["label:wontdo", "cancelled"],
      ["close", "done"],
    ]);
    // Moving takes the old label off (GitLab keeps one per scope).
    const moved = await b.transitions!.apply!(meta(), r, "label:done", {});
    expect(moved?.status).toMatchObject({ id: "done", category: "done" });
    expect(moved?.labels.filter((l) => l.startsWith("workflow::"))).toEqual(["workflow::done"]);
    expect((await b.transitions!.apply!(meta(), r, "label:wontdo", {}))?.status.category).toBe("cancelled");
    // Closed is closed whatever its label says.
    expect((await b.transitions!.apply!(meta(), r, "close", {}))?.status).toMatchObject({ name: "Closed", category: "done" });
    const probe = await b.probe(meta());
    expect(probe.activeSources.map((s) => s.kind)).toEqual(["boolean", "labelSet"]);
    const source = probe.activeSources[1];
    expect((await b.statuses!(meta(), source)).map((s) => [s.id, s.category, s.order])).toEqual([
      ["todo", "todo", 0],
      ["doing", "doing", 1],
      ["review", "doing", 2],
      ["done", "done", 3],
      ["wontdo", "cancelled", 4],
    ]);
  });

  it("two labels of one scope are no status (several is not an answer)", async () => {
    const { b, sim } = simulated({ options: WORKFLOW });
    const i = sim.issues[0];
    // The simulator, like GitLab, keeps one: put two in by hand.
    i.labels.push("workflow::todo", "Workflow::doing");
    expect((await b.getIssue(meta(), ref(i, "acme/web#1")))?.status.name).toBe("Open");
  });

  it("refuses options it can't read", () => {
    expect(() => gitlabProvider.parseOptions({ workflow: { scope: "a::b", categories: {} } })).toThrow(/scope/);
    expect(() => gitlabProvider.parseOptions({ workflow: { scope: "w", categories: { x: "wip" } } })).toThrow();
    expect(gitlabProvider.parseOptions(undefined)).toEqual({ workflow: null });
  });
});

describe("gitlab, comments", () => {
  it("leaves system notes out, reads and writes GLFM", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    const r = ref(i, "acme/web#1");
    sim.outside.comment(i, "Reproduced on **iOS** 18");
    await b.transitions!.apply!(meta(), r, "close", {});
    // "closed" is in the notes as a system note.
    expect(i.notes.some((n) => n.system)).toBe(true);
    const added = await b.comments!.add!(meta(), r, markdown("Looks **fixed**"), { idempotencyKey: "c1" });
    expect(added.comment?.body).toEqual({ kind: "text", format: "glfm", text: "Looks **fixed**" });
    expect(added.warnings).toEqual([]);
    const list = await b.comments!.list(meta(), r);
    expect(list.map((c) => [c.author.name, c.body])).toEqual([
      ["Anna Bianchi", { kind: "text", format: "glfm", text: "Reproduced on **iOS** 18" }],
      ["Mario Rossi", { kind: "text", format: "glfm", text: "Looks **fixed**" }],
    ]);
  });

  it("a line starting with / would run as a quick action: it is written as text", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    const r = ref(i, "acme/web#1");
    // The trap itself: raw, the note closes the issue and is not kept.
    const raw = await sim.fetch(`${sim.apiBase}/projects/${i.projectId}/issues/${i.iid}/notes`, { method: "POST", headers: { "PRIVATE-TOKEN": sim.token }, body: JSON.stringify({ body: "/close" }) });
    expect(raw.status).toBe(202);
    expect(i.state).toBe("closed");
    sim.outside.reopen(i);
    const added = await b.comments!.add!(meta(), r, markdown("/close\nplease look\n\n```\n/close in code\n```"), { idempotencyKey: "c2" });
    expect(i.state).toBe("opened");
    expect(added.comment?.body).toMatchObject({ text: "\\/close\nplease look\n\n```\n/close in code\n```" });
    expect(withoutQuickActions("  /assign @x\nnot /this\n~~~\n/spend 1h\n~~~")).toBe("  \\/assign @x\nnot /this\n~~~\n/spend 1h\n~~~");
  });

  it("a note answered with nothing is read again later (null), not invented", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.issues[0], "acme/web#1");
    const real = sim.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => (init?.method === "POST" && String(input).endsWith("/notes") ? new Response(JSON.stringify({ commands_changes: {} }), { status: 202 }) : real(input, init)));
    expect((await b.comments!.add!(meta(), r, markdown("hello"), { idempotencyKey: "c3" })).comment).toBeNull();
  });
});

describe("gitlab, watching and history", () => {
  it("subscribing twice (a 304) and unsubscribing twice are successes", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.issues[0], "acme/web#1");
    await b.watch!(meta(), r, true);
    await b.watch!(meta(), r, true);
    expect(sim.issues[0].subscribed.has(sim.me.id)).toBe(true);
    await b.watch!(meta(), r, false);
    await b.watch!(meta(), r, false);
    expect(sim.issues[0].subscribed.has(sim.me.id)).toBe(false);
  });

  it("history joins label and state events in time order; a label deleted since has no name left", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    sim.outside.label(i, "bug");
    sim.outside.close(i);
    sim.outside.unlabel(i, "bug");
    sim.outside.label(i, "gone");
    sim.outside.deleteLabel("acme/web", "gone");
    const h = await b.history!(meta(), ref(i, "acme/web#1"));
    expect(h.map((c) => [c.field.id, c.from.map((v) => v.text), c.to.map((v) => v.text)])).toEqual([
      ["labels", [], ["bug"]],
      ["state", [], ["closed"]],
      ["labels", ["bug"], []],
      ["labels", [], ["(deleted label)"]],
    ]);
    expect(h[0].actor).toMatchObject({ name: "Anna Bianchi" });
    expect(h.map((c) => c.at)).toEqual([...h.map((c) => c.at)].sort((a, c) => a - c));
  });
});

describe("gitlab, time", () => {

  it("reads timelogs of an issue (all authors), as sessions that can be deleted", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    const at = Date.parse("2026-10-14T08:30:00Z");
    sim.timelog(i, { seconds: 5400, at, summary: "debugging" });
    sim.timelog(i, { seconds: 600, at: at + 3_600_000, user: 78 });
    const list = await b.worklogs!.list(meta(), ref(i, "acme/web#1"));
    expect(list.map((w) => [w.span, w.comment, w.authorRemoteId, w.editable])).toEqual([
      [{ kind: "session", start: at, seconds: 5400 }, "debugging", String(sim.me.id), { update: false, delete: true }],
      [{ kind: "session", start: at + 3_600_000, seconds: 600 }, "", "78", { update: false, delete: true }],
    ]);
    expect(list[0].issue).toMatchObject({ remoteId: String(i.id), key: "acme/web#1", container: { remoteId: String(i.projectId) } });
    // No update: delete and log again.
    expect(b.worklogs!.update).toBeUndefined();
  });

  it("logs and deletes with timelogCreate/timelogDelete on a newer server, the day and clock time kept", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    const start = Date.now() - 2 * 3_600_000;
    const w = await b.worklogs!.create!(meta(), ref(i, "acme/web#1"), { time: { kind: "session", start: instant(start), seconds: 2700 }, comment: "review" }, { idempotencyKey: "k1" });
    expect(w).toMatchObject({ span: { kind: "session", start: Math.floor(start / 1000) * 1000, seconds: 2700 }, comment: "review", authorRemoteId: String(sim.me.id) });
    expect(sim.timelogs.map((t) => [t.seconds, t.summary])).toEqual([[2700, "review"]]);
    // No note was written for it.
    expect(i.notes.filter((n) => /spend|time spent/.test(n.body))).toEqual([]);
    await b.worklogs!.delete!(meta(), ref(i, "acme/web#1"), w.remoteId, {});
    expect(sim.timelogs).toEqual([]);
    // Deleting it again is what was asked.
    await b.worklogs!.delete!(meta(), ref(i, "acme/web#1"), w.remoteId, {});
  });
});

describe("gitlab, time on an older server (13.6: no timelogs in GraphQL)", () => {
  const today = (h: number, m = 0) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const dayOf = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  it("logs with a /spend note on the entry's day, and the system note it leaves is the entry", async () => {
    const { b, sim } = simulated({ version: "13.6" });
    const i = sim.issues[0];
    const start = Math.min(today(0, 30), Date.now() - 6 * 3_600_000);
    const w = await b.worklogs!.create!(meta(), ref(i, "acme/web#1"), { time: { kind: "session", start: instant(start), seconds: 5400 }, comment: "" }, { idempotencyKey: "k1" });
    // The clock time asked for comes back; the server keeps the day.
    expect(w).toMatchObject({ remoteId: expect.stringMatching(/^n\d+$/), span: { kind: "session", start, seconds: 5400 }, dayOnly: true, editable: { update: false, delete: true } });
    expect(i.notes.filter((n) => n.system).map((n) => n.body)).toEqual([`added 1h 30m of time spent at ${dayOf(start)}`]);
    // A note of only the command leaves no comment.
    expect(i.notes.filter((n) => !n.system)).toEqual([]);
    const list = await b.worklogs!.list(meta(), ref(i, "acme/web#1"));
    expect(list.map((x) => [x.remoteId, x.span.seconds, x.dayOnly])).toEqual([[w.remoteId, 5400, true]]);
  });

  it("a comment goes in the same note, above the command, its own lines starting with / kept as text", async () => {
    const { b, sim } = simulated({ version: "13.6" });
    const i = sim.issues[0];
    await b.worklogs!.create!(meta(), ref(i, "acme/web#1"), { time: { kind: "session", start: instant(Date.now() - 60_000), seconds: 900 }, comment: "fixed\n/close" }, { idempotencyKey: "k1" });
    expect(i.state).toBe("opened");
    expect(i.notes.filter((n) => !n.system).map((n) => n.body)).toEqual(["fixed\n\\/close"]);
  });

  it("deletes by spending the same time back on its day; the feed then leaves it out", async () => {
    const { b, sim } = simulated({ version: "13.6" });
    const i = sim.issues[0];
    const r = ref(i, "acme/web#1");
    const start = Date.now() - 3_600_000;
    const a = await b.worklogs!.create!(meta(), r, { time: { kind: "session", start: instant(start), seconds: 600 }, comment: "" }, { idempotencyKey: "a" });
    const twin = await b.worklogs!.create!(meta(), r, { time: { kind: "session", start: instant(start + 60_000), seconds: 600 }, comment: "" }, { idempotencyKey: "b" });
    expect(twin.remoteId).not.toBe(a.remoteId);
    await b.worklogs!.delete!(meta(), r, twin.remoteId, {});
    expect(i.notes.filter((n) => n.system).map((n) => n.body.split(" ")[0])).toEqual(["added", "added", "subtracted"]);
    expect((await b.worklogs!.list(meta(), r)).map((w) => w.remoteId)).toEqual([a.remoteId]);
    // Gone already: nothing more is spent back.
    await b.worklogs!.delete!(meta(), r, twin.remoteId, {});
    expect(i.notes.filter((n) => n.system)).toHaveLength(3);
  });

  it("the feed reads the notes of the user's issues touched in the window, everyone's entries (the core keeps the user's)", async () => {
    const { b, sim } = simulated({ version: "13.6" });
    const i = sim.issues[0];
    await b.worklogs!.create!(meta(), ref(i, "acme/web#1"), { time: { kind: "session", start: instant(Date.now() - 60_000), seconds: 1200 }, comment: "" }, { idempotencyKey: "k" });
    sim.outside.spend(i, "/spend 2h", 78);
    const feed = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    expect(feed.items.map((w) => [w.authorRemoteId, w.span.seconds])).toEqual([
      [String(sim.me.id), 1200],
      ["78", 7200],
    ]);
    expect(feed.checkpoint).not.toBeNull();
  });

  it("follows the server when it is upgraded: timelogs once its schema has them", async () => {
    const { b, sim } = simulated({ version: "13.6" });
    const i = sim.issues[0];
    const r = ref(i, "acme/web#1");
    const old = await b.worklogs!.create!(meta(), r, { time: { kind: "session", start: instant(Date.now() - 60_000), seconds: 300 }, comment: "" }, { idempotencyKey: "a" });
    sim.state.version = "16";
    forgetTimeMode({ apiBase: sim.apiBase, token: "" });
    const fresh = await b.worklogs!.create!(meta(), r, { time: { kind: "session", start: instant(Date.now() - 30_000), seconds: 300 }, comment: "" }, { idempotencyKey: "b" });
    expect(fresh.remoteId).toMatch(/^\d+$/);
    // One logged by note before the upgrade is still taken back by note.
    await b.worklogs!.delete!(meta(), r, old.remoteId, {});
    expect(i.notes.filter((n) => n.system).at(-1)?.body).toMatch(/^subtracted 5m of time spent at /);
  });

  it("a newer call answered 'doesn't exist' reads the schema again next time (a downgrade, a restore)", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.issues[0], "acme/web#1");
    await b.worklogs!.list(meta(), r);
    sim.state.version = "13.6";
    expect(await errorOf(b.worklogs!.list(meta(), r))).toMatchObject({ message: expect.stringContaining("doesn't exist") });
    expect(await b.worklogs!.list(meta(), r)).toEqual([]);
  });
});

describe("gitlab, time feed", () => {
  const day = 86_400_000;

  it("the feed re-reads a window of the user's own entries by their date, in whole UTC days (not a rolling 30x24 hours)", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    const now = Date.now();
    const mine = (ago: number) => sim.timelog(i, { seconds: 60, at: now - ago }).id;
    const recent = mine(2 * 3_600_000);
    // Three hours short of 30 days ago, then past the edge by hours: still on a UTC day the window covers.
    const edge = mine(30 * day + 2 * 3_600_000);
    const old = mine(45 * day);
    sim.timelog(i, { seconds: 60, at: now - 3_600_000, user: 78 });
    const feed = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    const ids = feed.items.map((w) => w.remoteId);
    expect(ids).toContain(String(recent));
    expect(ids).toContain(String(edge));
    expect(ids).not.toContain(String(old));
    expect(feed.items.every((w) => w.authorRemoteId === String(sim.me.id))).toBe(true);
    expect(feed.gone).toEqual([]);
    expect(feed.checkpoint).not.toBeNull();
  });

  it("an entry written moments ago, on today's UTC day, is in the feed (the end of the range is a day, not midnight)", async () => {
    const { b, sim } = simulated();
    const t = sim.timelog(sim.issues[0], { seconds: 30, at: Date.now() - 1000 });
    const feed = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    expect(feed.items.map((w) => w.remoteId)).toContain(String(t.id));
  });

  it("pages the feed by cursor", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 130; n++) sim.timelog(sim.issues[0], { seconds: 60, at: Date.now() - n * 60_000 });
    const feed = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    expect(feed.pages).toBe(2);
    expect(new Set(feed.items.map((w) => w.remoteId)).size).toBe(130);
    const again = await readPass((q) => b.worklogs!.changed!(meta(), q), feed.checkpoint);
    expect(again.items.length).toBe(130);
  });

  it("GraphQL errors arrive with a 200: they are errors all the same", async () => {
    const { b, sim } = simulated();
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => (String(input).endsWith("/graphql") ? new Response(JSON.stringify({ errors: [{ message: "Field 'timelogs' doesn't exist" }] }), { status: 200 }) : sim.fetch(input, init)));
    expect(await errorOf(b.worklogs!.list(meta(), ref(sim.issues[0], "acme/web#1")))).toMatchObject({ kind: "invalid", message: expect.stringContaining("timelogs") });
  });
});

describe("gitlab, time notes", () => {
  it("reads lengths as GitLab writes them (a day of 8 hours, a week of 5 days)", () => {
    expect(parseDuration("1h 30m")).toBe(5400);
    expect(parseDuration("1d 1h")).toBe(9 * 3600);
    expect(parseDuration("1w")).toBe(40 * 3600);
    expect(parseDuration("1mo 2s")).toBe(160 * 3600 + 2);
    expect(parseDuration("soon")).toBeNull();
    expect(spendDuration(5400)).toBe("1h30m");
    expect(spendDuration(9 * 3600 + 5)).toBe("9h5s");
  });

  it("tells time notes from the others", () => {
    expect(parseSpendNote("added 1h 30m of time spent at 2026-10-21")).toEqual({ kind: "added", seconds: 5400, date: "2026-10-21" });
    expect(parseSpendNote("subtracted 30m of time spent")).toEqual({ kind: "subtracted", seconds: 1800, date: null });
    expect(parseSpendNote("removed time spent")).toEqual({ kind: "reset" });
    expect(parseSpendNote("changed the description")).toBeNull();
  });

  it("an entry taken back is the latest of the same person, length and day; a reset takes them all", () => {
    const issue = { id: 1, iid: 1, project_id: 2, references: { full: "a/b#1" } } as Parameters<typeof entriesOfNotes>[0];
    const u = (id: number) => ({ id, username: `u${id}` });
    const n = (id: number, body: string, by = 1, system = true) => ({ id, body, author: u(by), created_at: `2026-10-21T0${id}:00:00Z`, updated_at: "", system });
    const ids = (notes: ReturnType<typeof n>[]) => entriesOfNotes(issue, notes).map((e) => e.remoteId);
    expect(ids([n(1, "added 1h of time spent at 2026-10-20"), n(2, "added 1h of time spent at 2026-10-20"), n(3, "added 1h of time spent at 2026-10-20", 2), n(4, "subtracted 1h of time spent at 2026-10-20")])).toEqual(["n1", "n3"]);
    expect(ids([n(1, "added 1h of time spent at 2026-10-20"), n(2, "removed time spent"), n(3, "added 30m of time spent at 2026-10-20")])).toEqual(["n3"]);
    // A comment that reads like one is not.
    expect(ids([n(1, "added 1h of time spent at 2026-10-20", 1, false)])).toEqual([]);
  });
});

describe("gitlab, webhooks", () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it("accepts the delivery whose X-Gitlab-Token is the secret, and refuses any other", () => {
    expect(gitlabWebhook.verify(headers({ "x-gitlab-token": "s3cret" }), "s3cret")).toBe(true);
    expect(gitlabWebhook.verify(headers({ "x-gitlab-token": "s3cret2" }), "s3cret")).toBe(false);
    expect(gitlabWebhook.verify(headers({ "x-gitlab-token": "" }), "s3cret")).toBe(false);
    expect(gitlabWebhook.verify(headers({}), "s3cret")).toBe(false);
    // A hook with no secret set is open to anyone: never accepted.
    expect(gitlabWebhook.verify(headers({}), "")).toBe(false);
    expect(gitlabWebhook.verify(headers({ "x-gitlab-token": "" }), "")).toBe(false);
  });

  it("names the delivery, its moment (both date formats) and its event", () => {
    expect(gitlabWebhook.deliveryId(headers({ "x-gitlab-event-uuid": "u-1", "idempotency-key": "i-1" }))).toBe("u-1");
    expect(gitlabWebhook.deliveryId(headers({ "idempotency-key": "i-1" }))).toBe("i-1");
    expect(gitlabWebhook.deliveryId(headers({}))).toBeNull();
    const at = Date.UTC(2026, 9, 21, 10, 0, 0);
    expect(gitlabWebhook.sentAt({ object_attributes: { updated_at: "2026-10-21 10:00:00 UTC" } })).toBe(at);
    expect(gitlabWebhook.sentAt({ object_attributes: { updated_at: "2026-10-21T10:00:00.000Z" } })).toBe(at);
    expect(gitlabWebhook.sentAt({ object_attributes: { updated_at: "2026-10-21 12:00:00 +0200" } })).toBe(at);
    expect(gitlabWebhook.sentAt({})).toBeNull();
    expect(gitlabWebhook.event(headers({ "x-gitlab-event": "Issue Hook" }), {})).toBe("issueChanged");
    expect(gitlabWebhook.event(headers({ "x-gitlab-event": "Note Hook" }), { object_attributes: { noteable_type: "Issue" } })).toBe("commentAdded");
    expect(gitlabWebhook.event(headers({ "x-gitlab-event": "Note Hook" }), { object_attributes: { noteable_type: "MergeRequest" } })).toBeNull();
    expect(gitlabWebhook.event(headers({ "x-gitlab-event": "Push Hook" }), {})).toBeNull();
  });
});

describe("gitlab, errors and limits", () => {
  it("a bad token is auth (401)", async () => {
    const { b } = simulated({ token: "glpat-wrong" });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "auth" });
  });

  it("a revoked token is auth on every call", async () => {
    const { b, sim } = simulated();
    expect((await b.verify(meta())).remoteId).toBe(String(sim.me.id));
    sim.revoke();
    expect(await errorOf(pass(b))).toMatchObject({ kind: "auth" });
  });

  it("an exhausted quota is a wait: 429 with Retry-After, plain text body and all", async () => {
    const { b, sim } = simulated();
    sim.exhaust();
    const err = await errorOf(b.verify(meta()));
    expect(err).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 30_000, remaining: 0 } });
    sim.refill();
    expect((await b.verify(meta())).name).toBe("Mario Rossi");
  });

  it("a missing issue is notFound where an operation needs it, null where a lookup asks", async () => {
    const { b } = simulated();
    const ghost = { remoteId: "1", key: "acme/web#404" };
    expect(await b.getIssue(meta(), ghost)).toBeNull();
    expect(await errorOf(b.transitions!.list!(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.watch!(meta(), ghost, true))).toMatchObject({ kind: "notFound" });
  });

  it("validation errors come with their fields", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.issues[0], "acme/web#1");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: { state_event: ["is invalid"] } }), { status: 400 }));
    const err = await errorOf(b.transitions!.apply!(meta(), r, "close", {}));
    expect(err).toMatchObject({ kind: "invalid", fields: { state_event: "is invalid" } });
  });

  it("knows who the token belongs to, and the budget the headers show (per minute, as per hour)", async () => {
    const { b, sim } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: String(sim.me.id), name: "Mario Rossi", handle: "mrossi", login: "mrossi" });
    expect((await b.probe(meta())).rateLimit).toEqual({ perHour: 120_000, origin: "detected" });
  });
});

describe("gitlab, a write that may not leave", () => {
  it("says why in GitLab's own name: this connection's writes off, never the Jira text", async () => {
    const { conn, sim } = simulated();
    const b = bindTracker(gitlabProvider, { ...conn, writable: false });
    const err = await errorOf(b.transitions!.apply!(meta(), ref(sim.issues[0], "acme/web#1"), "close", {}));
    expect(err).toMatchObject({ kind: "readOnly" });
    expect(err?.message).toContain("Allow changes on GitLab");
    expect(err?.message).not.toMatch(/Jira/);
  });

  it("on a read-only server: the server's flag, and the service named", async () => {
    vi.stubEnv("PROVIDERS_READ_ONLY", "1");
    vi.resetModules();
    const { gitlabProvider: fresh } = await import("./adapter");
    const { bindTracker: bind } = await import("../core/bind");
    const { conn, sim } = simulated();
    const err = await errorOf(bind(fresh, conn).transitions!.apply!(meta(), ref(sim.issues[0], "acme/web#1"), "close", {}));
    expect(err).toMatchObject({ kind: "readOnly" });
    expect(err?.message).toBe("This server is read-only (PROVIDERS_READ_ONLY): nothing is sent to GitLab");
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

statusHistoryConformance("gitlab (simulated, scoped label workflow)", async () => {
  const { sim, b } = simulated({ options: WORKFLOW });
  const i = sim.issues[0];
  return { b, ref: ref(i, "acme/web#1"), moveTwice: () => (sim.outside.label(i, "workflow::doing"), sim.outside.close(i)) };
});

describe("gitlab, status history", () => {
  it("a composite status is replayed as the app computes it", async () => {
    const { sim, b } = simulated({ options: WORKFLOW });
    const i = sim.issues[0];
    sim.outside.label(i, "workflow::doing");
    sim.outside.close(i);
    sim.outside.reopen(i);
    const steps = await b.statusHistory!(meta(), ref(i, "acme/web#1"));
    expect(steps.map((s) => [s.from?.id, s.to.id])).toEqual([
      ["opened", "doing"],
      ["doing", "closed"],
      ["closed", "doing"],
    ]);
  });

  it("workflow labels its events don't show make the history unreadable", async () => {
    const { sim, b } = simulated({ options: WORKFLOW });
    // Labelled at creation, with no event of it.
    const i = sim.add("acme/web", "Born in review", { labels: ["workflow::review"] });
    sim.outside.close(i);
    await expect(b.statusHistory!(meta(), ref(i, `acme/web#${i.iid}`))).rejects.toMatchObject({ kind: "incompatible" });
  });
});
