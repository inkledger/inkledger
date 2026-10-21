import { describe, expect, it, vi } from "vitest";
import { markdown, timeZone } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import type { Checkpoint } from "../types";
import { KEY_BUDGET, TOKEN_BUDGET, trelloSimulator } from "./simulator";
import { trelloProvider, trelloWebhook, type TrelloOptions } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "104.192.140.1", family: 4 }]),
}));

const CATEGORIES: TrelloOptions["categories"] = { backlog: "backlog", doing: "doing", "in corso": "doing", done: "done", fatto: "done", "won't do": "cancelled" };

function simulated(o: { options?: unknown; secret?: string } = {}) {
  const sim = trelloSimulator();
  const anna = sim.addUser("Anna Bianchi");
  sim.addBoard("Acme Web", { listNames: ["Backlog", "Sprint", "Doing", "Done", "Won't do"], shortLink: "AcMeWeb1" });
  sim.addBoard("Operations", { listNames: ["Da fare", "In corso", "Fatto"] });
  sim.addBoard("Old project", { listNames: ["Todo", "Done"], closed: true });
  sim.add("Acme Web", "Login fails on Safari", {
    shortLink: "Lg4nS4f1",
    list: "Sprint",
    desc: "Steps:\n\n1. open\n2. **fail**",
    due: "2026-10-30T23:30:00.000Z",
    labels: [
      { id: "lb1", name: "bug", color: "red" },
      { id: "lb2", name: "", color: "green" },
    ],
    members: [sim.me, anna],
  });
  sim.add("Acme Web", "Export to CSV", { shortLink: "Ex9rtCs2", due: "2026-10-30T22:30:00.000Z" });
  sim.add("Operations", "Rotate certificates", { shortLink: "Rt8Crt03", list: "In corso" });
  sim.add("Acme Web", "Anna's own", { shortLink: "An7Own04", members: [anna] });
  sim.live();
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 9,
    userId: 1,
    type: "trello" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: sim.me.id,
    options: o.options ?? { categories: CATEGORIES },
    timeZone: timeZone("Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.secret ?? sim.secret }),
  };
  return { sim, anna, conn, b: bindTracker(trelloProvider, conn) };
}

trackerConformance("trello (simulated)", async () => {
  const { conn } = simulated();
  return { provider: trelloProvider, conn, key: "Lg4nS4f1", writable: true, url: "https://trello.com/c/Lg4nS4f1/1-login-fails-on-safari" };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const pass = (b: ReturnType<typeof simulated>["b"], since: Checkpoint | null = null) => readPass((q) => b.listChanged(meta(), q), since);
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; status?: number; message: string; rateLimit?: { retryAfterMs?: number; remaining?: number } });
const refOf = (sim: ReturnType<typeof simulated>["sim"], k: string) => ({ remoteId: sim.card(k).id, key: sim.card(k).shortLink });

describe("trello, cards", () => {
  it("lists the cards assigned to the user, keyed by shortLink, with the list as status and the board as container", async () => {
    const { b, sim } = simulated();
    const all = await pass(b);
    expect(all.items.map((i) => [i.key, i.container.name, i.status.name, i.status.category]).sort()).toEqual([
      ["Ex9rtCs2", "Acme Web", "Backlog", "backlog"],
      ["Lg4nS4f1", "Acme Web", "Sprint", "todo"],
      ["Rt8Crt03", "Operations", "In corso", "doing"],
    ]);
    const login = all.items.find((i) => i.key === "Lg4nS4f1")!;
    expect(login).toMatchObject({
      remoteId: sim.card("Lg4nS4f1").id,
      url: "https://trello.com/c/Lg4nS4f1",
      type: { id: "card", level: "standard" },
      container: { remoteId: sim.board("Acme Web").id, key: "AcMeWeb1", kind: "board" },
      status: { source: { kind: "column", boardRemoteId: sim.board("Acme Web").id }, categoryOrigin: { by: "mapping" } },
    });
    expect(all.gone).toEqual([]);
    expect(all.checkpoint).not.toBeNull();
  });

  it("reads people, labels, the number on the board and the dates as Trello keeps them", async () => {
    const { b, sim } = simulated();
    const i = (await b.getIssue(meta(), refOf(sim, "Lg4nS4f1")))!;
    expect(i.assignees.map((a) => [a.name, a.handle, a.avatarUrl])).toEqual([
      ["Mario Rossi", "mrossi", "https://trello-members.s3.amazonaws.com/avatars/mrossi/50.png"],
      // No avatar: null, not a broken link.
      ["Anna Bianchi", "anna", null],
    ]);
    // A label can have a colour and no name.
    expect(i.labels).toEqual(["bug", "green"]);
    expect(i.fields).toMatchObject({ number: 1, dueComplete: false });
    // The creation time is inside the id (seconds).
    expect(i.createdAt).toBe(parseInt(i.remoteId.slice(0, 8), 16) * 1000);
    expect(i.updatedAt).toBe(Date.parse(new Date(sim.card("Lg4nS4f1").activity).toISOString()));
    expect(i.estimateSeconds).toBeNull();
  });

  it("a due date is an instant: the day is the one in the user's zone", async () => {
    const { b, sim } = simulated();
    // 23:30 UTC on the 30th is already the 31st in Rome (CET after 25 October); 22:30 UTC is still the 30th.
    expect((await b.getIssue(meta(), refOf(sim, "Lg4nS4f1")))?.due).toBe("2026-10-31");
    expect((await b.getIssue(meta(), refOf(sim, "Ex9rtCs2")))?.due).toBe("2026-10-30");
    expect((await b.getIssue(meta(), refOf(sim, "Rt8Crt03")))?.due).toBeNull();
  });

  it("the shortLink is the identity people see and survives a move to another board; the number on the board does not", async () => {
    const { b, sim } = simulated();
    const before = (await b.getIssue(meta(), refOf(sim, "Lg4nS4f1")))!;
    sim.outside.moveToBoard("Lg4nS4f1", "Operations", "Da fare");
    const after = (await b.getIssue(meta(), { remoteId: before.remoteId, key: "Lg4nS4f1" }))!;
    expect([after.remoteId, after.key]).toEqual([before.remoteId, "Lg4nS4f1"]);
    expect(after.container.name).toBe("Operations");
    expect(after.fields).toMatchObject({ number: 2 });
    expect(before.fields).toMatchObject({ number: 1 });
    // Found by either name of the same card.
    for (const handle of [{ key: "Lg4nS4f1" }, { remoteId: before.remoteId }]) {
      const f = await b.findIssue(meta(), handle);
      expect(f.kind === "found" && f.issue.remoteId).toBe(before.remoteId);
    }
    // A pass lists it under its new board.
    expect((await pass(b)).items.find((i) => i.key === "Lg4nS4f1")?.status).toMatchObject({ name: "Da fare", category: "todo" });
  });

  it("parses keys and links of the service, and nothing else", () => {
    const { b } = simulated();
    expect(b.normalizeKey("Lg4nS4f1")).toBe("Lg4nS4f1");
    // Case matters: a shortLink is not upper-cased.
    expect(b.normalizeKey("lg4ns4f1")).toBe("lg4ns4f1");
    expect(b.normalizeKey("Lg4nS4f")).toBeNull();
    expect(b.normalizeKey("Lg4nS4f1x")).toBeNull();
    expect(b.normalizeKey("Lg4n-4f1")).toBeNull();
    expect(b.parseRef("https://trello.com/c/Lg4nS4f1/12-a-title-since-renamed")).toEqual({ key: "Lg4nS4f1" });
    expect(b.parseRef("https://trello.com/c/Lg4nS4f1")).toEqual({ key: "Lg4nS4f1" });
    expect(b.parseRef("https://www.trello.com/c/Lg4nS4f1/")).toEqual({ key: "Lg4nS4f1" });
    expect(b.parseRef("https://trello.com/b/AcMeWeb1/acme-web")).toBeNull();
    expect(b.parseRef("http://trello.com/c/Lg4nS4f1")).toBeNull();
    expect(b.parseRef("https://trello.example.com/c/Lg4nS4f1")).toBeNull();
  });

  it("has no query language and keeps time in inkledger", () => {
    expect(trelloProvider.capabilities.time).toEqual({ mode: "local", remoteTotals: false });
    expect(trelloProvider.worklogs).toBeUndefined();
    expect("query" in trelloProvider).toBe(false);
    expect("translate" in trelloProvider).toBe(false);
  });
});

describe("trello, passes", () => {
  it("reads only the cards with activity since a checkpoint (the list has no 'since': the filter is the adapter's)", async () => {
    const { b, sim } = simulated();
    const first = await pass(b);
    expect((await pass(b, first.checkpoint)).items).toEqual([]);
    // A later millisecond: the change is newer than anything the first pass saw.
    await new Promise((r) => setTimeout(r, 5));
    sim.outside.setList("Ex9rtCs2", "Doing");
    const next = await pass(b, first.checkpoint);
    expect(next.items.map((i) => [i.key, i.status.name, i.status.category])).toEqual([["Ex9rtCs2", "Doing", "doing"]]);
    expect(next.checkpoint).not.toBe(first.checkpoint);
  });

  it("a first read leaves archived cards and cards on closed boards out; a later one reports an archived card as deleted", async () => {
    const { b, sim } = simulated();
    sim.add("Acme Web", "Already archived", { shortLink: "Ar5chvd1", closed: true });
    sim.add("Old project", "On a closed board", { shortLink: "Cl0sed01" });
    // Old news, outside the minute a pass reads again.
    for (const k of ["Ar5chvd1", "Cl0sed01"]) sim.card(k).activity = Date.now() - 3_600_000;
    const first = await pass(b);
    expect(first.items.map((i) => i.key)).not.toContain("Ar5chvd1");
    expect(first.items.map((i) => i.key)).not.toContain("Cl0sed01");
    expect(first.gone).toEqual([]);

    sim.outside.archive("Rt8Crt03");
    const next = await pass(b, first.checkpoint);
    expect(next.items).toEqual([]);
    expect(next.gone).toEqual([{ remoteId: sim.card("Rt8Crt03").id, reason: "deleted" }]);
    // An archived card is still readable by itself.
    expect((await b.getIssue(meta(), refOf(sim, "Rt8Crt03")))?.key).toBe("Rt8Crt03");
    // Restored: it is an item again, not a departure.
    sim.outside.unarchive("Rt8Crt03");
    const back = await pass(b, next.checkpoint);
    expect(back.items.map((i) => i.key)).toEqual(["Rt8Crt03"]);
    expect(back.gone).toEqual([]);
  });

  it("deleted cards and cards the user was taken off are only in the board's log: reported deleted and movedOut", async () => {
    const { b, sim, anna } = simulated();
    const first = await pass(b);
    sim.outside.delete("Ex9rtCs2");
    sim.outside.removeMember("Lg4nS4f1", sim.me, anna);
    // Someone else taken off a card is no departure of the user's.
    sim.outside.removeMember("Lg4nS4f1", anna);
    const next = await pass(b, first.checkpoint);
    expect(next.gone).toEqual(
      expect.arrayContaining([
        { remoteId: sim.card("Ex9rtCs2").id, reason: "deleted" },
        { remoteId: sim.card("Lg4nS4f1").id, reason: "movedOut" },
      ]),
    );
    expect(next.gone).toHaveLength(2);
    // Gone for good: 404, which reads as not there.
    expect(await b.getIssue(meta(), refOf(sim, "Ex9rtCs2"))).toBeNull();
    expect((await b.findIssue(meta(), { key: "Ex9rtCs2" })).kind).toBe("none");

    // Put back on the card: the card as it is now wins over the log.
    sim.outside.addMember("Lg4nS4f1", sim.me, anna);
    const again = await pass(b, first.checkpoint);
    expect(again.items.map((i) => i.key)).toContain("Lg4nS4f1");
    expect(again.gone).toEqual([{ remoteId: sim.card("Ex9rtCs2").id, reason: "deleted" }]);
  });

  it("refuses a checkpoint or page token it didn't write, and a different format", async () => {
    const { b } = simulated();
    await expect(b.listChanged(meta(), { since: "cp1.eyJ9" as Checkpoint, page: null })).rejects.toMatchObject({ kind: "invalidCheckpoint" });
    await expect(b.listChanged(meta(), { since: null, page: "pg1.eyJ9" as never })).rejects.toMatchObject({ kind: "invalidCheckpoint" });
  });
});

describe("trello, workflow", () => {
  it("categories come from the connection's mapping, by list id before list name, and an unmapped list is todo", async () => {
    const plain = simulated({ options: {} });
    const unmapped = await pass(plain.b);
    expect(unmapped.items.every((i) => i.status.category === "todo")).toBe(true);

    const withId = simulated();
    const sprint = withId.sim.lists.find((l) => l.name === "Sprint")!;
    // The name says "todo"-ish, the id says doing: the id wins; names match in any case.
    const b = bindTracker(trelloProvider, { ...withId.conn, options: { categories: { [sprint.id]: "doing", SPRINT: "cancelled", "BACKLOG ": "done", Backlog: "backlog" } } });
    const items = (await pass(b)).items;
    expect(items.find((i) => i.key === "Lg4nS4f1")?.status.category).toBe("doing");
    expect(items.find((i) => i.key === "Ex9rtCs2")?.status.category).toBe("backlog");
    // A list is never read by what its name seems to mean.
    expect(plain.sim.lists.some((l) => l.name === "Done")).toBe(true);
    expect(unmapped.items.find((i) => i.key === "Rt8Crt03")?.status.category).toBe("todo");
    expect(() => trelloProvider.parseOptions({ categories: { x: "shipped" } })).toThrow(/Trello options/);
  });

  it("probes one column source per open board, and reads each board's open lists in order", async () => {
    const { b, sim } = simulated();
    const probe = await b.probe(meta());
    expect(probe.activeSources.map((s) => [s.name, s.kind])).toEqual([
      ["Acme Web", "column"],
      ["Operations", "column"],
    ]);
    const [acme, ops] = probe.activeSources;
    expect(acme.ref).toEqual({ kind: "column", boardRemoteId: sim.board("Acme Web").id });
    sim.outside.archiveList("Acme Web", "Won't do");
    expect((await b.statuses!(meta(), acme)).map((s) => [s.name, s.category])).toEqual([
      ["Backlog", "backlog"],
      ["Sprint", "todo"],
      ["Doing", "doing"],
      ["Done", "done"],
    ]);
    expect((await b.statuses!(meta(), ops)).map((s) => [s.name, s.category])).toEqual([
      ["Da fare", "todo"],
      ["In corso", "doing"],
      ["Fatto", "done"],
    ]);
  });

  it("offers every other open list of the card's board, moves along one, and reads the card in an archived list", async () => {
    const { b, sim } = simulated();
    sim.outside.archiveList("Acme Web", "Won't do");
    const ref = refOf(sim, "Lg4nS4f1");
    const ways = await b.transitions!.list!(meta(), ref);
    expect(ways.map((t) => [t.name, t.to.category])).toEqual([
      ["Backlog", "backlog"],
      ["Doing", "doing"],
      ["Done", "done"],
    ]);
    expect(ways.every((t) => t.requirements.length === 0 && t.remoteUrl === "https://trello.com/c/Lg4nS4f1")).toBe(true);
    const moved = await b.transitions!.apply!(meta(), ref, ways[2].id, {});
    expect(moved?.status).toMatchObject({ name: "Done", category: "done" });
    expect(moved?.fields).toMatchObject({ number: 1 });
    expect(sim.card("Lg4nS4f1").listId).toBe(ways[2].id);

    // A list archived under a card: the card keeps showing it.
    sim.outside.archiveList("Acme Web", "Done");
    const stuck = await b.getIssue(meta(), ref);
    expect(stuck?.status).toMatchObject({ name: "Done", nativeReason: "archived list" });

    // Refusals: a malformed id is a 400, a list that isn't there too, a deleted card is notFound.
    expect(await errorOf(b.transitions!.apply!(meta(), ref, "not-an-id", {}))).toMatchObject({ kind: "invalid", status: 400 });
    expect(await errorOf(b.transitions!.apply!(meta(), ref, "0".repeat(24), {}))).toMatchObject({ kind: "invalid" });
    sim.outside.delete("Lg4nS4f1");
    expect(await errorOf(b.transitions!.list!(meta(), ref))).toMatchObject({ kind: "notFound" });
  });
});

describe("trello, texts", () => {
  it("reads the description as Markdown, and none as null", async () => {
    const { b, sim } = simulated();
    expect(await b.description!(meta(), refOf(sim, "Lg4nS4f1"))).toEqual({ kind: "text", format: "commonmark", text: "Steps:\n\n1. open\n2. **fail**" });
    expect(await b.description!(meta(), refOf(sim, "Ex9rtCs2"))).toBeNull();
  });

  it("reads comments oldest first, all of them (Trello lists 50 by default, newest first, by `before`), edited ones too, and writes comments", async () => {
    const { b, sim, anna } = simulated();
    const ref = refOf(sim, "Lg4nS4f1");
    for (let n = 1; n <= 230; n++) sim.outside.comment("Lg4nS4f1", `Comment ${n}`, n % 2 ? sim.me : anna);
    const last = sim.actions.filter((a) => a.type === "commentCard").at(-1)!;
    sim.outside.editComment(last.id, "Comment 230 (edited)");
    sim.calls.length = 0;
    const list = await b.comments!.list(meta(), ref);
    expect(list).toHaveLength(230);
    expect(list[0].body).toEqual({ kind: "text", format: "commonmark", text: "Comment 1" });
    expect(list.at(-1)?.body).toMatchObject({ text: "Comment 230 (edited)" });
    expect(list[1].author).toMatchObject({ name: "Anna Bianchi", handle: "anna" });
    // Edited: the action keeps its date, the edit is in its data.
    expect(list.at(-1)!.updatedAt!).toBeGreaterThan(list.at(-1)!.createdAt!);
    expect(list[0].updatedAt).toBe(list[0].createdAt);
    const pages = sim.calls.filter((c) => c.path.endsWith("/actions"));
    expect(pages.length).toBe(3);
    expect(pages.every((c) => c.search.includes("limit=100"))).toBe(true);
    expect(pages.filter((c) => c.search.includes("before=")).length).toBe(2);
    expect(new Set(list.map((c) => c.id)).size).toBe(230);

    const added = await b.comments!.add!(meta(), ref, markdown("Looks **fixed**"), { idempotencyKey: "c1" });
    expect(added.warnings).toEqual([]);
    expect(added.comment).toMatchObject({ author: { remoteId: sim.me.id }, body: { text: "Looks **fixed**" } });
    expect((await b.comments!.list(meta(), ref)).at(-1)?.body).toMatchObject({ text: "Looks **fixed**" });
    // Trello refuses an empty comment.
    expect(await errorOf(b.comments!.add!(meta(), ref, markdown(""), { idempotencyKey: "c2" }))).toMatchObject({ kind: "invalid" });
  });

  it("a comment answered without its author is not shown as written: it is read again", async () => {
    const { b, sim } = simulated();
    const real = sim.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const res = await real(url, init);
      if (init?.method !== "POST") return res;
      const a = (await res.json()) as Record<string, unknown>;
      delete a.memberCreator;
      return new Response(JSON.stringify(a), { status: 200 });
    });
    const added = await b.comments!.add!(meta(), refOf(sim, "Ex9rtCs2"), markdown("hi"), { idempotencyKey: "c" });
    expect(added.comment).toBeNull();
    expect(sim.actions.some((a) => a.type === "commentCard" && a.data.text === "hi")).toBe(true);
  });

  it("subscribes and unsubscribes, and tells a card's history field by field, oldest first (the default listing hides all but list moves)", async () => {
    const { b, sim, anna } = simulated();
    const ref = refOf(sim, "Ex9rtCs2");
    await b.watch!(meta(), ref, true);
    expect(sim.card("Ex9rtCs2").subscribed.has(sim.me.id)).toBe(true);
    await b.watch!(meta(), ref, false);
    expect(sim.card("Ex9rtCs2").subscribed.has(sim.me.id)).toBe(false);

    sim.outside.setList("Ex9rtCs2", "Doing", anna);
    sim.outside.rename("Ex9rtCs2", "Export to CSV and XLSX");
    sim.outside.setDue("Ex9rtCs2", "2026-11-05T09:00:00.000Z");
    sim.outside.addLabel("Ex9rtCs2", { id: "lb9", name: "ui", color: "blue" });
    sim.outside.addMember("Ex9rtCs2", anna);
    sim.outside.archive("Ex9rtCs2");
    sim.outside.comment("Ex9rtCs2", "not a field change");
    const changes = await b.history!(meta(), ref);
    expect(changes.map((c) => c.field.id)).toEqual(["idList", "name", "due", "labels", "idMembers", "closed"]);
    expect(changes[0]).toMatchObject({ from: [{ text: "Backlog" }], to: [{ text: "Doing" }], actor: { name: "Anna Bianchi" } });
    expect(changes[1]).toMatchObject({ from: [{ text: "Export to CSV" }], to: [{ text: "Export to CSV and XLSX" }] });
    expect(changes[2]).toMatchObject({ from: [{ text: "2026-10-30T22:30:00.000Z" }], to: [{ text: "2026-11-05T09:00:00.000Z" }] });
    expect(changes[3]).toMatchObject({ from: [], to: [{ text: "ui" }] });
    expect(changes[4]).toMatchObject({ from: [], to: [{ text: "Anna Bianchi" }] });
    expect(changes[5]).toMatchObject({ from: [{ text: "false" }], to: [{ text: "true" }] });
    expect(changes.map((c) => c.at)).toEqual([...changes.map((c) => c.at)].sort((x, y) => x - y));
  });

  it("searches by text: prefixes need partial, archived cards and boards the user isn't on are left out", async () => {
    const { b, sim } = simulated();
    sim.addBoard("Secret", { member: false });
    sim.add("Secret", "Export secrets", { members: [] });
    sim.add("Acme Web", "Exported archive", { closed: true, members: [] });
    sim.add("Acme Web", "Exports of everything", { members: [] });
    sim.calls.length = 0;
    const r = await b.searchText!(meta(), "expo", 10);
    expect(r.items.map((i) => i.title).sort()).toEqual(["Export to CSV", "Exports of everything"]);
    expect(r.complete).toBe(true);
    expect(sim.calls.find((c) => c.path === "/1/search")?.search).toContain("partial=true");
    // Cards are found by the words of the title, not only by prefix.
    expect((await b.searchText!(meta(), "csv", 10)).items.map((i) => i.key)).toEqual(["Ex9rtCs2"]);
    // Cut short when the limit is reached; the limit is capped at 1,000 (the most Trello takes).
    expect((await b.searchText!(meta(), "expo", 1)).complete).toBe(false);
    await b.searchText!(meta(), "expo", 5000);
    expect(sim.calls.filter((c) => c.path === "/1/search").at(-1)?.search).toContain("cards_limit=1000");
  });
});

describe("trello, the traps of its API", () => {
  it("sends the key and token in the Authorization header, never in the URL", async () => {
    const { b, sim } = simulated();
    await b.verify(meta());
    await pass(b);
    expect(sim.calls.length).toBeGreaterThan(2);
    for (const c of sim.calls) {
      expect(c.authorization).toBe(`OAuth oauth_consumer_key="${sim.key}", oauth_token="${sim.token}"`);
      expect(c.search).not.toContain(sim.token);
      expect(c.search).not.toContain("key=");
    }
    // The simulator takes them as query parameters too (as Trello does): that is not what is sent.
    const viaQuery = await sim.fetch(`${sim.apiBase}/1/members/me?key=${sim.key}&token=${sim.token}`);
    expect(viaQuery.status).toBe(200);
  });

  it("a wrong key or token is auth (a plain-text 401), a secret that isn't key:token never leaves the server", async () => {
    const wrongToken = simulated({ secret: `${trelloSimulator().key}:nottheoken123` });
    expect(await errorOf(wrongToken.b.verify(meta()))).toMatchObject({ kind: "auth", status: 401, message: expect.stringContaining("invalid token") });
    const wrongKey = simulated({ secret: "wrongkey1234:simtoken_0123456789" });
    expect(await errorOf(wrongKey.b.verify(meta()))).toMatchObject({ kind: "auth", message: expect.stringContaining("invalid key") });
    expect(await errorOf(pass(wrongToken.b))).toMatchObject({ kind: "auth" });

    const malformed = simulated({ secret: "justonepiece" });
    malformed.sim.calls.length = 0;
    expect(await errorOf(malformed.b.verify(meta()))).toMatchObject({ kind: "auth", message: expect.stringContaining("<key>:<token>") });
    expect(malformed.sim.calls).toEqual([]);

    const revoked = simulated();
    revoked.sim.revoke();
    expect(await errorOf(revoked.b.verify(meta()))).toMatchObject({ kind: "auth" });
  });

  it("a card on a board the token can't read is a 401 about permissions: forbidden, not a bad token, and not there for lookups", async () => {
    const { b, sim } = simulated();
    const ref = refOf(sim, "Lg4nS4f1");
    sim.outside.leaveBoard("Acme Web");
    expect(await b.getIssue(meta(), ref)).toBeNull();
    expect((await b.findIssue(meta(), { key: "Lg4nS4f1" })).kind).toBe("none");
    expect(await errorOf(b.comments!.list(meta(), ref))).toMatchObject({ kind: "forbidden", status: 401, message: expect.stringContaining("unauthorized card permission") });
    expect(await errorOf(b.transitions!.list!(meta(), ref))).toMatchObject({ kind: "notFound" });
    // The pass simply no longer sees the board's cards.
    expect((await pass(b)).items.map((i) => i.key)).toEqual(["Rt8Crt03"]);
    // And the credentials still work.
    expect((await b.verify(meta())).remoteId).toBe(sim.me.id);
  });

  it("a malformed id is 400 'invalid id' (none when looked up), a deleted card a plain-text 404", async () => {
    const { b, sim } = simulated();
    expect((await b.findIssue(meta(), { key: "Lg4nS4f1999" })).kind).toBe("none");
    expect(await b.getIssue(meta(), { remoteId: "xyz", key: "xyz" })).toBeNull();
    expect(await errorOf(b.comments!.list(meta(), { remoteId: "xyz", key: "xyz" }))).toMatchObject({ kind: "invalid", status: 400, message: "Trello: invalid id" });
    // Well-formed but unknown.
    expect((await b.findIssue(meta(), { key: "Zz9Unknw" })).kind).toBe("none");
    sim.outside.delete("An7Own04");
    expect(await errorOf(b.comments!.list(meta(), refOf(sim, "An7Own04")))).toMatchObject({ kind: "notFound", status: 404, message: expect.stringContaining("not found") });
  });

  it("over the budget is a 429 with the window to wait (no Retry-After), whichever budget is empty", async () => {
    const { b, sim } = simulated();
    sim.state.tokenBudget = 4;
    sim.calls.length = 0;
    const errors: unknown[] = [];
    for (let n = 0; n < 6; n++) errors.push(await errorOf(b.verify(meta())));
    expect(errors.slice(0, 4)).toEqual([null, null, null, null]);
    expect(errors[4]).toMatchObject({ kind: "rateLimit", status: 429, transient: true, rateLimit: { retryAfterMs: 10_000, remaining: 0 } });

    const other = simulated();
    other.sim.exhaust();
    expect(await errorOf(other.b.verify(meta()))).toMatchObject({ kind: "rateLimit" });
    other.sim.refill();
    expect((await other.b.verify(meta())).name).toBe("Mario Rossi");

    // A key budget alone empty: its own window sets the wait.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "API_KEY_LIMIT_EXCEEDED", message: "Rate limit exceeded" }), {
          status: 429,
          headers: { "x-rate-limit-api-token-interval-ms": "10000", "x-rate-limit-api-token-remaining": "40", "x-rate-limit-api-key-interval-ms": "30000", "x-rate-limit-api-key-remaining": "0" },
        }),
    );
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 30_000 } });
  });

  it("reads the call budget from the headers: the token's 100 per 10 seconds is 10 a second", async () => {
    const { b } = simulated();
    expect((await b.probe(meta())).rateLimit).toEqual({ perSecond: TOKEN_BUDGET / 10, origin: "detected" });
    expect(KEY_BUDGET).toBeGreaterThan(TOKEN_BUDGET);
    // No headers: the documented figure, as typical.
    vi.stubGlobal("fetch", async (url: string) => new Response(String(url).includes("/boards") ? "[]" : JSON.stringify({ id: "m1" }), { status: 200 }));
    expect(await b.probe(meta())).toMatchObject({ activeSources: [], rateLimit: { perSecond: 10, origin: "typical" } });
  });

  it("a server error is unavailable, and an answer that isn't JSON is incompatible", async () => {
    const { b } = simulated();
    vi.stubGlobal("fetch", async () => new Response("Trello is down for maintenance", { status: 503 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "unavailable", message: expect.stringContaining("maintenance") });
    vi.stubGlobal("fetch", async () => new Response("<html>hello</html>", { status: 200 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "incompatible" });
  });

  it("asks for every page of the actions it reads, with an explicit limit (the default is 50, the maximum 1,000)", async () => {
    const { sim } = simulated();
    const res = await sim.fetch(`${sim.apiBase}/1/cards/Lg4nS4f1/actions?filter=commentCard&limit=1001`, { headers: { authorization: `OAuth oauth_consumer_key="${sim.key}", oauth_token="${sim.token}"` } });
    expect(res.status).toBe(400);
  });
});

describe("trello webhooks", () => {
  const secret = "app-secret-0123";
  const callbackUrl = "https://ikl.example.com/api/hooks/9/token";
  const action = { type: "updateCard", data: { card: { id: "c1", shortLink: "Lg4nS4f1" } } };

  it("accepts a delivery signed with the app's secret over body + callback URL, and reads its id, time and event", () => {
    const { sim } = simulated();
    const d = sim.webhook({ ...action, id: "a1", date: "2026-10-21T10:00:00.000Z" }, { secret, callbackUrl });
    expect(trelloWebhook.verify({ secret, callbackUrl, rawBody: d.rawBody, headers: d.headers })).toBe(true);
    expect(trelloWebhook.verify({ secret, callbackUrl, rawBody: d.rawBody, headers: new Headers(d.headers) })).toBe(true);
    // The header name is any case.
    expect(trelloWebhook.verify({ secret, callbackUrl, rawBody: d.rawBody, headers: { "X-Trello-Webhook": d.headers["x-trello-webhook"] } })).toBe(true);
    expect(trelloWebhook.deliveryId(d.rawBody)).toBe("a1");
    expect(trelloWebhook.sentAt(d.rawBody)).toBe(Date.parse("2026-10-21T10:00:00.000Z"));
    expect(trelloWebhook.event(d.rawBody)).toBe("issueChanged");
    expect(trelloWebhook.event(sim.webhook({ type: "commentCard", data: {} }, { secret, callbackUrl }).rawBody)).toBe("commentAdded");
    expect(trelloWebhook.event(sim.webhook({ type: "deleteCard", data: {} }, { secret, callbackUrl }).rawBody)).toBe("issueRemoved");
    expect(trelloWebhook.event(sim.webhook({ type: "createList", data: {} }, { secret, callbackUrl }).rawBody)).toBeNull();
    expect(trelloWebhook.deliveryId("not json")).toBeNull();
    expect(trelloWebhook.sentAt("{}")).toBeNull();
    expect(trelloWebhook.event("[]")).toBeNull();
  });

  it("refuses a wrong secret, another callback URL, a body changed after signing, and a missing or malformed signature", () => {
    const { sim } = simulated();
    const wrong = sim.webhook(action, { secret, callbackUrl, signedWith: "other" });
    expect(trelloWebhook.verify({ secret, callbackUrl, rawBody: wrong.rawBody, headers: wrong.headers })).toBe(false);
    // The URL is part of what is signed: a delivery for another address is not ours.
    const elsewhere = sim.webhook(action, { secret, callbackUrl, callbackSignedWith: "https://other.example.com/hook" });
    expect(trelloWebhook.verify({ secret, callbackUrl, rawBody: elsewhere.rawBody, headers: elsewhere.headers })).toBe(false);
    const ok = sim.webhook(action, { secret, callbackUrl });
    expect(trelloWebhook.verify({ secret, callbackUrl, rawBody: ok.rawBody.replace("updateCard", "deleteCard"), headers: ok.headers })).toBe(false);
    expect(trelloWebhook.verify({ secret, callbackUrl, rawBody: ok.rawBody, headers: {} })).toBe(false);
    expect(trelloWebhook.verify({ secret, callbackUrl, rawBody: ok.rawBody, headers: { "x-trello-webhook": "zz" } })).toBe(false);
    expect(trelloWebhook.verify({ secret, callbackUrl: `${callbackUrl}/`, rawBody: ok.rawBody, headers: ok.headers })).toBe(false);
  });

  it("the contract's check takes the stored secret as '<app secret>\\n<callback URL>' and refuses a bare secret", () => {
    const { sim } = simulated();
    const d = sim.webhook(action, { secret, callbackUrl });
    const req = { headers: d.headers, body: d.rawBody };
    expect(trelloProvider.webhook!.verify(req, `${secret}\n${callbackUrl}`)).toBe(true);
    // A secret the connection generated itself can't match Trello's app secret.
    expect(trelloProvider.webhook!.verify(req, secret)).toBe(false);
    expect(trelloProvider.webhook!.verify(req, `other\n${callbackUrl}`)).toBe(false);
    expect(trelloProvider.webhook!.verify(req, "")).toBe(false);
    expect(trelloProvider.webhook!.deliveryId(req)).toMatch(/^[0-9a-f]{24}$/);
    expect(trelloProvider.webhook!.sentAt!(req)).toBeGreaterThan(0);
  });
});
