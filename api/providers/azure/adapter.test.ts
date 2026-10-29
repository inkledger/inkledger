import { describe, expect, it, vi } from "vitest";
import { timeZone, type Instant } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { decodeCheckpoint } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { readPass } from "../core/paging";
import { statusHistoryConformance, trackerConformance } from "../conformance/suite";
import type { Checkpoint, IssueRef } from "../types";
import { azureProvider, azureWebhook } from "./adapter";
import { azureSimulator } from "./simulator";
import { assignedChanged, titleSearch, wiqlString } from "./translate";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "20.42.0.10", family: 4 }]),
}));

type SimOptions = Parameters<typeof azureSimulator>[0];

function simulated(opts: SimOptions = {}, connOptions: unknown = {}, token?: string) {
  const sim = azureSimulator(opts);
  sim.add("Web", "Login fails on Safari", { type: "Bug", priority: 2, tags: ["ui", "safari"], description: "<div>Steps:<br>1. open</div>", estimate: 4, due: "2026-10-30" });
  sim.add("Web", "Export to CSV", { completed: 1.5 });
  sim.add("Web", "Someone else's", { assignee: "other" });
  sim.add("Back Office", "Story for ops", { type: "User Story" });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 3,
    userId: 1,
    type: "azure" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: sim.me.id,
    options: connOptions,
    timeZone: timeZone("Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: token ?? sim.token }),
  };
  return { sim, conn, b: bindTracker(azureProvider, conn) };
}

trackerConformance("azure (simulated)", async () => {
  const { sim, conn } = simulated();
  return { provider: azureProvider, conn, key: "Web#1", writable: true, url: `${sim.apiBase}/Web/_workitems/edit/1` };
});

const meta = (signal = new AbortController().signal) => ({ signal, correlationId: "t" });
const kindOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ProviderError ? e.kind : String(e)));
const ref = (id: number, key: string): IssueRef => ({ remoteId: String(id), key });

describe("azure: reading the user's items", () => {
  it("lists what is assigned to the user, any type, keyed Project#id, with the state's category", async () => {
    const { b, sim } = simulated();
    const all = await readPass((q) => b.listChanged(meta(), q), null);
    expect(all.items.map((i) => [i.key, i.type.name, i.status.name, i.status.category])).toEqual([
      ["Web#1", "Bug", "New", "todo"],
      ["Web#2", "Task", "New", "todo"],
      ["Back Office#4", "User Story", "New", "todo"],
    ]);
    const bug = all.items[0];
    expect(bug).toMatchObject({
      remoteId: "1",
      url: `${sim.apiBase}/Web/_workitems/edit/1`,
      labels: ["ui", "safari"],
      container: { key: "Web", name: "Web", kind: "project", remoteId: sim.projects[0].id },
      priority: { id: "2", rank: 1 },
      assignees: [{ remoteId: sim.me.id, name: "Mario Rossi", handle: "mario@example.com" }],
    });
    // Time fields are hours: seconds here.
    expect(bug.estimateSeconds).toBe(4 * 3600);
    expect(all.items[1].spentSeconds).toBe(5400);
    // The description is heavy: not part of a list.
    expect(sim.calls.filter((c) => c.includes("workitemsbatch")).length).toBeGreaterThan(0);
  });

  it("categories follow the service's own: Resolved is still doing, Closed done, Removed cancelled (read by category, never by name)", async () => {
    const { b, sim } = simulated();
    sim.outside.change(1, { "System.State": "Resolved" });
    sim.outside.change(2, { "System.State": "Removed" });
    sim.outside.change(4, { "System.State": "Closed" });
    const all = await readPass((q) => b.listChanged(meta(), q), null);
    expect(Object.fromEntries(all.items.map((i) => [i.key, i.status.category]))).toEqual({ "Web#1": "doing", "Web#2": "cancelled", "Back Office#4": "done" });
  });

  it("a checkpoint reads only what changed since; a same-day change is seen because WIQL is asked for time precision", async () => {
    const { b, sim } = simulated();
    sim.advance(3_600_000);
    const first = await readPass((q) => b.listChanged(meta(), q), null);
    expect(first.checkpoint).not.toBeNull();
    // Nothing changed: nothing comes (without time precision, WIQL would hand back the whole day).
    expect((await readPass((q) => b.listChanged(meta(), q), first.checkpoint)).items).toEqual([]);
    sim.advance(2 * 3_600_000);
    sim.outside.change(2, { "System.Title": "Export to CSV (done right)" });
    const second = await readPass((q) => b.listChanged(meta(), q), first.checkpoint);
    expect(second.items.map((i) => [i.key, i.title])).toEqual([["Web#2", "Export to CSV (done right)"]]);
    expect(sim.calls.filter((c) => c.includes("/wiql")).every((c) => c.includes("timePrecision=true"))).toBe(true);
  });

  it("dates go out in UTC with their Z: a user whose profile is in another zone gets the same pass", async () => {
    const { b, sim } = simulated({ tzOffsetMinutes: 330 });
    sim.advance(3_600_000);
    const first = await readPass((q) => b.listChanged(meta(), q), null);
    expect(first.items).toHaveLength(3);
    sim.advance(2 * 3_600_000);
    sim.outside.change(1, { "System.Title": "changed" });
    expect((await readPass((q) => b.listChanged(meta(), q), first.checkpoint)).items.map((i) => i.key)).toEqual(["Web#1"]);
  });

  it("a due date is a date-time at midnight of the user's zone: read back in the connection's zone, not in UTC", async () => {
    const { b, sim } = simulated();
    // Stored as 2026-10-29T23:00:00Z (midnight at UTC+1).
    expect(sim.items[0].fields["Microsoft.VSTS.Scheduling.DueDate"]).toBe("2026-10-29T23:00:00.000Z");
    const found = await b.findIssue(meta(), { key: "Web#1" });
    expect(found.kind === "found" && found.issue.due).toBe("2026-10-30");
  });

  it("pages through a long pass on one window: no item twice, none lost to a change made meanwhile", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 150; n++) sim.add("Web", `Bulk ${n}`);
    const first = await b.listChanged(meta(), { since: null, page: null });
    expect(first.last).toBe(false);
    if (first.last) return;
    // Someone changes an item after the pass began: it is not in this pass's window (the next pass reads it).
    sim.advance(60_000);
    sim.outside.change(5, { "System.Title": "late" });
    const rest = await readPass((q) => b.listChanged(meta(), q), null);
    const ids = rest.items.map((i) => i.remoteId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(153);
    expect(rest.pages).toBe(2);
  });

  it("an answer cut at the ceiling is not mistaken for a whole pass: the checkpoint stops at the last change read", async () => {
    // The service's ceiling and the adapter's $top both 3; five items, an hour apart.
    const { b, sim, conn } = simulated({ wiqlLimit: 3 }, { wiqlTop: 3 });
    sim.items.length = 0;
    for (let n = 1; n <= 5; n++) {
      sim.add("Web", `Item ${n}`);
      sim.advance(3_600_000);
    }
    const seen: string[] = [];
    let cp = null as Checkpoint | null;
    for (let pass = 0; pass < 5; pass++) {
      const r = await readPass((q) => b.listChanged(meta(), q), cp);
      seen.push(...r.items.map((i) => i.title));
      if (pass === 0) {
        expect(r.items).toHaveLength(3);
        // Not "now": that would skip items 4 and 5 for good.
        const at = decodeCheckpoint<{ at: number }>(conn, "issues", 1, r.checkpoint)!.at;
        expect(at).toBeLessThan(sim.now() - 3_600_000);
      }
      cp = r.checkpoint;
    }
    expect(new Set(seen)).toEqual(new Set(["Item 1", "Item 2", "Item 3", "Item 4", "Item 5"]));
  });

  it("older servers send identities as text: the name and the unique name are still read", async () => {
    const { b, sim } = simulated({ legacyIdentities: true });
    const found = await b.findIssue(meta(), { key: "Web#1" });
    expect(found.kind === "found" && found.issue.assignees).toEqual([{ remoteId: "mario@example.com", name: "Mario Rossi", handle: "mario@example.com" }]);
    expect(sim.me.uniqueName).toBe("mario@example.com");
  });

  it("the person who verifies is the one the items name, by the same id", async () => {
    const { b, sim } = simulated();
    const me = await b.verify(meta());
    expect(me).toMatchObject({ remoteId: sim.me.id, name: "Mario Rossi", email: "mario@example.com", login: "mario@example.com" });
    const found = await b.findIssue(meta(), { key: "Web#1" });
    expect(found.kind === "found" && found.issue.assignees[0].remoteId).toBe(me.remoteId);
  });
});

describe("azure: ids, keys and links", () => {
  it("the id is the identity: a project renamed or an item moved changes the key, not the issue", async () => {
    const { b, sim } = simulated();
    const before = await b.findIssue(meta(), { key: "Web#1" });
    if (before.kind !== "found") throw new Error("no issue");
    sim.outside.renameProject("Web", "Frontend");
    const after = await b.getIssue(meta(), ref(1, "Web#1"));
    expect(after).toMatchObject({ remoteId: "1", key: "Frontend#1" });
    // The container keeps its id through the rename.
    expect(after?.container.remoteId).toBe(before.issue.container.remoteId);
    expect(after?.container.key).toBe("Frontend");
    // A typed key names its project too: the old one no longer finds it, the new one does; a link finds it by id.
    expect((await b.findIssue(meta(), { key: "Web#1" })).kind).toBe("none");
    expect((await b.findIssue(meta(), { key: "Frontend#1" })).kind).toBe("found");
    expect((await b.findIssue(meta(), { remoteId: "1", key: "Web#1" })).kind).toBe("found");
    sim.outside.move(2, "Back Office");
    expect(await b.getIssue(meta(), ref(2, "Frontend#2"))).toMatchObject({ remoteId: "2", key: "Back Office#2" });
  });

  it("reads keys, bare numbers and links of the service, and refuses what isn't one", async () => {
    const { b, sim } = simulated();
    expect(b.parseRef("Web#12")).toEqual({ key: "Web#12" });
    expect(b.parseRef("  Back Office#4 ")).toEqual({ key: "Back Office#4" });
    expect(b.parseRef("#7")).toEqual({ remoteId: "7" });
    expect(b.parseRef("12")).toEqual({ remoteId: "12" });
    expect(b.parseRef(`${sim.apiBase}/Back%20Office/_workitems/edit/4`)).toEqual({ remoteId: "4", key: "Back Office#4" });
    expect(b.parseRef(`${sim.apiBase}/Web/_boards/board/t/Web%20Team/Stories?workitem=2`)).toEqual({ remoteId: "2", key: "Web#2" });
    expect(b.parseRef(`${sim.apiBase}/_workitems/edit/3`)).toEqual({ remoteId: "3" });
    expect(b.parseRef(`${sim.apiBase}/Web/_workitems/edit/3?fullScreen=true#comments`)).toEqual({ remoteId: "3", key: "Web#3" });
    // Another organization, and pages that aren't a work item.
    expect(b.parseRef("https://dev.azure.com/other/Web/_workitems/edit/1")).toBeNull();
    expect(b.parseRef(`${sim.apiBase}/Web/_git/repo`)).toBeNull();
    for (const text of ["Web#", "Web/Sub#1", "_hidden#1", "a#b#1", "Web #x", ""]) expect(b.normalizeKey(text), text).toBeNull();
    expect(b.normalizeKey(" Web#007 ")).toBe("Web#7");
  });

  it("links of an Azure DevOps Server keep the collection in their path", async () => {
    const { conn } = simulated();
    const server = bindTracker(azureProvider, { ...conn, baseUrl: "https://tfs.corp.example/tfs/DefaultCollection" });
    expect(server.parseRef("https://tfs.corp.example/tfs/DefaultCollection/Proj/_workitems/edit/5")).toEqual({ remoteId: "5", key: "Proj#5" });
    expect(server.parseRef("https://tfs.corp.example/tfs/OtherCollection/Proj/_workitems/edit/5")).toBeNull();
  });

  it("a deleted item answers 404 and is gone for every read; the reporting feed tells it was deleted", async () => {
    const { b, sim } = simulated();
    sim.advance(3_600_000);
    const first = await readPass((q) => b.listChanged(meta(), q), null);
    expect(first.gone).toEqual([]);
    sim.advance(3_600_000);
    sim.outside.delete(2);
    expect(await b.getIssue(meta(), ref(2, "Web#2"))).toBeNull();
    expect((await b.findIssue(meta(), { key: "Web#2" })).kind).toBe("none");
    const next = await readPass((q) => b.listChanged(meta(), q), first.checkpoint);
    expect(next.gone).toEqual([{ remoteId: "2", reason: "deleted" }]);
    expect(next.items).toEqual([]);
    // Restored: it is an ordinary item again.
    sim.advance(60_000);
    sim.outside.restore(2);
    const back = await readPass((q) => b.listChanged(meta(), q), first.checkpoint);
    expect(back.items.map((i) => i.key)).toEqual(["Web#2"]);
    expect(back.gone).toEqual([]);
  });

  it("a batch with a deleted id still answers (errorPolicy omit): the others come", async () => {
    const { b, sim } = simulated();
    sim.outside.delete(2);
    const r = await b.query!(meta(), "SELECT [System.Id] FROM WorkItems WHERE [System.Id] IN (1, 2, 4) ORDER BY [System.Id]", 10);
    expect(r.items.map((i) => i.key)).toEqual(["Web#1", "Back Office#4"]);
    // The raw call, as a client without the policy would make it, fails whole.
    const raw = await sim.fetch(`${sim.apiBase}/_apis/wit/workitemsbatch?api-version=7.1`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`:${sim.token}`).toString("base64")}` },
      body: JSON.stringify({ ids: [1, 2] }),
    });
    expect(raw.status).toBe(404);
  });
});

describe("azure: searching", () => {
  it("finds by words of the title (any order), by id, with quotes in the text", async () => {
    const { b, sim } = simulated();
    sim.add("Web", "O'Brien's report is wrong");
    expect((await b.searchText!(meta(), "csv", 10)).items.map((i) => i.key)).toEqual(["Web#2"]);
    expect((await b.searchText!(meta(), "safari login", 10)).items.map((i) => i.key)).toEqual(["Web#1"]);
    expect((await b.searchText!(meta(), "#2", 10)).items.map((i) => i.key)).toEqual(["Web#2"]);
    expect((await b.searchText!(meta(), "O'Brien", 10)).items.map((i) => i.key)).toEqual(["Web#5"]);
    // Everything the token sees, not only the user's: the other person's item too.
    expect((await b.searchText!(meta(), "someone", 10)).items.map((i) => i.key)).toEqual(["Web#3"]);
  });

  it("runs the user's own WIQL untouched, and says when the answer was cut", async () => {
    const { b } = simulated();
    const all = await b.query!(meta(), "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Web' ORDER BY [System.Id] DESC", 10);
    expect(all).toMatchObject({ complete: true });
    expect(all.items.map((i) => i.key)).toEqual(["Web#3", "Web#2", "Web#1"]);
    const cut = await b.query!(meta(), "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Web' ORDER BY [System.Id]", 2);
    expect(cut.complete).toBe(false);
    expect(cut.items).toHaveLength(2);
    const err = await b.query!(meta(), "SELECT [System.Id] FROM WorkItems WHERE [System.State] ==", 10).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "invalid" });
    expect((err as Error).message).toMatch(/WIQL query is invalid/);
  });

  it("reads items 200 at a time and keeps the order the query gave", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 250; n++) sim.add("Bulk", `Bulk ${n}`);
    const r = await b.query!(meta(), "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Bulk' ORDER BY [System.Id] DESC", 250);
    expect(r.items).toHaveLength(250);
    expect(r.items[0].key).toBe("Bulk#254");
    expect(sim.calls.filter((c) => c.includes("workitemsbatch")).length).toBe(2);
  });

  it("a query across links answers with relations: their targets are the items", async () => {
    const { b, sim } = simulated();
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/wiql")
        ? new Response(JSON.stringify({ queryType: "tree", asOf: new Date().toISOString(), workItemRelations: [{ target: { id: 1 } }, { source: { id: 1 }, target: { id: 2 } }, { target: { id: 1 } }] }), { status: 200, headers: { "Content-Type": "application/json" } })
        : sim.fetch(input, init),
    );
    expect((await b.query!(meta(), "SELECT [System.Id] FROM WorkItemLinks", 10)).items.map((i) => i.key)).toEqual(["Web#1", "Web#2"]);
  });

  it("builds WIQL with its literals escaped", () => {
    expect(wiqlString("it's")).toBe("'it''s'");
    expect(assignedChanged(Date.UTC(2026, 9, 1, 10), Date.UTC(2026, 9, 2))).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.ChangedDate] >= '2026-10-01T10:00:00.000Z' AND [System.ChangedDate] <= '2026-10-02T00:00:00.000Z' ORDER BY [System.ChangedDate] ASC, [System.Id] ASC",
    );
    expect(assignedChanged(null, null)).not.toMatch(/ChangedDate\] [<>]/);
    expect(titleSearch("a b")).toBe("SELECT [System.Id] FROM WorkItems WHERE [System.Title] CONTAINS 'a' AND [System.Title] CONTAINS 'b' ORDER BY [System.ChangedDate] DESC");
  });
});

describe("azure: workflow", () => {
  it("offers the transitions the type allows, each with its category, and moves along one", async () => {
    const { b } = simulated();
    const bug = ref(1, "Web#1");
    const ways = await b.transitions!.list!(meta(), bug);
    expect(ways.map((t) => [t.name, t.to.category])).toEqual([
      ["Active", "doing"],
      ["Resolved", "doing"],
      ["Closed", "done"],
    ]);
    expect(ways.every((t) => t.requirements.length === 0 && t.remoteUrl?.endsWith("/Web/_workitems/edit/1"))).toBe(true);
    const resolved = await b.transitions!.apply!(meta(), bug, "Resolved", {});
    expect(resolved?.status).toMatchObject({ name: "Resolved", category: "doing", nativeReason: "Moved to state Resolved" });
    expect((await b.transitions!.list!(meta(), bug)).map((t) => t.name)).toEqual(["Active", "Closed"]);
    const removed = await b.transitions!.apply!(meta(), ref(2, "Web#2"), "Removed", {});
    expect(removed?.status).toMatchObject({ name: "Removed", category: "cancelled" });
  });

  it("a state the type does not allow from here is refused as invalid", async () => {
    const { b } = simulated();
    expect(await kindOf(b.transitions!.apply!(meta(), ref(2, "Web#2"), "Closed", {}))).toBe("invalid");
  });

  it("a process with no listed transitions (inherited) lets an item go to any other state", async () => {
    const { b, sim } = simulated();
    sim.addProject("Legacy", { inherited: true });
    const t = sim.add("Legacy", "Anything goes");
    const ways = await b.transitions!.list!(meta(), ref(t.id, `Legacy#${t.id}`));
    expect(ways.map((x) => x.name)).toEqual(["Active", "Closed", "Removed"]);
    expect((await b.transitions!.apply!(meta(), ref(t.id, `Legacy#${t.id}`), "Closed", {}))?.status.category).toBe("done");
  });

  it("lists every status of the service with its category", async () => {
    const { b } = simulated();
    const source = { kind: "itemState" as const, transitions: "allowedList" as const, ref: { kind: "itemState" as const }, name: "x" };
    const all = await b.statuses!(meta(), source);
    expect(Object.fromEntries(all.map((s) => [s.name, s.category]))).toEqual({ New: "todo", Active: "doing", Closed: "done", Removed: "cancelled", Resolved: "doing" });
  });

  it("the probe names the one workflow source, and is kept to the provider's capabilities", async () => {
    const { b } = simulated();
    const p = await b.probe(meta());
    expect(p.activeSources).toMatchObject([{ kind: "itemState", transitions: "allowedList", ref: { kind: "itemState" } }]);
  });
});

describe("azure: comments (HTML)", () => {
  it("writes paragraphs as HTML with the markup it can't carry reported, reads oldest first however the service orders", async () => {
    const { b, sim } = simulated();
    const web1 = ref(1, "Web#1");
    const made = await b.comments!.add!(meta(), web1, "Fixed in <b>1.2</b>\n\nSee **notes**" as never, { idempotencyKey: "c1" });
    expect(made.warnings.map((w) => w.feature)).toEqual(["strong"]);
    for (const w of made.warnings) expect(w).not.toHaveProperty("serverDetail");
    expect(made.comment?.body).toEqual({ kind: "text", format: "html", text: "<div>Fixed in &lt;b&gt;1.2&lt;/b&gt;</div><div>See **notes**</div>" });
    sim.outside.comment(1, "<div>Thanks</div>");
    const list = await b.comments!.list(meta(), web1);
    expect(list.map((c) => [c.author.name, c.body.kind === "text" ? c.body.text : ""])).toEqual([
      ["Mario Rossi", "<div>Fixed in &lt;b&gt;1.2&lt;/b&gt;</div><div>See **notes**</div>"],
      ["Anna Bianchi", "<div>Thanks</div>"],
    ]);
    expect(list[0].createdAt).not.toBeNull();
  });

  it("reads every page of a long thread", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 205; n++) sim.outside.comment(1, `c${n}`);
    const list = await b.comments!.list(meta(), ref(1, "Web#1"));
    expect(list).toHaveLength(205);
    expect(list[0].body).toMatchObject({ text: "c0" });
    expect(list[204].body).toMatchObject({ text: "c204" });
  });

  it("comments are project-scoped: a project renamed since is found again from the item", async () => {
    const { b, sim } = simulated();
    const stale: IssueRef = { remoteId: "1", key: "Web#1", container: { remoteId: sim.projects[0].id, key: "Web" } };
    sim.outside.renameProject("Web", "Frontend");
    await b.comments!.add!(meta(), stale, "after the rename" as never, { idempotencyKey: "c2" });
    expect((await b.comments!.list(meta(), stale)).map((c) => (c.body.kind === "text" ? c.body.text : ""))).toEqual(["<div>after the rename</div>"]);
    // An item that isn't there is notFound, not a loop of retries.
    expect(await kindOf(b.comments!.list(meta(), ref(99, "Frontend#99")))).toBe("notFound");
  });

  it("gives the description in the service's own format, or none", async () => {
    const { b } = simulated();
    expect(await b.description!(meta(), ref(1, "Web#1"))).toEqual({ kind: "text", format: "html", text: "<div>Steps:<br>1. open</div>" });
    expect(await b.description!(meta(), ref(2, "Web#2"))).toBeNull();
  });
});

describe("azure: time is a counter in hours, held to the revision", () => {
  it("reads Completed Work as seconds with the revision, adds and subtracts under it, never below zero", async () => {
    const { b } = simulated();
    const task = ref(2, "Web#2");
    expect(await b.timeCounter!.read!(meta(), task)).toEqual({ seconds: 5400, version: "1" });
    // 1.5h + 10 min = 1.6666…h, read back to the second.
    expect(await b.timeCounter!.increment!(meta(), task, 600, { expectedVersion: "1" })).toEqual({ seconds: 6000, version: "2" });
    expect(await b.timeCounter!.decrement!(meta(), task, 1000, { expectedVersion: "2" })).toEqual({ seconds: 5000, version: "3" });
    expect(await b.timeCounter!.decrement!(meta(), task, 999_999, { expectedVersion: "3" })).toEqual({ seconds: 0, version: "4" });
    // One second is 0.000277…h and survives the round trip.
    expect(await b.timeCounter!.increment!(meta(), task, 1, { expectedVersion: "4" })).toEqual({ seconds: 1, version: "5" });
  });

  it("a stale revision is a conflict, whoever changed the item and whatever they changed", async () => {
    const { b, sim } = simulated();
    const task = ref(2, "Web#2");
    const { version } = await b.timeCounter!.read!(meta(), task);
    // Not even the counter: a title edit is a new revision.
    sim.outside.change(2, { "System.Title": "renamed" });
    expect(await kindOf(b.timeCounter!.increment!(meta(), task, 60, { expectedVersion: version ?? undefined }))).toBe("conflict");
    // A comment too (it is a revision of the work item).
    const fresh = await b.timeCounter!.read!(meta(), task);
    sim.outside.comment(2, "hi");
    expect(await kindOf(b.timeCounter!.decrement!(meta(), task, 60, { expectedVersion: fresh.version ?? undefined }))).toBe("conflict");
    // Read again, and it goes through.
    const again = await b.timeCounter!.read!(meta(), task);
    expect((await b.timeCounter!.increment!(meta(), task, 60, { expectedVersion: again.version ?? undefined })).seconds).toBe(5460);
  });

  it("a type without Completed Work refuses the write as invalid, and reads as zero", async () => {
    const { b } = simulated();
    const story = ref(4, "Back Office#4");
    expect(await b.timeCounter!.read!(meta(), story)).toEqual({ seconds: 0, version: "1" });
    expect(await kindOf(b.timeCounter!.increment!(meta(), story, 60, { expectedVersion: "1" }))).toBe("invalid");
  });
});

describe("azure: history", () => {
  it("lists what changed, per field, without the service's own bookkeeping", async () => {
    const { b, sim } = simulated();
    sim.outside.change(1, { "System.State": "Active" });
    sim.outside.assign(1, "other");
    const h = await b.history!(meta(), ref(1, "Web#1"));
    expect(h.filter((c) => c.field.id === "System.State").map((c) => [c.from[0]?.text, c.to[0]?.text, c.actor?.name])).toEqual([
      [undefined, "New", "Mario Rossi"],
      ["New", "Active", "Anna Bianchi"],
    ]);
    const assigned = h.find((c) => c.field.id === "System.AssignedTo");
    expect(assigned).toMatchObject({ field: { name: "Assigned To" }, from: [{ text: "Mario Rossi" }], to: [{ text: "Anna Bianchi" }] });
    expect(h.some((c) => ["System.Rev", "System.ChangedDate", "System.Watermark"].includes(c.field.id ?? ""))).toBe(false);
  });

  it("reads every page of a long history", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 230; n++) sim.outside.change(1, { "System.Title": `t${n}` });
    const h = await b.history!(meta(), ref(1, "Web#1"));
    expect(h.filter((c) => c.field.id === "System.Title")).toHaveLength(231);
  });
});

describe("azure: errors arrive in the layer's words", () => {
  it.each([
    [401, "auth"],
    [403, "forbidden"],
    [503, "unavailable"],
  ])("HTTP %i is %s", async (status, kind) => {
    const { b, sim } = simulated();
    sim.failNext(status);
    expect(await kindOf(b.verify(meta()))).toBe(kind);
  });

  it("a spent quota is a wait, with when to retry", async () => {
    const { b, sim } = simulated();
    sim.failNext(429);
    const err = await b.verify(meta()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 30_000, remaining: 0 } });
    expect((err as ProviderError).rateLimit?.resetAt).toBeGreaterThan(Date.now());
    // A 429 without Retry-After still waits, with the reset time.
    sim.failNext(429, { "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 90) });
    const reset = await b.verify(meta()).catch((e: unknown) => e);
    expect((reset as ProviderError).rateLimit?.retryAfterMs).toBeGreaterThan(60_000);
  });

  it("a refused token is auth, whether the service answers 401 or (when not asked to) its sign-in page with a 203", async () => {
    const { b } = simulated({}, {}, "wrong-token");
    expect(await kindOf(b.verify(meta()))).toBe("auth");
    // As a client that doesn't send X-TFS-FedAuthRedirect would see it.
    const { sim, conn } = simulated({}, {}, "wrong-token");
    const raw = await sim.fetch(`${sim.apiBase}/_apis/connectionData`, { headers: { Authorization: `Basic ${Buffer.from(":wrong-token").toString("base64")}` } });
    expect(raw.status).toBe(203);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.delete("X-TFS-FedAuthRedirect");
      return sim.fetch(input, { ...init, headers });
    });
    const quiet = bindTracker(azureProvider, conn);
    expect(await kindOf(quiet.verify(meta()))).toBe("auth");
  });

  it("a missing item is notFound where an operation needs it, null where a lookup may miss", async () => {
    const { b } = simulated();
    expect(await kindOf(b.transitions!.list!(meta(), ref(99, "Web#99")))).toBe("notFound");
    expect(await kindOf(b.timeCounter!.read!(meta(), ref(99, "Web#99")))).toBe("notFound");
    expect(await b.getIssue(meta(), ref(99, "Web#99"))).toBeNull();
  });

  it("a write on a read-only server is readOnly, never sent", async () => {
    vi.stubEnv("PROVIDERS_READ_ONLY", "1");
    vi.resetModules();
    const { azureProvider: fresh } = await import("./adapter");
    const { bindTracker: bind } = await import("../core/bind");
    const { ProviderError: PE } = await import("../core/errors");
    const { conn, sim } = simulated();
    const b = bind(fresh, conn);
    const err = await b.timeCounter!.increment!(meta(), ref(2, "Web#2"), 60, { expectedVersion: "1" }).catch((e: unknown) => e);
    expect(err instanceof PE && err.kind).toBe("readOnly");
    expect(sim.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
    // Reads go through (a POST that only carries a list of ids too).
    expect((await b.query!(meta(), "SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 1", 5)).items).toHaveLength(1);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reads its options: a ceiling for WIQL, nothing else", () => {
    expect(azureProvider.parseOptions(undefined)).toEqual({ wiqlTop: 20_000 });
    expect(azureProvider.parseOptions({ wiqlTop: 500 })).toEqual({ wiqlTop: 500 });
    expect(() => azureProvider.parseOptions({ wiqlTop: 0 })).toThrow(ProviderError);
    expect(() => azureProvider.parseOptions({ nope: 1 })).toThrow(ProviderError);
  });
});

describe("azure: service hooks", () => {
  const secret = { username: "inkledger", password: "s3cret-hook" };
  const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

  it("accepts a delivery carrying the subscription's basic auth, refuses any other", () => {
    expect(azureWebhook.verify(basic("inkledger", "s3cret-hook"), secret)).toBe(true);
    expect(azureWebhook.verify(basic("inkledger", "wrong"), secret)).toBe(false);
    expect(azureWebhook.verify(basic("someone", "s3cret-hook"), secret)).toBe(false);
    expect(azureWebhook.verify(undefined, secret)).toBe(false);
    expect(azureWebhook.verify("Bearer s3cret-hook", secret)).toBe(false);
    expect(azureWebhook.verify("", secret)).toBe(false);
  });

  it("names the event, the item, the delivery (the event's id, stable across redeliveries) and when it was sent", () => {
    const body = { id: "5c0b8c43-0000-4000-8000-000000000009", notificationId: 12, eventType: "workitem.updated", createdDate: "2026-10-20T08:15:00.000Z", resource: { id: 77, workItemId: 42, rev: 3 } };
    expect(azureWebhook.deliveryId(body)).toBe("5c0b8c43-0000-4000-8000-000000000009");
    expect(azureWebhook.sentAt(body)).toBe(Date.UTC(2026, 9, 20, 8, 15) as Instant);
    expect(azureWebhook.event(body)).toEqual({ event: "issueChanged", remoteId: "42" });
    expect(azureWebhook.event({ eventType: "workitem.deleted", resource: { id: 9 } })).toEqual({ event: "issueRemoved", remoteId: "9" });
    expect(azureWebhook.event({ eventType: "workitem.commented", resource: { workItemId: 9 } })).toEqual({ event: "commentAdded", remoteId: "9" });
    expect(azureWebhook.event({ eventType: "build.complete" })).toBeNull();
    expect(azureWebhook.deliveryId({})).toBeNull();
    expect(azureWebhook.sentAt({ createdDate: "not a date" })).toBeNull();
  });
});

statusHistoryConformance("azure (simulated)", async () => {
  const { b, sim } = simulated();
  return { b, ref: ref(1, "Web#1"), moveTwice: () => (sim.outside.change(1, { "System.State": "Active" }), sim.outside.change(1, { "System.State": "Closed" })) };
});
