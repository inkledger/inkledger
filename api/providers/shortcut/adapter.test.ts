import { afterEach, describe, expect, it, vi } from "vitest";
import { timeZone } from "@contracts/values";
import type { Credential } from "../types";
import { bindTracker } from "../core/bind";
import { encodePageToken } from "../core/checkpoint";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import { searchPathOf } from "./client";
import { shortcutSimulator } from "./simulator";
import { shortcutProvider } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "104.18.0.1", family: 4 }]),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });

const OPS_STATES: [string, string][] = [
  ["Da fare", "unstarted"],
  ["In revisione", "started"],
  ["Chiuso", "done"],
];

function simulated(o: { credential?: () => Promise<Credential>; zone?: string; baseUrl?: string } = {}) {
  const sim = shortcutSimulator();
  sim.addWorkflow("Ops", OPS_STATES);
  const login = sim.add("Login fails on Safari", { description: "Steps:\n\n1. open\n2. **fail**", type: "bug", estimate: 3, deadline: "2026-10-30", labels: ["bug"] });
  const csv = sim.add("Export to CSV");
  const others = sim.add("Someone else's", { owners: [sim.otherId] });
  const certs = sim.add("Rotate certificates", { workflow: "Ops", state: "In revisione" });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 9,
    userId: 1,
    type: "shortcut" as const,
    baseUrl: o.baseUrl ?? sim.apiBase,
    remoteAccountId: sim.meId,
    options: {},
    timeZone: timeZone(o.zone ?? "Europe/Rome"),
    credential: o.credential ?? (async () => ({ kind: "token", token: sim.token }) as const),
  };
  return { sim, conn, b: bindTracker(shortcutProvider, conn), login, csv, others, certs };
}

const refOf = (s: { id: number }) => ({ remoteId: String(s.id), key: `sc-${s.id}` });

trackerConformance("shortcut (simulated)", async () => {
  const { conn, sim, login } = simulated();
  return { provider: shortcutProvider, conn, key: sim.keyOf(login), writable: true, url: sim.urlOf(login) };
});

describe("shortcut, as the layer sees it", () => {
  it("lists the stories the user owns, keyed sc-<id>, with the workflow state and its category", async () => {
    const { b, sim, login, csv, certs } = simulated();
    const all = await readPass((q) => b.listChanged(meta(), q), null);
    // Newest first: the search has no other order.
    expect(all.items.map((i) => [i.key, i.status.name, i.status.category])).toEqual([
      [sim.keyOf(certs), "In revisione", "doing"],
      [sim.keyOf(csv), "Backlog", "backlog"],
      [sim.keyOf(login), "Backlog", "backlog"],
    ]);
    expect(all.items.every((i) => i.status.source.kind === "itemState" && i.container.kind === "x-workflow")).toBe(true);
    expect(all.items.map((i) => i.container.name)).toEqual(["Ops", "Default", "Default"]);
    expect(all.gone).toEqual([]);
    // The public id is the identity; the key only spells it.
    expect(all.items.find((i) => i.key === sim.keyOf(login))?.remoteId).toBe(String(login.id));
    expect(all.items.find((i) => i.key === sim.keyOf(login))?.url).toBe(sim.urlOf(login));
  });

  it("asks the search for the user's mention name, not the member id (owner: takes names)", async () => {
    const { b, sim } = simulated();
    await readPass((q) => b.listChanged(meta(), q), null);
    const search = sim.calls.find((c) => c.path.includes("/search/stories"))!;
    expect(decodeURIComponent(search.path)).toContain("query=owner:mario");
    expect(search.path).not.toContain(sim.meId);
    // Every call carries the token as Shortcut-Token, never as Authorization.
    expect(sim.calls.every((c) => c.token === sim.token && c.authorization === null)).toBe(true);
  });

  it("reads type, labels, points, owners, requester and the parent as Shortcut keeps them", async () => {
    const { b, sim, login } = simulated();
    const sub = sim.add("Fix the Safari cookie", { parent: login.id, owners: [sim.meId, sim.otherId] });
    const i = await b.findIssue(meta(), { key: sim.keyOf(login) });
    if (i.kind !== "found") throw new Error("not found");
    expect(i.issue.type).toEqual({ id: "bug", name: "Bug", level: "standard" });
    expect(i.issue.labels).toEqual(["bug"]);
    expect(i.issue.assignees.map((a) => [a.name, a.handle])).toEqual([["Mario Rossi", "mario"]]);
    expect(i.issue.reporter?.name).toBe("Mario Rossi");
    // Points are not time: a field, never estimateSeconds.
    expect(i.issue.estimateSeconds).toBeNull();
    expect(i.issue.fields).toEqual({ estimate: 3 });
    const child = await b.getIssue(meta(), refOf(sub));
    expect(child?.type.level).toBe("sub");
    expect(child?.parent).toEqual({ remoteId: String(login.id), key: sim.keyOf(login) });
    // Several owners: all of them.
    expect(child?.assignees.map((a) => a.name)).toEqual(["Mario Rossi", "Anna Bianchi"]);
  });

  it("keeps a deadline as the day it says (a date-time at midnight UTC), whatever the user's zone or the hour", async () => {
    const { b, login } = simulated({ zone: "America/Los_Angeles" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 30, 2, 0));
    const i = await b.getIssue(meta(), refOf(login));
    expect(i?.due).toBe("2026-10-30");
    expect((await b.getIssue(meta(), refOf(simulated().csv)))?.due).toBeNull();
  });

  it("a story never changed has no update time: it is dated by its creation, and is listed", async () => {
    const { b, sim, login } = simulated();
    const raw = sim.shown(login);
    expect(raw.updated_at).toBeNull();
    const i = await b.getIssue(meta(), refOf(login));
    expect(i?.updatedAt).toBe(i?.createdAt);
    expect(i?.statusChangedAt).toBeNull();
    expect((await readPass((q) => b.listChanged(meta(), q), null)).items.map((s) => s.remoteId)).toContain(String(login.id));
  });

  it("dates when a state was entered by the story's moved_at", async () => {
    const { b, sim, csv } = simulated();
    sim.outside.setState(csv.id, "Done");
    const done = await b.getIssue(meta(), refOf(csv));
    expect(done?.status).toMatchObject({ name: "Done", category: "done" });
    expect(done?.statusChangedAt).toBe(csv.moved);
  });

  it("pages by the search's own cursor, 25 at a time: `next` is a path with /api/v3 in it, followed as given", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 60; n++) sim.add(`Bulk ${n}`);
    const total = sim.stories.filter((s) => s.owners.includes(sim.meId)).length;
    const full = await readPass((q) => b.listChanged(meta(), q), null);
    expect(full.pages).toBe(Math.ceil(total / 25));
    expect(full.items).toHaveLength(total);
    expect(new Set(full.items.map((i) => i.remoteId)).size).toBe(total);
    const pages = sim.calls.filter((c) => c.path.includes("/search/stories"));
    expect(pages.every((c) => !c.path.includes("/api/v3/api/v3") && c.path.startsWith("/api/v3/search/stories?"))).toBe(true);
    expect(pages.every((c) => new URL(`https://x${c.path}`).searchParams.get("page_size") === "25")).toBe(true);
  });

  it("a search page is at most 25: the simulator refuses 26, and the adapter never asks for more", async () => {
    const { sim, b } = simulated();
    const res = await sim.fetch(`${sim.apiBase}/api/v3/search/stories?query=x&page_size=26`, { headers: { "Shortcut-Token": sim.token } });
    expect(res.status).toBe(400);
    sim.calls.length = 0;
    await b.searchText!(meta(), "safari", 500);
    expect(sim.calls.filter((c) => c.path.includes("/search/stories")).every((c) => Number(new URL(`https://x${c.path}`).searchParams.get("page_size")) <= 25)).toBe(true);
  });

  it("reads only what changed since a checkpoint: `updated:` counts UTC days, the exact cut is the story's own time", async () => {
    const { b, sim, login, csv } = simulated({ zone: "Pacific/Auckland" });
    vi.useFakeTimers({ toFake: ["Date"] });
    // Early on the day: changed, and long before the checkpoint.
    vi.setSystemTime(Date.UTC(2027, 0, 15, 10, 0));
    sim.outside.retitle(login.id, "Login fails on Safari 18");
    vi.setSystemTime(Date.UTC(2027, 0, 15, 23, 50));
    const first = await readPass((q) => b.listChanged(meta(), q), null);
    expect(first.items).toHaveLength(3);
    // After the checkpoint, still the same UTC day (already the 16th in the user's zone).
    vi.setSystemTime(Date.UTC(2027, 0, 15, 23, 58));
    sim.outside.setState(csv.id, "In Progress");
    vi.setSystemTime(Date.UTC(2027, 0, 15, 23, 59));
    sim.calls.length = 0;
    const next = await readPass((q) => b.listChanged(meta(), q), first.checkpoint);
    expect(next.items.map((i) => [i.key, i.status.category])).toEqual([[sim.keyOf(csv), "doing"]]);
    const query = decodeURIComponent(sim.calls.find((c) => c.path.includes("/search/stories"))!.path);
    expect(query).toContain("updated:2027-01-15..*");
    expect(next.checkpoint).not.toBe(first.checkpoint);
  });

  it("reports an archived story as deleted, brings it back when unarchived, and reads archived ones on request", async () => {
    const { b, sim, csv, login } = simulated();
    vi.useFakeTimers({ toFake: ["Date"] });
    sim.outside.archive(login.id);
    // A first read has nothing to take away: the archived story is simply not listed.
    const again = await readPass((q) => b.listChanged(meta(), q), null);
    expect(again.gone).toEqual([]);
    expect(again.items.map((i) => i.remoteId)).not.toContain(String(login.id));
    sim.outside.unarchive(login.id);

    vi.setSystemTime(sim.now() + 10 * 60_000);
    const first = await readPass((q) => b.listChanged(meta(), q), null);
    expect(first.items.map((i) => i.remoteId)).toContain(String(csv.id));
    vi.setSystemTime(sim.now() + 10 * 60_000);
    sim.outside.archive(csv.id);
    vi.setSystemTime(sim.now() + 1000);
    const next = await readPass((q) => b.listChanged(meta(), q), first.checkpoint);
    expect(next.items).toEqual([]);
    expect(next.gone).toEqual([{ remoteId: String(csv.id), reason: "deleted" }]);
    // The archived story is still readable.
    expect((await b.getIssue(meta(), refOf(csv)))?.key).toBe(sim.keyOf(csv));
    // Unarchived, it is back in the feed.
    sim.outside.unarchive(csv.id);
    vi.setSystemTime(sim.now() + 1000);
    const back = await readPass((q) => b.listChanged(meta(), q), next.checkpoint);
    expect(back.items.map((i) => i.remoteId)).toEqual([String(csv.id)]);
  });

  it("a hard-deleted story is a 404, never in a feed: getIssue says null and findIssue none", async () => {
    const { b, sim, csv } = simulated();
    sim.outside.delete(csv.id);
    expect(await b.getIssue(meta(), refOf(csv))).toBeNull();
    expect((await b.findIssue(meta(), { key: sim.keyOf(csv) })).kind).toBe("none");
    const pass = await readPass((q) => b.listChanged(meta(), q), null);
    expect(pass.items.map((i) => i.remoteId)).not.toContain(String(csv.id));
    // The feed cannot tell why it is gone: the webhook or a reconciliation does.
    expect(pass.gone).toEqual([]);
    await expect(b.comments!.list(meta(), refOf(csv))).rejects.toMatchObject({ kind: "notFound" });
  });

  it("parses keys and web links, finds the story, and keeps its identity through a move to another workflow", async () => {
    const { b, sim, login } = simulated();
    expect(b.normalizeKey("SC-12")).toBe("sc-12");
    expect(b.normalizeKey("sc-007")).toBe("sc-7");
    expect(b.normalizeKey("sc12")).toBeNull();
    expect(b.normalizeKey("ENG-12")).toBeNull();
    // The slug follows the name: only the id counts.
    expect(b.parseRef("https://app.shortcut.com/acme/story/123/a-name-since-renamed")).toEqual({ key: "sc-123" });
    expect(b.parseRef("https://app.shortcut.com/acme/story/123")).toEqual({ key: "sc-123" });
    expect(b.parseRef("https://app.shortcut.com/acme/story/123/slug?vc_group_by=day#x")).toEqual({ key: "sc-123" });
    // An epic has its own ids: sc-<epic id> would be another story.
    expect(b.parseRef("https://app.shortcut.com/acme/epic/123")).toBeNull();
    expect(b.parseRef("http://app.shortcut.com/acme/story/123")).toBeNull();
    expect(b.parseRef("https://example.com/acme/story/123")).toBeNull();

    const before = await b.findIssue(meta(), { key: sim.keyOf(login) });
    if (before.kind !== "found") throw new Error("not found");
    sim.outside.moveToWorkflow(login.id, "Ops");
    const after = await b.findIssue(meta(), { key: sim.keyOf(login) });
    // Same id, same key; the workflow (container, status source) is what changed.
    expect(after.kind === "found" && [after.issue.remoteId, after.issue.key, after.issue.container.name, after.issue.status.name]).toEqual([before.issue.remoteId, before.issue.key, "Ops", "Da fare"]);
    expect(after.kind === "found" && after.issue.status.source).toEqual({ kind: "itemState", containerRemoteId: String(sim.workflow("Ops").id) });
  });

  it("maps every state type to a category by the type and never by name, per workflow; there is no cancelled", async () => {
    const { b, sim } = simulated();
    const sources = (await b.probe(meta())).activeSources;
    expect(sources.map((s) => [s.name, s.ref])).toEqual([
      ["Default", { kind: "itemState", containerRemoteId: String(sim.workflow("Default").id) }],
      ["Ops", { kind: "itemState", containerRemoteId: String(sim.workflow("Ops").id) }],
    ]);
    const def = await b.statuses!(meta(), sources[0]);
    expect(def.map((s) => [s.name, s.category])).toEqual([
      ["Backlog", "backlog"],
      ["To Do", "todo"],
      ["In Progress", "doing"],
      ["In Review", "doing"],
      ["Done", "done"],
    ]);
    // An Italian workflow: its own words, the same categories.
    const ops = await b.statuses!(meta(), sources[1]);
    expect(ops.map((s) => [s.name, s.category])).toEqual([
      ["Da fare", "todo"],
      ["In revisione", "doing"],
      ["Chiuso", "done"],
    ]);
    expect(def[0].source).toEqual({ kind: "itemState", containerRemoteId: String(sim.workflow("Default").id) });
    expect(def.every((s) => s.categoryOrigin.by === "native")).toBe(true);
    // Without a source, every workflow's states.
    expect(await b.statuses!(meta(), { kind: "itemState", transitions: "direct", ref: { kind: "itemState" }, name: "all" })).toHaveLength(8);
    const probe = await b.probe(meta());
    expect(probe.rateLimit).toEqual({ perHour: 12000, origin: "typical" });
  });

  it("a state it can't find (its workflow archived) falls back on what the story's own flags say", async () => {
    const { sim, conn, csv } = simulated();
    sim.outside.setState(csv.id, "Done");
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const res = await sim.fetch(input, init);
      if (!/\/stories\/\d+$/.test(new URL(input).pathname)) return res;
      return new Response(JSON.stringify({ ...((await res.json()) as object), workflow_state_id: 999_999 }), { status: 200 });
    });
    const i = await bindTracker(shortcutProvider, conn).getIssue(meta(), refOf(csv));
    expect(i?.status).toMatchObject({ id: "999999", name: "State 999999", category: "done" });
  });

  it("offers the other states of the story's workflow, moves along one, and refuses a state of another workflow", async () => {
    const { b, sim, certs, csv } = simulated();
    const ref = refOf(certs);
    const ways = await b.transitions!.list!(meta(), ref);
    expect(ways.map((t) => [t.name, t.to.category])).toEqual([
      ["Da fare", "todo"],
      ["Chiuso", "done"],
    ]);
    expect(ways.every((t) => t.requirements.length === 0 && t.remoteUrl === sim.urlOf(certs))).toBe(true);
    const closed = await b.transitions!.apply!(meta(), ref, ways[1].id, {});
    expect(closed?.status).toMatchObject({ name: "Chiuso", category: "done" });
    expect(closed?.statusChangedAt).not.toBeNull();

    // A state of another workflow, and one that isn't a state: Shortcut's validation error.
    const other = String(sim.workflow("Default").states[0].id);
    await expect(b.transitions!.apply!(meta(), ref, other, {})).rejects.toMatchObject({ kind: "invalid", message: expect.stringContaining("does not belong") });
    await expect(b.transitions!.apply!(meta(), ref, "12", {})).rejects.toMatchObject({ kind: "invalid" });
    await expect(b.transitions!.apply!(meta(), ref, "done", {})).rejects.toMatchObject({ kind: "invalid" });
    expect((await b.transitions!.list!(meta(), refOf(csv))).map((t) => t.name)).toEqual(["To Do", "In Progress", "In Review", "Done"]);
  });

  it("reads the description as CommonMark (none when blank) and comments, leaving out the deleted ones, and writes comments", async () => {
    const { b, sim, login, csv } = simulated();
    const ref = refOf(login);
    expect(await b.description!(meta(), ref)).toEqual({ kind: "text", format: "commonmark", text: "Steps:\n\n1. open\n2. **fail**" });
    expect(await b.description!(meta(), refOf(csv))).toBeNull();
    csv.description = "  \n";
    expect(await b.description!(meta(), refOf(csv))).toBeNull();

    sim.outside.comment(login.id, "Deployed to staging", { by: null, external: "github" });
    const gone = sim.outside.comment(login.id, "Oops, wrong story");
    sim.outside.comment(login.id, "From someone since removed", { by: "ffffffff-0000-4000-8000-000000000000" });
    sim.outside.deleteComment(login.id, gone.id);
    const added = await b.comments!.add!(meta(), ref, "Looks **fixed**" as never, { idempotencyKey: "c1" });
    expect(added.warnings).toEqual([]);
    expect(added.comment?.author.name).toBe("Mario Rossi");
    const list = await b.comments!.list(meta(), ref);
    // Deleted comments are listed by Shortcut, marked; an integration has no author; a stranger keeps their id.
    expect(list.map((c) => [c.author.name, c.body])).toEqual([
      ["Shortcut", { kind: "text", format: "commonmark", text: "Deployed to staging" }],
      ["ffffffff-0000-4000-8000-000000000000", { kind: "text", format: "commonmark", text: "From someone since removed" }],
      ["Mario Rossi", { kind: "text", format: "commonmark", text: "Looks **fixed**" }],
    ]);
    expect(list[0].author.remoteId).toBe("external:github");
    await expect(b.comments!.list(meta(), { remoteId: "99999", key: "sc-99999" })).rejects.toMatchObject({ kind: "notFound" });
    await expect(b.comments!.list(meta(), { remoteId: "nope", key: "ENG-1" })).rejects.toMatchObject({ kind: "notFound" });
  });

  it("follows and unfollows without dropping the other followers (follower_ids replaces the list); a repeat writes nothing", async () => {
    const { b, sim, login } = simulated();
    const ref = refOf(login);
    sim.outside.follow(login.id, sim.otherId);
    await b.watch!(meta(), ref, true);
    expect(login.followers).toEqual([sim.otherId, sim.meId]);
    const puts = () => sim.calls.filter((c) => c.method === "PUT").length;
    const done = puts();
    await b.watch!(meta(), ref, true);
    expect(puts()).toBe(done);
    await b.watch!(meta(), ref, false);
    expect(login.followers).toEqual([sim.otherId]);
    await b.watch!(meta(), ref, false);
    expect(puts()).toBe(done + 1);
  });

  it("tells a story's history field by field, oldest first, resolving ids to names", async () => {
    const { b, sim, login } = simulated();
    sim.outside.setState(login.id, "In Progress");
    sim.outside.retitle(login.id, "Login fails everywhere");
    sim.outside.label(login.id, "ui");
    sim.outside.assign(login.id, [sim.otherId]);
    sim.outside.archive(login.id);
    const changes = await b.history!(meta(), refOf(login));
    expect(changes.map((c) => c.field.id)).toEqual(["workflow_state_id", "name", "label_ids", "owner_ids", "archived"]);
    expect(changes[0]).toMatchObject({ field: { name: "Status" }, from: [{ text: "Backlog" }], to: [{ text: "In Progress" }], actor: { name: "Anna Bianchi" } });
    expect(changes[1]).toMatchObject({ from: [{ text: "Login fails on Safari" }], to: [{ text: "Login fails everywhere" }] });
    expect(changes[2]).toMatchObject({ from: [], to: [{ text: "ui" }] });
    expect(changes[3]).toMatchObject({ from: [{ text: "Mario Rossi" }], to: [{ text: "Anna Bianchi" }] });
    expect(changes[4]).toMatchObject({ from: [{ text: "no" }], to: [{ text: "yes" }] });
    expect(changes.map((c) => c.at)).toEqual([...changes.map((c) => c.at)].sort((a, c) => a - c));
    sim.outside.moveToWorkflow(login.id, "Ops");
    const moved = (await b.history!(meta(), refOf(login))).filter((c) => c.field.id === "workflow_id");
    expect(moved).toMatchObject([{ from: [{ text: "Default" }], to: [{ text: "Ops" }] }]);
  });

  it("searches the workspace's stories by text, 25 a page, archived ones left out; a word that looks like an operator is only text", async () => {
    const { b, sim } = simulated();
    expect((await b.searchText!(meta(), "csv", 10)).items.map((i) => i.title)).toEqual(["Export to CSV"]);
    // Not just the user's own: the search sees what the token sees.
    expect((await b.searchText!(meta(), "someone", 10)).items.map((i) => i.title)).toEqual(["Someone else's"]);
    // owner:anna would be an operator; here it is the words of a title.
    sim.add("Ask owner:anna about -fix and (parens)");
    const odd = await b.searchText!(meta(), "owner:anna -fix (parens)", 10);
    expect(odd.items.map((i) => i.title)).toEqual(["Ask owner:anna about -fix and (parens)"]);
    expect((await b.searchText!(meta(), "foo:bar", 10)).items).toEqual([]);
    // The simulator, like the search, refuses an operator it doesn't know.
    const raw = await sim.fetch(`${sim.apiBase}/api/v3/search/stories?query=${encodeURIComponent("foo:bar")}`, { headers: { "Shortcut-Token": sim.token } });
    expect(raw.status).toBe(400);
    expect((await b.searchText!(meta(), "   ", 10))).toEqual({ items: [], complete: true });

    for (let n = 0; n < 30; n++) sim.add(`Bulk ${n}`);
    const some = await b.searchText!(meta(), "bulk", 10);
    expect(some.items).toHaveLength(10);
    expect(some.complete).toBe(false);
    const many = await b.searchText!(meta(), "bulk", 100);
    expect(many.items).toHaveLength(30);
    expect(many.complete).toBe(true);
    sim.outside.archive(sim.stories.find((s) => s.title === "Bulk 0")!.id);
    expect((await b.searchText!(meta(), "bulk", 100)).items).toHaveLength(29);
  });

  it("says who the token belongs to from /member (names at the top level) and adds what /members knows; it works without the list", async () => {
    const { b, sim, conn } = simulated();
    const me = await b.verify(meta());
    expect(me).toMatchObject({ remoteId: sim.meId, name: "Mario Rossi", handle: "mario", login: "mario", email: "mario@acme.example", avatarUrl: "https://avatars.example/mario.png" });
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => (new URL(input).pathname.endsWith("/members") ? new Response("{}", { status: 403 }) : sim.fetch(input, init)));
    const bare = await bindTracker(shortcutProvider, conn).verify(meta());
    expect(bare).toMatchObject({ remoteId: sim.meId, name: "Mario Rossi" });
    expect(bare).not.toHaveProperty("email");
  });

  it("names people it can't find by their id, and survives a token that can't list members", async () => {
    const { sim, conn, login } = simulated();
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => (new URL(input).pathname.endsWith("/members") ? new Response("{}", { status: 403 }) : sim.fetch(input, init)));
    const i = await bindTracker(shortcutProvider, conn).getIssue(meta(), refOf(login));
    expect(i?.assignees).toEqual([{ remoteId: sim.meId, name: sim.meId }]);
  });

  it("keeps time in inkledger: no query language, no worklogs", () => {
    expect(shortcutProvider.capabilities.time).toEqual({ mode: "local", remoteTotals: false });
    expect(shortcutProvider.worklogs).toBeUndefined();
    expect("query" in shortcutProvider).toBe(false);
    expect("translate" in shortcutProvider).toBe(false);
  });
});

describe("shortcut, the traps of its API", () => {
  it("a bad token is an auth error, whatever the call", async () => {
    const { b } = simulated({ credential: async () => ({ kind: "token", token: "revoked" }) });
    await expect(b.verify(meta())).rejects.toMatchObject({ kind: "auth", status: 401 });
    await expect(readPass((q) => b.listChanged(meta(), q), null)).rejects.toMatchObject({ kind: "auth" });
  });

  it("a revoked token stops working at once", async () => {
    const { b, sim } = simulated();
    await b.verify(meta());
    sim.revoke();
    await expect(b.verify(meta())).rejects.toMatchObject({ kind: "auth" });
  });

  it("a missing story is notFound on the calls that need it, null or none when looked up", async () => {
    const { b } = simulated();
    expect(await b.getIssue(meta(), { remoteId: "99999", key: "sc-99999" })).toBeNull();
    expect((await b.findIssue(meta(), { key: "sc-99999" })).kind).toBe("none");
    await expect(b.transitions!.list!(meta(), { remoteId: "99999", key: "sc-99999" })).rejects.toMatchObject({ kind: "notFound" });
    await expect(b.watch!(meta(), { remoteId: "99999", key: "sc-99999" }, true)).rejects.toMatchObject({ kind: "notFound" });
    expect(await b.description!(meta(), { remoteId: "99999", key: "sc-99999" })).toBeNull();
  });

  it("the 200 requests a minute: a spent budget is a 429 with Retry-After, a wait and not a refusal", async () => {
    const { b, sim } = simulated();
    sim.outside.rateLimit(1);
    const err = await b.verify(meta()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rateLimit", status: 429, transient: true });
    const wait = (err as { rateLimit?: { retryAfterMs?: number; remaining?: number; resetAt?: number } }).rateLimit;
    expect(wait).toMatchObject({ retryAfterMs: 30_000, remaining: 0 });
    expect(wait?.resetAt).toBeGreaterThan(Date.now());
    // The next call goes through.
    expect((await b.verify(meta())).remoteId).toBe(sim.meId);

    // The real window: a third call within the minute waits for the first to leave it.
    const tight = simulated();
    tight.sim.state.perMinute = 2;
    await tight.b.verify(meta());
    const spent = (await tight.b.verify(meta()).catch((e: unknown) => e)) as { kind: string; rateLimit?: { retryAfterMs?: number } };
    expect(spent.kind).toBe("rateLimit");
    expect(spent.rateLimit?.retryAfterMs).toBeGreaterThan(0);
    expect(spent.rateLimit?.retryAfterMs).toBeLessThanOrEqual(60_000);

    // No Retry-After: a minute.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "slow down" }), { status: 429 }));
    expect(await b.verify(meta()).catch((e: unknown) => e)).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 60_000 } });
  });

  it("validation errors come as a list of messages; a server error is unavailable", async () => {
    const { b, certs } = simulated();
    const err = await b.transitions!.apply!(meta(), refOf(certs), "5", {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "invalid", status: 400, message: expect.stringContaining("Unprocessable: workflow_state_id") });
    vi.stubGlobal("fetch", async () => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(b.verify(meta())).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("refuses a checkpoint of another format, and a page token that leads anywhere but the search", async () => {
    const { b, conn, sim } = simulated();
    await expect(b.listChanged(meta(), { since: "cp1.eyJ9" as never, page: null })).rejects.toMatchObject({ kind: "invalidCheckpoint" });
    for (const next of ["https://evil.example/api/v3/search/stories?query=x", "/api/v3/stories/1", "/somewhere/else"]) {
      const page = encodePageToken(conn, "issues", 1, null, { phase: "feed", next, mention: "mario", at: 1 });
      sim.calls.length = 0;
      await expect(b.listChanged(meta(), { since: null, page })).rejects.toMatchObject({ kind: "invalidCheckpoint" });
      expect(sim.calls).toEqual([]);
    }
    const c = { apiBase: "https://api.app.shortcut.com", token: "t" };
    expect(searchPathOf(c, "https://api.app.shortcut.com/api/v3/search/stories?next=abc")).toBe("/api/v3/search/stories?next=abc");
    expect(searchPathOf(c, "/api/v3/search/stories?next=abc")).toBe("/api/v3/search/stories?next=abc");
    expect(searchPathOf(c, "https://other.example/api/v3/search/stories?next=abc")).toBeNull();
  });

  it("an API base that already ends in /api/v3 works the same", async () => {
    const { b, sim, login } = simulated({ baseUrl: "https://api.app.shortcut.com/api/v3/" });
    expect((await b.getIssue(meta(), refOf(login)))?.key).toBe(sim.keyOf(login));
    expect(sim.calls.every((c) => c.path.startsWith("/api/v3/") && !c.path.includes("/api/v3/api/v3"))).toBe(true);
  });

  it("never reaches an internal address: Shortcut is a service on the internet", async () => {
    const { b } = simulated({ baseUrl: "http://127.0.0.1:8080" });
    await expect(b.verify(meta())).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("shortcut webhooks", () => {
  const secret = "sc_wh_secret";
  const actions = [{ id: 1, entity_type: "story", action: "update", name: "Login fails on Safari" }];
  const req = (d: { rawBody: string; headers: Record<string, string> }) => ({ headers: d.headers, body: d.rawBody });
  const hook = shortcutProvider.webhook!;

  it("accepts a delivery signed with the secret, and reads its id and time", () => {
    const { sim } = simulated();
    const d = sim.webhook(actions, { secret });
    expect(hook.verify(req(d), secret)).toBe(true);
    expect(hook.deliveryId(req(d))).toMatch(/^[0-9a-f-]{36}$/);
    const sent = hook.sentAt!(req(d))!;
    expect(Math.abs(sent - Date.now())).toBeLessThan(5000);
    const old = sim.webhook(actions, { secret, ageMs: 600_000 });
    expect(hook.sentAt!(req(old))! + 600_000).toBeLessThanOrEqual(Date.now() + 5);
    expect(hook.sentAt!({ headers: {}, body: "not json" })).toBeNull();
    expect(hook.sentAt!({ headers: {}, body: JSON.stringify({ changed_at: "yesterday" }) })).toBeNull();
    expect(hook.deliveryId({ headers: {}, body: "{}" })).toBeNull();
    expect(hook.deliveryId({ headers: {}, body: "[" })).toBeNull();
  });

  it("refuses a wrong secret, a body changed after signing, a missing or malformed signature", () => {
    const { sim } = simulated();
    const wrong = sim.webhook(actions, { secret, signedWith: "other" });
    expect(hook.verify(req(wrong), secret)).toBe(false);
    const ok = sim.webhook(actions, { secret });
    expect(hook.verify({ headers: ok.headers, body: ok.rawBody.replace("update", "delete") }, secret)).toBe(false);
    expect(hook.verify({ headers: {}, body: ok.rawBody }, secret)).toBe(false);
    expect(hook.verify({ headers: { "payload-signature": "zz" }, body: ok.rawBody }, secret)).toBe(false);
    expect(hook.verify({ headers: { "payload-signature": ok.headers["payload-signature"].slice(2) }, body: ok.rawBody }, secret)).toBe(false);
    // A signature under another secret, however well formed.
    expect(hook.verify(req(ok), "not the secret")).toBe(false);
  });

  it("accepts the header however it is cased, and a signature in capitals", () => {
    const { sim } = simulated();
    const d = sim.webhook(actions, { secret });
    expect(hook.verify({ headers: { "Payload-Signature": d.headers["payload-signature"] }, body: d.rawBody }, secret)).toBe(true);
    expect(hook.verify({ headers: { "payload-signature": d.headers["payload-signature"].toUpperCase() }, body: d.rawBody }, secret)).toBe(true);
  });
});
