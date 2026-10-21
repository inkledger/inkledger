import { afterEach, describe, expect, it, vi } from "vitest";
import { instant, markdown, timeZone } from "@contracts/values";
import type { Credential } from "../types";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import { API_VERSION } from "./client";
import { CURSOR_LIFE_MS, SINGLE_QUERY_LIMIT, column, mondaySimulator, type SimItem } from "./simulator";
import { mondayProvider, mondayWebhook, toMondayHtml, trackedSeconds } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "104.18.0.1", family: 4 }]),
}));

afterEach(() => {
  vi.useRealTimers();
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });

const WEB_COLUMNS = [column.name(), column.people(), column.status(), column.priority(), column.date(), column.timeline(), column.tags(), column.tracking(), column.description(), column.text()];
const ITALIAN = column.status("status", "Stato", { 0: "In corso", 1: "Fatto", 2: "Bloccato", 3: "Da fare", 5: "" }, [1]);

function simulated(o: { credential?: () => Promise<Credential>; options?: unknown; zone?: string } = {}) {
  const sim = mondaySimulator();
  const anna = sim.addUser("Anna Bianchi");
  const web = sim.addBoard("Website", { columns: WEB_COLUMNS, workspace: "Marketing" });
  const ops = sim.addBoard("Operazioni", { columns: [column.name(), column.people(), ITALIAN] });
  const login = sim.add(web.id, "Login fails on Safari", {
    status: "Working on it",
    priority: "High",
    due: "2026-10-30",
    start: "2026-10-26",
    end: "2026-11-02",
    tags: ["bug", "ui"],
    tracked: 5400,
    description: "Steps:\n1. open\n2. fail",
    cells: { text: "Safari 17" },
  });
  const csv = sim.add(web.id, "Export to CSV");
  sim.add(web.id, "Someone else's", { assignee: anna });
  const certs = sim.add(ops.id, "Rotate certificates", { status: "In corso" });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 8,
    userId: 1,
    type: "monday" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: sim.me.id,
    options: o.options ?? {},
    timeZone: timeZone(o.zone ?? "Europe/Rome"),
    credential: o.credential ?? (async () => ({ kind: "token" as const, token: "mon_test_token" })),
  };
  return { sim, anna, web, ops, login, csv, certs, conn, b: bindTracker(mondayProvider, conn) };
}

const keyOf = (i: SimItem) => `${i.boardId}#${i.id}`;
const refOf = (i: SimItem) => ({ remoteId: i.id, key: keyOf(i) });
const pass = (b: ReturnType<typeof simulated>["b"], since: Parameters<typeof b.listChanged>[1]["since"] = null) => readPass((q) => b.listChanged(meta(), q), since);
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; status?: number; rateLimit?: { retryAfterMs?: number; remaining?: number }; message: string });

trackerConformance("monday (simulated)", async () => {
  const { conn, login, sim } = simulated();
  return { provider: mondayProvider, conn, key: keyOf(login), writable: true, url: sim.urlOf(login) };
});

describe("monday, items", () => {
  it("lists the items whose people column holds the user, keyed board#item, in their board, with the label and its category", async () => {
    const { b, login, csv, certs, web, ops } = simulated();
    const all = await pass(b);
    expect(all.items.map((i) => [i.key, i.container.name, i.status.name, i.status.category])).toEqual([
      // Boards newest first, items in board order.
      [keyOf(certs), "Operazioni", "In corso", "todo"],
      [keyOf(login), "Website", "Working on it", "todo"],
      [keyOf(csv), "Website", "No status", "backlog"],
    ]);
    expect(all.items.every((i) => i.status.source.kind === "projectField" && i.container.kind === "board")).toBe(true);
    expect(all.items[0].status.source).toEqual({ kind: "projectField", fieldRemoteId: "status", containerRemoteId: ops.id });
    expect(all.items[1].container).toMatchObject({ remoteId: web.id, key: web.id, group: "Marketing" });
    // The main workspace has no id and no name: no group.
    expect(all.items[0].container).not.toHaveProperty("group");
    // The id is the identity; the key is board and item.
    expect(all.items[1].remoteId).toBe(login.id);
    expect(all.gone).toEqual([]);
  });

  it("reads 'done' from the column's done colours, the empty label as no status, and the rest from the connection's own mapping", async () => {
    const { b, sim, login, certs } = simulated({ options: { categories: { "WORKING ON IT": "doing", "in corso": "doing" } } });
    sim.outside.setStatus(certs.id, "Fatto");
    const items = (await pass(b)).items;
    expect(items.find((i) => i.key === keyOf(certs))?.status).toMatchObject({ name: "Fatto", category: "done", categoryOrigin: { by: "native" } });
    expect(items.find((i) => i.key === keyOf(login))?.status).toMatchObject({ category: "doing", categoryOrigin: { by: "mapping" } });
    // "Stuck" is not in the mapping, and the Italian board's "Bloccato" neither.
    sim.outside.setStatus(login.id, "Stuck");
    expect((await b.getIssue(meta(), refOf(login)))?.status.category).toBe("todo");
  });

  it("reads priority, tags, dates, the timeline's start, the tracked time, the people and the other columns", async () => {
    const { b, login, csv, sim, anna } = simulated();
    sim.outside.assign(login.id, [sim.me, anna]);
    const i = await b.getIssue(meta(), refOf(login));
    expect(i?.priority).toEqual({ id: "1", name: "High", rank: null });
    expect(i?.labels).toEqual(["bug", "ui"]);
    expect(i?.due).toBe("2026-10-30");
    // The time tracking column is read, never written.
    expect(i?.spentSeconds).toBe(5400);
    expect(i?.estimateSeconds).toBeNull();
    expect(i?.fields).toEqual({ start: "2026-10-26", group: "To Do", text: "Safari 17" });
    expect(i?.assignees.map((p) => p.name)).toEqual(["Mario Rossi", "Anna Bianchi"]);
    expect(i?.reporter?.name).toBe("Mario Rossi");
    expect(i?.statusChangedAt).toBe(Date.parse(sim.item(login.id).cells.status ? (sim.item(login.id).cells.status as { changed_at: string }).changed_at : ""));
    const plain = await b.getIssue(meta(), refOf(csv));
    expect(plain?.priority).toBeNull();
    expect(plain?.spentSeconds).toBeUndefined();
  });

  it("people cells hold ids as numbers and teams beside people: only the people count", async () => {
    const { b, login, sim } = simulated();
    sim.item(login.id).cells.person = { personsAndTeams: [{ id: 3003, kind: "team" }, { id: Number(sim.me.id), kind: "person" }] };
    expect((await b.getIssue(meta(), refOf(login)))?.assignees.map((p) => p.remoteId)).toEqual([sim.me.id]);
  });

  it("a date's time of day is UTC: the user's day is the one in their zone; a day alone stays the day it says", async () => {
    const { b, login, csv, sim } = simulated({ zone: "Europe/Rome" });
    sim.outside.setDue(login.id, "2026-10-30", "23:30:00");
    expect((await b.getIssue(meta(), refOf(login)))?.due).toBe("2026-10-31");
    sim.outside.setDue(csv.id, "2026-10-30");
    expect((await b.getIssue(meta(), refOf(csv)))?.due).toBe("2026-10-30");
    const west = simulated({ zone: "America/Los_Angeles" });
    west.sim.outside.setDue(west.login.id, "2026-10-30", "03:00:00");
    expect((await west.b.getIssue(meta(), refOf(west.login)))?.due).toBe("2026-10-29");
  });

  it("a running timer counts up to now; `running` comes as a string", async () => {
    const { b, login, sim } = simulated();
    sim.outside.track(login.id, 600, true);
    const cell = sim.item(login.id).cells.time_tracking as { running: unknown; startDate: number };
    expect(cell.running).toBe("true");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((cell.startDate + 120) * 1000);
    expect((await b.getIssue(meta(), refOf(login)))?.spentSeconds).toBe(720);
    expect(trackedSeconds(JSON.stringify({ duration: 60, running: "false", startDate: 1 }), Date.now())).toBe(60);
    expect(trackedSeconds(null, Date.now())).toBeNull();
  });

  it("pages boards by number and items by cursor, newest board first, and every id past 2^31 stays a string", async () => {
    const { b, sim, ops } = simulated();
    for (let n = 0; n < 120; n++) sim.add(ops.id, `Bulk ${n}`);
    for (let n = 0; n < 30; n++) sim.addBoard(`Extra ${n}`);
    const total = sim.items.filter((i) => i.state === "active" && JSON.stringify(i.cells.person ?? {}).includes(sim.me.id)).length;
    const full = await pass(b);
    expect(full.pages).toBeGreaterThanOrEqual(4);
    expect(full.items).toHaveLength(total);
    expect(new Set(full.items.map((i) => i.remoteId)).size).toBe(total);
    expect(Number(full.items[0].remoteId)).toBeGreaterThan(2 ** 31);
    expect(sim.calls.some((c) => c.operationName === "NextItems")).toBe(true);
    // 30 boards with no item: still found by their page, then skipped without a query of their own.
    expect(sim.calls.filter((c) => c.operationName === "BoardItems").length).toBeLessThanOrEqual(sim.boards.length);
  });

  it("reads only what changed since a checkpoint: the filter takes a day, the adapter cuts at the moment", async () => {
    const { b, sim, csv, login } = simulated();
    vi.useFakeTimers({ toFake: ["Date"] });
    sim.advance(10 * 60_000);
    vi.setSystemTime(sim.now() + 1000);
    const first = await pass(b);
    sim.advance(10 * 60_000);
    sim.outside.setStatus(csv.id, "Working on it");
    vi.setSystemTime(sim.now() + 1000);
    // Everything was touched the same UTC day: the server returns it all, only the item changed since is kept.
    const next = await pass(b, first.checkpoint);
    expect(next.items.map((i) => [i.key, i.status.name])).toEqual([[keyOf(csv), "Working on it"]]);
    expect(next.checkpoint).not.toBe(first.checkpoint);
    const rule = sim.calls.filter((c) => c.operationName === "BoardItems").length;
    expect(rule).toBeGreaterThan(0);
    expect(next.items.map((i) => i.key)).not.toContain(keyOf(login));
  });

  it("reports deleted and archived items as deleted when they left a board; a first read says nothing; by id a deleted one is none and an archived one is readable", async () => {
    const { b, sim, ops } = simulated();
    const gone = sim.add(ops.id, "To delete");
    const old = sim.add(ops.id, "To archive");
    const away = sim.add(ops.id, "To hand over");
    vi.useFakeTimers({ toFake: ["Date"] });
    sim.advance(10 * 60_000);
    vi.setSystemTime(sim.now() + 1000);
    const first = await pass(b);
    expect(first.items.map((i) => i.remoteId)).toEqual(expect.arrayContaining([gone.id, old.id, away.id]));
    sim.advance(10 * 60_000);
    sim.outside.delete(gone.id);
    sim.outside.archive(old.id);
    sim.outside.assign(away.id, [sim.users.get([...sim.users.keys()][1])!]);
    vi.setSystemTime(sim.now() + 1000);
    const next = await pass(b, first.checkpoint);
    expect(next.items).toEqual([]);
    // Handing an item over is not reported (movedOut is not declared): reconciliation finds it.
    expect([...next.gone].sort((x, y) => x.remoteId.localeCompare(y.remoteId))).toEqual([
      { remoteId: gone.id, reason: "deleted" },
      { remoteId: old.id, reason: "deleted" },
    ].sort((x, y) => x.remoteId.localeCompare(y.remoteId)));
    expect(await b.getIssue(meta(), refOf(gone))).toBeNull();
    expect((await b.findIssue(meta(), { key: keyOf(gone) })).kind).toBe("none");
    expect((await b.getIssue(meta(), refOf(old)))?.key).toBe(keyOf(old));
    const again = await pass(b);
    expect(again.gone).toEqual([]);
    expect(again.items.map((i) => i.remoteId)).not.toContain(gone.id);
    expect(again.items.map((i) => i.remoteId)).not.toContain(old.id);
  });

  it("parses keys and web links (with a view, on any subdomain), finds the item, and follows a move to another board by id", async () => {
    const { b, sim, login, ops } = simulated();
    expect(b.normalizeKey("1200000101#9000000102")).toBe("1200000101#9000000102");
    expect(b.normalizeKey("1200000101-9000000102")).toBeNull();
    expect(b.normalizeKey("9000000102")).toBeNull();
    expect(b.parseRef(`https://acme.monday.com/boards/12/pulses/34`)).toEqual({ remoteId: "34", key: "12#34" });
    expect(b.parseRef(`https://acme.monday.com/boards/12/views/56/pulses/34`)).toEqual({ remoteId: "34", key: "12#34" });
    expect(b.parseRef(`https://monday.com/boards/12/pulses/34/`)).toEqual({ remoteId: "34", key: "12#34" });
    expect(b.parseRef(`https://acme.monday.com/boards/12`)).toBeNull();
    expect(b.parseRef(`http://acme.monday.com/boards/12/pulses/34`)).toBeNull();
    expect(b.parseRef(`https://notmonday.com/boards/12/pulses/34`)).toBeNull();
    expect(b.parseRef(`https://acme.monday.com.evil.example/boards/12/pulses/34`)).toBeNull();
    expect(b.parseRef(keyOf(login))).toEqual({ key: keyOf(login) });

    const before = await b.findIssue(meta(), { key: keyOf(login) });
    if (before.kind !== "found") throw new Error("not found");
    sim.outside.moveToBoard(login.id, ops.id);
    // Same id, new key: the old key still leads there (the id is what counts) and says the new one.
    const viaOld = await b.findIssue(meta(), { key: `${before.issue.container.remoteId}#${login.id}` });
    expect(viaOld.kind === "found" && [viaOld.issue.remoteId, viaOld.issue.key, viaOld.issue.container.name]).toEqual([login.id, `${ops.id}#${login.id}`, "Operazioni"]);
    expect((await b.getIssue(meta(), { remoteId: login.id, key: keyOf(login) }))?.key).toBe(`${ops.id}#${login.id}`);
    expect((await pass(b)).items.map((i) => i.key)).toContain(`${ops.id}#${login.id}`);
    // Cells follow where the column ids match, and a label is the new board's own number: index 0 there is its own word.
    expect((await b.getIssue(meta(), refOf(login)))?.status).toMatchObject({ name: "In corso", source: { containerRemoteId: ops.id } });
  });

  it("lists subitems from their hidden board, with the parent; skips documents, boards without a people or status column, and boards it can't see", async () => {
    const { b, sim, login, web } = simulated();
    const sub = sim.addSubitem(login.id, "Reproduce on iOS");
    sim.addBoard("Spec", { type: "document" });
    const plain = sim.addBoard("Notes only", { columns: [column.name(), column.text()] });
    sim.add(plain.id, "never listed");
    const hidden = sim.addBoard("Secret", { access: false });
    sim.add(hidden.id, "never seen");
    const items = (await pass(b)).items;
    const s = items.find((i) => i.remoteId === sub.id);
    expect(s).toMatchObject({ title: "Reproduce on iOS", type: { id: "item", name: "Subitem", level: "sub" }, parent: { remoteId: login.id, key: `${web.id}#${login.id}` } });
    expect(s?.container.name).toBe("Subitems of Website");
    expect(items.map((i) => i.title)).not.toContain("never listed");
    expect(items.map((i) => i.title)).not.toContain("never seen");
    // A board the user can no longer see is skipped, not an error.
    sim.outside.revokeBoard(web.id);
    expect((await pass(b)).items.map((i) => i.title)).not.toContain("Login fails on Safari");
  });

  it("maps the workflow per board: sources, statuses with positions, and any other label as a way out", async () => {
    const { b, sim, ops, web, certs } = simulated();
    const sources = (await b.probe(meta())).activeSources;
    expect(sources.map((s) => [s.name, s.ref])).toEqual([
      ["Operazioni", { kind: "projectField", fieldRemoteId: "status", containerRemoteId: ops.id }],
      ["Website", { kind: "projectField", fieldRemoteId: "status", containerRemoteId: web.id }],
    ]);
    // The priority column is a status column too: never the workflow.
    const statuses = await b.statuses!(meta(), sources[1]);
    expect(statuses.map((s) => [s.id, s.name, s.category])).toEqual([
      ["0", "Working on it", "todo"],
      ["1", "Done", "done"],
      ["2", "Stuck", "todo"],
    ]);
    const italian = await b.statuses!(meta(), sources[0]);
    expect(italian.map((s) => s.name)).toEqual(["In corso", "Fatto", "Bloccato", "Da fare"]);
    expect(italian.map((s) => s.order)).toEqual([0, 1, 2, 3]);

    const ways = await b.transitions!.list!(meta(), refOf(certs));
    expect(ways.map((t) => [t.id, t.name, t.to.category])).toEqual([
      ["1", "Fatto", "done"],
      ["2", "Bloccato", "todo"],
      ["3", "Da fare", "todo"],
    ]);
    expect(ways.every((t) => t.requirements.length === 0 && /^https:\/\/acme\.monday\.com\//.test(t.remoteUrl ?? ""))).toBe(true);
    const done = await b.transitions!.apply!(meta(), refOf(certs), "1", {});
    expect(done?.status).toMatchObject({ name: "Fatto", category: "done" });
    expect(done?.statusChangedAt).toBe(Date.parse((sim.item(certs.id).cells.status as { changed_at: string }).changed_at));
    // The value goes as JSON in a string, by index.
    expect(sim.item(certs.id).cells.status).toMatchObject({ index: 1 });
  });

  it("refuses what monday refuses: a label the board doesn't have, a board the user can only read, a deleted item", async () => {
    const { b, sim, certs, login, ops } = simulated();
    await expect(b.transitions!.apply!(meta(), refOf(certs), "9", {})).rejects.toMatchObject({ kind: "invalid" });
    await expect(b.transitions!.apply!(meta(), refOf(certs), "not-a-number", {})).rejects.toMatchObject({ kind: "invalid" });
    sim.board(ops.id).readOnly = true;
    await expect(b.transitions!.apply!(meta(), refOf(certs), "1", {})).rejects.toMatchObject({ kind: "forbidden" });
    sim.outside.delete(login.id);
    await expect(b.transitions!.apply!(meta(), refOf(login), "1", {})).rejects.toMatchObject({ kind: "notFound" });
    await expect(b.transitions!.list!(meta(), refOf(login))).rejects.toMatchObject({ kind: "notFound" });
  });

  it("reads the description from the board's description column, and comments as HTML with replies, oldest first, even from users who left", async () => {
    const { b, sim, login, csv, anna } = simulated();
    expect(await b.description!(meta(), refOf(login))).toEqual({ kind: "text", format: "plain", text: "Steps:\n1. open\n2. fail" });
    expect(await b.description!(meta(), refOf(csv))).toBeNull();
    const first = sim.outside.comment(login.id, "<p>Deployed to <strong>staging</strong></p>", { as: null });
    sim.outside.comment(login.id, "<p>Thanks</p>", { as: anna, replyTo: first.id });
    await b.comments!.add!(meta(), refOf(login), markdown("Looks **fixed**\n\n- one\n- two"), { idempotencyKey: "c1" });
    const list = await b.comments!.list(meta(), refOf(login));
    expect(list.map((c) => [c.author.name, c.body])).toEqual([
      ["Deleted user", { kind: "text", format: "html", text: "<p>Deployed to <strong>staging</strong></p>" }],
      ["Anna Bianchi", { kind: "text", format: "html", text: "<p>Thanks</p>" }],
      ["Mario Rossi", { kind: "text", format: "html", text: "<p>Looks <strong>fixed</strong></p><ul><li>one</li><li>two</li></ul>" }],
    ]);
    // More than a page of updates: all are read.
    for (let n = 0; n < 120; n++) sim.outside.comment(csv.id, `<p>c${n}</p>`);
    expect(await b.comments!.list(meta(), refOf(csv))).toHaveLength(120);
    await expect(b.comments!.list(meta(), { remoteId: "123", key: "1#123" })).rejects.toMatchObject({ kind: "notFound" });
    await expect(b.comments!.add!(meta(), { remoteId: "123", key: "1#123" }, markdown("x"), { idempotencyKey: "c2" })).rejects.toMatchObject({ kind: "notFound" });
  });

  it("writes Markdown as the HTML an update keeps, and says what it could not keep", () => {
    const r = toMondayHtml("# Title\n\nSome *emphasis*, **strong**, `code` & [a link](https://example.com/a?b=1&c=2) and [bad](javascript:alert(1))\n\n1. one\n2. two\n\n> quoted\n\n| a | b |\n|---|---|");
    expect(r.html).toBe(
      '<p>Title</p><p>Some <em>emphasis</em>, <strong>strong</strong>, code &amp; <a href="https://example.com/a?b=1&amp;c=2">a link</a> and bad)</p><ol><li>one</li><li>two</li></ol><p>quoted</p><p>| a | b |</p><p>|---|---|</p>',
    );
    expect(r.warnings.map((w) => w.feature).sort()).toEqual(["code", "heading", "quote", "table"]);
    expect(toMondayHtml("<script>x</script>").html).toBe("<p>&lt;script&gt;x&lt;/script&gt;</p>");
  });

  it("tells an item's history from the activity log, field by field, oldest first, in the log's 17-digit time", async () => {
    const { b, sim, login, anna } = simulated();
    sim.outside.setStatus(login.id, "Done", anna);
    sim.outside.assign(login.id, [anna], anna);
    sim.outside.rename(login.id, "Login fails everywhere", anna);
    sim.outside.setDue(login.id, "2026-11-12", undefined, anna);
    const changes = await b.history!(meta(), refOf(login));
    expect(changes.map((c) => c.field.id)).toEqual(["status", "person", "name", "date"]);
    expect(changes[0]).toMatchObject({ field: { name: "Status" }, from: [{ text: "Working on it" }], to: [{ text: "Done", id: "1" }], actor: { name: "Anna Bianchi" } });
    expect(changes[1]).toMatchObject({ from: [{ text: "Mario Rossi" }], to: [{ text: "Anna Bianchi" }] });
    expect(changes[2]).toMatchObject({ from: [{ text: "Login fails on Safari" }], to: [{ text: "Login fails everywhere" }] });
    expect(changes[3]).toMatchObject({ from: [{ text: "2026-10-30" }], to: [{ text: "2026-11-12" }] });
    expect(changes.map((c) => c.at)).toEqual([...changes.map((c) => c.at)].sort((x, y) => x - y));
    // 17 digits of tenths of a microsecond, read as the instant it is.
    expect(changes[0].at).toBe(sim.logs.find((l) => l.event === "update_column_value")!.at);
    expect(String(sim.logs.at(-1)!.at * 10_000)).toHaveLength(17);
    await expect(b.history!(meta(), { remoteId: "1", key: "1#1" })).rejects.toMatchObject({ kind: "notFound" });
  });

  it("searches the names across boards, a few boards a query, and says when it cut short", async () => {
    const { b, sim, ops } = simulated();
    for (let n = 0; n < 12; n++) {
      const board = sim.addBoard(`Team ${n}`);
      sim.add(board.id, `csv task ${n}`, { assignee: null });
    }
    sim.add(ops.id, "Another CSV");
    const r = await b.searchText!(meta(), "csv", 50);
    // Also the items of others: it searches what the user can see.
    expect(r.items.map((i) => i.title).sort()).toEqual(["Another CSV", "Export to CSV", ...Array.from({ length: 12 }, (_, n) => `csv task ${n}`)].sort());
    expect(r.complete).toBe(true);
    expect((await b.searchText!(meta(), "csv", 3)).complete).toBe(false);
    expect(Math.max(...sim.calls.map((c) => c.cost))).toBeLessThanOrEqual(SINGLE_QUERY_LIMIT);
  });

  it("keeps time in inkledger: the tracked time is read, there are no worklogs, no query language, no watch", () => {
    expect(mondayProvider.capabilities.time).toEqual({ mode: "local", remoteTotals: true });
    expect(mondayProvider.worklogs).toBeUndefined();
    expect("query" in mondayProvider).toBe(false);
    expect("watch" in mondayProvider).toBe(false);
  });
});

describe("monday, the traps of its API", () => {
  it("sends a personal token as is, an OAuth token as Bearer, and pins the schema with API-Version on every call", async () => {
    const tok = simulated();
    await tok.b.verify(meta());
    await tok.b.getIssue(meta(), refOf(tok.login));
    expect(tok.sim.calls.at(-1)?.authorization).toBe("mon_test_token");
    expect(tok.sim.calls.every((c) => c.version === API_VERSION)).toBe(true);

    const oauth = simulated({ credential: async () => ({ kind: "oauth", accessToken: "mon_oauth_token", expiresAt: instant(Date.now() + 3_600_000) }) });
    expect((await oauth.b.verify(meta())).name).toBe("Mario Rossi");
    expect(oauth.sim.calls.at(-1)?.authorization).toBe("Bearer mon_oauth_token");

    // A version monday doesn't know is refused, not guessed.
    const raw = await tok.sim.fetch(tok.sim.apiBase, { method: "POST", headers: { authorization: "mon_test_token", "api-version": "2019-01" }, body: JSON.stringify({ operationName: "Me", query: "" }) });
    expect(raw.status).toBe(400);
  });

  it("a bad token is an auth error, in monday's flat shape or the GraphQL one, whatever the call", async () => {
    const { b } = simulated({ credential: async () => ({ kind: "token", token: "revoked" }) });
    await expect(b.verify(meta())).rejects.toMatchObject({ kind: "auth", status: 401 });
    await expect(pass(b)).rejects.toMatchObject({ kind: "auth" });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors: [{ message: "Not Authenticated", extensions: { code: "UserUnauthorizedException" } }] }), { status: 200 }));
    await expect(b.verify(meta())).rejects.toMatchObject({ kind: "auth" });
    // The same exception name on its own, for a write the user may not do, is a missing permission.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors: [{ message: "User unauthorized to perform action", extensions: { code: "UserUnauthorizedException" } }] }), { status: 200 }));
    await expect(b.verify(meta())).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("failures arrive as HTTP 200 with errors; an unknown id is an empty list, not an error", async () => {
    const { b } = simulated();
    expect(await b.getIssue(meta(), { remoteId: "9999999999", key: "1#9999999999" })).toBeNull();
    expect((await b.findIssue(meta(), { key: "1#9999999999" })).kind).toBe("none");
    // The conformance suite's unknown key is a number the same way; one that is no number at all never leaves.
    expect((await b.findIssue(meta(), { key: "not a key" })).kind).toBe("none");
  });

  it("a request limit is HTTP 429 with Retry-After; the daily one waits longer", async () => {
    const { b, sim } = simulated();
    sim.outside.tooManyRequests(1);
    const err = await errorOf(b.verify(meta()));
    expect(err).toMatchObject({ kind: "rateLimit", status: 429 });
    expect(err?.rateLimit?.retryAfterMs).toBe(30_000);
    expect((await b.verify(meta())).remoteId).toBe(sim.me.id);
    sim.outside.tooManyRequests(1, true);
    expect((await errorOf(b.verify(meta())))?.rateLimit?.retryAfterMs).toBeGreaterThanOrEqual(3_600_000);
  });

  it("a spent complexity budget is a 200 that says in how many seconds it is back: a wait, and it comes back", async () => {
    const { b, sim } = simulated();
    sim.outside.spendBudget();
    const err = await errorOf(b.getIssue(meta(), { remoteId: "9000000101", key: "1#9000000101" }));
    expect(err).toMatchObject({ kind: "rateLimit", rateLimit: { remaining: 0 } });
    expect(err?.rateLimit?.retryAfterMs).toBe(38_000);
    expect(err?.message).toContain("budget");
    sim.advance(60_000);
    expect((await b.verify(meta())).remoteId).toBe(sim.me.id);
  });

  it("keeps every query under the single-query cap, and heavier ones are refused", async () => {
    const { b, sim, ops } = simulated();
    for (let n = 0; n < 130; n++) sim.add(ops.id, `Bulk ${n}`);
    await pass(b);
    await b.searchText!(meta(), "bulk", 100);
    expect(Math.max(...sim.calls.map((c) => c.cost))).toBeLessThanOrEqual(SINGLE_QUERY_LIMIT);
    const heavy = async (operationName: string, variables: Record<string, unknown>) => {
      const res = await sim.fetch(sim.apiBase, { method: "POST", headers: { authorization: "mon_test_token" }, body: JSON.stringify({ operationName, query: "", variables }) });
      return ((await res.json()) as { errors: { extensions: { code: string } }[] }).errors[0].extensions.code;
    };
    // 25 boards of 100 items in one query: allowed by the page cap, not by its weight.
    expect(await heavy("SearchItems", { ids: Array.from({ length: 25 }, (_, n) => String(1000 + n)), limit: 100, rules: [] })).toBe("ComplexityException");
    expect(await heavy("BoardItems", { board: ops.id, limit: 501, rules: [] })).toBe("InvalidArgumentException");
  });

  it("an expired cursor mid-pass is an invalid checkpoint (the pass starts over); a cursor takes no new filters", async () => {
    const { b, sim, ops } = simulated();
    for (let n = 0; n < 120; n++) sim.add(ops.id, `Bulk ${n}`);
    const first = await b.listChanged(meta(), { since: null, page: null });
    if (first.last) throw new Error("expected more pages");
    const second = await b.listChanged(meta(), { since: null, page: first.next });
    if (second.last) throw new Error("expected more pages");
    sim.advance(CURSOR_LIFE_MS + 1000);
    await expect(b.listChanged(meta(), { since: null, page: second.next })).rejects.toMatchObject({ kind: "invalidCheckpoint" });
    // A fresh pass works.
    expect((await pass(b)).items.length).toBeGreaterThan(120);
    // Asking for a rule the schema doesn't know is refused, as the real one would.
    const res = await sim.fetch(sim.apiBase, { method: "POST", headers: { authorization: "mon_test_token" }, body: JSON.stringify({ operationName: "BoardItems", query: "", variables: { board: ops.id, limit: 10, rules: [{ column_id: "status", compare_value: [1], operator: "between" }] } }) });
    expect(((await res.json()) as { errors: { extensions: { code: string } }[] }).errors[0].extensions.code).toBe("InvalidArgumentException");
  });

  it("a server error is unavailable, a gateway page too", async () => {
    const { b } = simulated();
    vi.stubGlobal("fetch", async () => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(b.verify(meta())).rejects.toMatchObject({ kind: "unavailable" });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error_code: "InternalServerError", error_message: "boom", status_code: 500 }), { status: 500 }));
    await expect(b.verify(meta())).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("refuses a checkpoint written by another adapter format", async () => {
    const { b } = simulated();
    await expect(b.listChanged(meta(), { since: "cp1.eyJ9" as never, page: null })).rejects.toMatchObject({ kind: "invalidCheckpoint" });
  });

  it("refuses options it does not know", () => {
    expect(() => mondayProvider.parseOptions({ categories: { Done: "finished" } })).toThrow();
    expect(mondayProvider.parseOptions(undefined)).toEqual({ categories: {} });
  });
});

describe("monday webhooks", () => {
  const secret = "signing-secret";
  const payload = { type: "update_column_value", boardId: 1, pulseId: 2 };

  it("accepts a delivery signed with the secret (Authorization, with or without Bearer) and reads its id and time", () => {
    const { sim } = simulated();
    const d = sim.webhook(payload, { secret });
    expect(mondayWebhook.verify({ secret, headers: d.headers })).toBe(true);
    expect(mondayWebhook.verify({ secret, headers: { Authorization: `Bearer ${d.headers.authorization}` } })).toBe(true);
    expect(mondayWebhook.verify({ secret, headers: new Headers(d.headers) })).toBe(true);
    expect(mondayProvider.webhook!.verify({ headers: d.headers, body: d.rawBody }, secret)).toBe(true);
    expect(mondayProvider.webhook!.deliveryId({ headers: d.headers, body: d.rawBody })).toMatch(/^[0-9a-f-]{36}$/);
    expect(mondayProvider.webhook!.sentAt!({ headers: d.headers, body: d.rawBody })).toBe(sim.now());
    expect(mondayWebhook.sentAt("not json")).toBeNull();
    expect(mondayWebhook.deliveryId("{}")).toBeNull();
  });

  it("refuses a wrong secret, a changed token, an unsigned or 'none' token, an expired one, and a missing or malformed header", () => {
    const { sim } = simulated();
    expect(mondayWebhook.verify({ secret, headers: sim.webhook(payload, { secret, signedWith: "other" }).headers })).toBe(false);
    const ok = sim.webhook(payload, { secret });
    const [h, p, s] = ok.headers.authorization.split(".");
    const forged = Buffer.from(JSON.stringify({ exp: 9_999_999_999, accountId: 1 })).toString("base64url");
    expect(mondayWebhook.verify({ secret, headers: { authorization: `${h}.${forged}.${s}` } })).toBe(false);
    expect(mondayWebhook.verify({ secret, headers: sim.webhook(payload, { secret, alg: "none" }).headers })).toBe(false);
    expect(mondayWebhook.verify({ secret, headers: { authorization: `${h}.${p}.` } })).toBe(false);
    expect(mondayWebhook.verify({ secret, headers: sim.webhook(payload, { secret, expiresInMs: -1000 }).headers })).toBe(false);
    expect(mondayWebhook.verify({ secret, headers: ok.headers, now: Date.now() + 3_600_000 })).toBe(false);
    expect(mondayWebhook.verify({ secret, headers: {} })).toBe(false);
    expect(mondayWebhook.verify({ secret, headers: { authorization: "zz" } })).toBe(false);
  });

  it("answers a subscription's challenge with the same JSON", () => {
    const { sim } = simulated();
    const c = sim.challenge("abc123", secret);
    expect(mondayWebhook.verify({ secret, headers: c.headers })).toBe(true);
    expect(mondayWebhook.challengeOf(c.rawBody)).toBe('{"challenge":"abc123"}');
    expect(mondayWebhook.challengeOf(sim.webhook(payload, { secret }).rawBody)).toBeNull();
    expect(mondayWebhook.challengeOf("nope")).toBeNull();
  });
});
