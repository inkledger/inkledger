// A monday.com in memory, for tests: the GraphQL operations the adapter sends,
// in monday's own shapes and with its documented traps, written from its public
// API documentation (not checked against a real account: see SPIKES.md).
//   - one endpoint, POST /v2; a personal token goes as is, "Bearer" is for
//     OAuth tokens; a bad token is a 401 in the flat {error_code, error_message}
//     shape, every other failure HTTP 200 with an `errors` array
//   - the schema is pinned by the API-Version header; an unknown version is refused
//   - ids are strings in GraphQL, numbers inside a cell's JSON; item ids pass
//     2^31; the main workspace has no id and no name
//   - boards come a page at a time (page numbers, 100 at most), items by cursor
//     (500 at most; a cursor lives an hour and takes no filters); activity logs
//     and updates by page number; a cell's value is JSON in a string
//   - the last-updated filter takes a day (UTC), not a moment
//   - archived and deleted items leave the board's list; by id a deleted one
//     still answers, with state "deleted"; a moved item keeps its id and takes
//     the new board; subitems live on a hidden board of their own; documents
//     are boards with no items
//   - a status label is an index of the board; "done" is whatever the column's
//     done colours say; the empty label is the blank one
//   - an activity log's time is 17 digits (tenths of a microsecond); its data is
//     JSON in a string, its ids numbers
//   - a date column's time of day is UTC
//   - a query over 5,000,000 complexity points is refused; a per-minute budget
//     runs out and says in how many seconds it comes back; plain 429s too
//   - updates (comments) are HTML, newest first, with replies inside
import { createHmac } from "node:crypto";
import { API_VERSION, type MondayBoardType, type MondayUser } from "./client";

export const SINGLE_QUERY_LIMIT = 5_000_000;
export const MINUTE_BUDGET = 10_000_000;
/** What an item weighs in a query: its columns, its board's columns, its people. */
export const ITEM_COST = 2_000;
export const MAX_ITEMS_PAGE = 500;
export const MAX_BOARDS_PAGE = 100;
export const CURSOR_LIFE_MS = 60 * 60_000;
export const VERSIONS = ["2025-04", "2025-07", "2025-10", "2026-01"];

export type ColSpec = { id: string; title: string; type: string; labels?: Record<number, string>; done?: number[] };
type SimColumn = { id: string; title: string; type: string; settings_str: string | null };
type SimBoard = { id: string; name: string; type: MondayBoardType; workspace: { id: string; name: string } | null; columns: SimColumn[]; groups: { id: string; title: string }[]; access: boolean; readOnly: boolean; state: "active" | "archived"; seq: number; parentOf?: string };
type SimUpdate = { id: string; itemId: string; replyTo: string | null; body: string; creatorId: string | null; createdAt: string; updatedAt: string };
export type SimItem = { id: string; boardId: string; name: string; state: "active" | "archived" | "deleted"; groupId: string; createdAt: string; updatedAt: string; creatorId: string; parentId: string | null; cells: Record<string, unknown> };
type Log = { id: string; boardId: string; itemId: string; event: string; data: Record<string, unknown>; at: number; userId: string };

export const DEFAULT_LABELS: Record<number, string> = { 0: "Working on it", 1: "Done", 2: "Stuck", 5: "" };

const statusSettings = (labels: Record<number, string>, done: number[]) =>
  JSON.stringify({
    labels,
    labels_positions_v2: Object.fromEntries(Object.keys(labels).map((k, i) => [k, i])),
    labels_colors: Object.fromEntries(Object.keys(labels).map((k) => [k, { color: Number(k) === 1 ? "#00c875" : "#fdab3d", border: "#00b461", var_name: "x" }])),
    done_colors: done,
  });

export const column = {
  name: (): ColSpec => ({ id: "name", title: "Name", type: "name" }),
  people: (id = "person", title = "Person"): ColSpec => ({ id, title, type: "people" }),
  status: (id = "status", title = "Status", labels: Record<number, string> = DEFAULT_LABELS, done: number[] = [1]): ColSpec => ({ id, title, type: "status", labels, done }),
  priority: (): ColSpec => ({ id: "priority", title: "Priority", type: "status", labels: { 0: "Critical", 1: "High", 2: "Medium", 3: "Low", 5: "" }, done: [] }),
  date: (id = "date", title = "Due date"): ColSpec => ({ id, title, type: "date" }),
  timeline: (): ColSpec => ({ id: "timeline", title: "Timeline", type: "timeline" }),
  tags: (): ColSpec => ({ id: "tags", title: "Tags", type: "tags" }),
  tracking: (): ColSpec => ({ id: "time_tracking", title: "Time tracking", type: "time_tracking" }),
  description: (): ColSpec => ({ id: "description", title: "Description", type: "long_text" }),
  text: (id = "text", title = "Notes"): ColSpec => ({ id, title, type: "text" }),
};
const DEFAULT_COLUMNS = (): ColSpec[] => [column.name(), column.people(), column.status(), column.date()];

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const hms = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function mondaySimulator(apiBase = "https://api.monday.com/v2", me: MondayUser = { id: "5001001", name: "Mario Rossi", email: "mario@acme.example", photo_thumb_small: null }) {
  const users = new Map<string, MondayUser>([[me.id, me]]);
  const boards: SimBoard[] = [];
  const items: SimItem[] = [];
  const updates: SimUpdate[] = [];
  const logs: Log[] = [];
  const tags = new Map<string, number>();
  const cursors = new Map<string, { ids: string[]; offset: number; issuedAt: number }>();
  const tokens = new Set(["mon_test_token"]);
  const oauthTokens = new Set(["mon_oauth_token"]);
  const calls: { operationName: string; cost: number; authorization: string | null; version: string | null }[] = [];
  /** The next requests are answered 429 (and whether it is the daily limit) */
  let throttled = { n: 0, daily: false };
  let budget = MINUTE_BUDGET;
  let budgetResetAt = 0;
  let clock = Date.UTC(2026, 9, 1);
  let seq = 100;
  const tick = () => new Date((clock += 1000)).toISOString();

  const addUser = (name: string) => {
    const u: MondayUser = { id: String(5001001 + ++seq), name, email: null, photo_thumb_small: null };
    users.set(u.id, u);
    return u;
  };

  const make = (spec: ColSpec): SimColumn => ({ id: spec.id, title: spec.title, type: spec.type, settings_str: spec.type === "status" ? statusSettings(spec.labels ?? DEFAULT_LABELS, spec.done ?? [1]) : null });

  const addBoard = (name: string, o: { columns?: ColSpec[]; type?: MondayBoardType; workspace?: string | null; access?: boolean; readOnly?: boolean; groups?: string[]; parentOf?: string } = {}) => {
    const b: SimBoard = {
      id: String(1_200_000_000 + ++seq),
      name,
      type: o.type ?? "board",
      workspace: o.workspace ? { id: String(700 + seq), name: o.workspace } : null,
      columns: o.type === "document" ? [] : (o.columns ?? DEFAULT_COLUMNS()).map(make),
      groups: (o.groups ?? ["To Do", "Done"]).map((title, i) => ({ id: i === 0 ? "topics" : `group_${i}`, title })),
      access: o.access ?? true,
      readOnly: o.readOnly ?? false,
      state: "active",
      seq,
      ...(o.parentOf ? { parentOf: o.parentOf } : {}),
    };
    boards.push(b);
    return b;
  };
  const board = (id: string) => {
    const b = boards.find((x) => x.id === id);
    if (!b) throw new Error(`no board ${id}`);
    return b;
  };
  const colOf = (b: SimBoard, id: string) => b.columns.find((c) => c.id === id);
  const labelsOf = (c: SimColumn): Record<string, string> => (JSON.parse(c.settings_str ?? "{}") as { labels?: Record<string, string> }).labels ?? {};
  const indexOf = (c: SimColumn, name: string) => {
    const hit = Object.entries(labelsOf(c)).find(([, n]) => n === name);
    if (!hit) throw new Error(`no label ${name} on ${c.id}`);
    return Number(hit[0]);
  };

  const statusCell = (c: SimColumn, name: string, at: string) => ({ index: indexOf(c, name), post_id: null, changed_at: at });
  const peopleCell = (list: MondayUser[]) => ({ personsAndTeams: list.map((u) => ({ id: Number(u.id), kind: "person" })) });

  const add = (boardId: string, name: string, o: { assignee?: MondayUser | MondayUser[] | null; status?: string | null; due?: string; time?: string; start?: string; end?: string; priority?: string; tags?: string[]; tracked?: number; description?: string; group?: string; cells?: Record<string, unknown>; parent?: string } = {}) => {
    const b = board(boardId);
    const at = tick();
    const who = o.assignee === undefined ? [me] : o.assignee === null ? [] : Array.isArray(o.assignee) ? o.assignee : [o.assignee];
    const cells: Record<string, unknown> = { ...(o.cells ?? {}) };
    const people = b.columns.find((c) => c.type === "people");
    if (people && who.length) cells[people.id] = peopleCell(who);
    const status = b.columns.find((c) => c.type === "status" && c.id === "status") ?? b.columns.find((c) => c.type === "status" && c.id !== "priority");
    if (status && o.status) cells[status.id] = statusCell(status, o.status, at);
    const prio = colOf(b, "priority");
    if (prio && o.priority) cells.priority = statusCell(prio, o.priority, at);
    const date = b.columns.find((c) => c.type === "date");
    if (date && o.due) cells[date.id] = { date: o.due, ...(o.time ? { time: o.time } : {}), changed_at: at };
    if (colOf(b, "timeline") && (o.start || o.end)) cells.timeline = { from: o.start, to: o.end };
    if (colOf(b, "tags") && o.tags) cells.tags = { tag_ids: o.tags.map((t) => tags.get(t) ?? tags.set(t, tags.size + 1).get(t)!) };
    if (colOf(b, "time_tracking") && o.tracked !== undefined) cells.time_tracking = { duration: o.tracked, running: "false", startDate: null };
    if (colOf(b, "description") && o.description) cells.description = { text: o.description, changed_at: at };
    const i: SimItem = {
      id: String(9_000_000_000 + ++seq),
      boardId,
      name,
      state: "active",
      groupId: b.groups.find((g) => g.title === o.group)?.id ?? b.groups[0].id,
      createdAt: at,
      updatedAt: at,
      creatorId: me.id,
      parentId: o.parent ?? null,
      cells,
    };
    items.push(i);
    logs.push({ id: String(++seq), boardId, itemId: i.id, event: "create_pulse", data: { board_id: Number(boardId), pulse_id: Number(i.id), pulse_name: name }, at: Date.parse(at), userId: me.id });
    return i;
  };

  /** A subitem: on the parent's hidden subitems board (made on first use). */
  const addSubitem = (parentId: string, name: string, o: Parameters<typeof add>[2] = {}) => {
    const parent = item(parentId);
    const home = board(parent.boardId);
    const subs = boards.find((b) => b.parentOf === home.id) ?? addBoard(`Subitems of ${home.name}`, { type: "sub_items_board", parentOf: home.id });
    return add(subs.id, name, { ...o, parent: parentId });
  };

  const item = (id: string) => {
    const i = items.find((x) => x.id === id);
    if (!i) throw new Error(`no item ${id}`);
    return i;
  };
  const urlOf = (i: SimItem) => `https://acme.monday.com/boards/${i.boardId}/pulses/${i.id}`;
  const record = (i: SimItem, event: string, actor: MondayUser, data: Record<string, unknown>) => {
    logs.push({ id: String(++seq), boardId: i.boardId, itemId: i.id, event, data: { board_id: Number(i.boardId), pulse_id: Number(i.id), ...data }, at: Date.parse(i.updatedAt), userId: actor.id });
  };

  const labelValue = (c: SimColumn, cell: unknown) => {
    const idx = (cell as { index?: number } | undefined)?.index;
    return idx === undefined ? null : { label: { index: idx, text: labelsOf(c)[String(idx)] ?? "" }, post_id: null };
  };

  /** Changes made "outside" (in monday's own app, by someone else). */
  const outside = {
    setStatus(itemId: string, label: string, actor: MondayUser = me, columnId?: string) {
      const i = item(itemId);
      const c = columnId ? colOf(board(i.boardId), columnId)! : board(i.boardId).columns.find((k) => k.id === "status")!;
      const before = i.cells[c.id];
      i.updatedAt = tick();
      i.cells[c.id] = statusCell(c, label, i.updatedAt);
      record(i, "update_column_value", actor, { column_id: c.id, column_type: "color", column_title: c.title, value: labelValue(c, i.cells[c.id]), previous_value: labelValue(c, before) ?? {} });
    },
    assign(itemId: string, who: MondayUser[], actor: MondayUser = me) {
      const i = item(itemId);
      const c = board(i.boardId).columns.find((k) => k.type === "people")!;
      const before = i.cells[c.id];
      i.cells[c.id] = peopleCell(who);
      i.updatedAt = tick();
      record(i, "update_column_value", actor, { column_id: c.id, column_type: "multiple-person", column_title: c.title, value: i.cells[c.id], previous_value: before ?? {} });
    },
    setDue(itemId: string, date: string | null, time?: string, actor: MondayUser = me) {
      const i = item(itemId);
      const c = board(i.boardId).columns.find((k) => k.type === "date")!;
      const before = i.cells[c.id];
      i.cells[c.id] = date ? { date, ...(time ? { time } : {}), changed_at: tick() } : undefined;
      i.updatedAt = tick();
      record(i, "update_column_value", actor, { column_id: c.id, column_type: "date", column_title: c.title, value: i.cells[c.id] ?? {}, previous_value: before ?? {} });
    },
    rename(itemId: string, name: string, actor: MondayUser = me) {
      const i = item(itemId);
      const old = i.name;
      i.name = name;
      i.updatedAt = tick();
      record(i, "update_name", actor, { name, previous_name: old });
    },
    /** The timer: a total, and whether it runs now (`running` is a string, as monday sends it). */
    track(itemId: string, seconds: number, running = false) {
      const i = item(itemId);
      i.cells.time_tracking = { duration: seconds, running: running ? "true" : "false", startDate: running ? Math.floor(clock / 1000) : null };
      i.updatedAt = tick();
    },
    touch(itemId: string) {
      item(itemId).updatedAt = tick();
    },
    /** Archiving takes the item off its board's list; by id it is still readable. */
    archive(itemId: string, actor: MondayUser = me) {
      const i = item(itemId);
      i.state = "archived";
      i.updatedAt = tick();
      record(i, "archive_pulse", actor, {});
    },
    /** Deleting: gone from every list; by id it answers with state "deleted". */
    delete(itemId: string, actor: MondayUser = me) {
      const i = item(itemId);
      i.state = "deleted";
      i.updatedAt = tick();
      record(i, "delete_pulse", actor, {});
    },
    /** Moving to another board: the id stays, the key (board, item) changes; cells follow where the column ids match. */
    moveToBoard(itemId: string, boardId: string, actor: MondayUser = me) {
      const i = item(itemId);
      const to = board(boardId);
      const from = i.boardId;
      i.boardId = to.id;
      i.groupId = to.groups[0].id;
      i.cells = Object.fromEntries(Object.entries(i.cells).filter(([k]) => colOf(to, k)));
      i.updatedAt = tick();
      record(i, "move_pulse_into_board", actor, { board_id: Number(to.id), previous_board_id: Number(from) });
    },
    /** An update, as someone's (null: from a user who left). */
    comment(itemId: string, body: string, o: { as?: MondayUser | null; replyTo?: string } = {}) {
      const i = item(itemId);
      const at = tick();
      const u: SimUpdate = { id: String(++seq + 3_000_000_000), itemId: i.id, replyTo: o.replyTo ?? null, body, creatorId: o.as === null ? null : (o.as ?? me).id, createdAt: at, updatedAt: at };
      updates.push(u);
      i.updatedAt = at;
      return u;
    },
    revokeBoard(boardId: string) {
      board(boardId).access = false;
    },
    archiveBoard(boardId: string) {
      board(boardId).state = "archived";
    },
    /** The next n requests are answered 429. */
    tooManyRequests(n = 1, daily = false) {
      throttled = { n, daily };
    },
    /** The minute's complexity budget is spent until it resets (a minute of the simulator's clock). */
    spendBudget() {
      budget = 0;
      budgetResetAt = clock + 38_000;
    },
  };

  // ---------- Rendering ----------

  const textOf = (c: SimColumn, cell: unknown): string => {
    if (cell === undefined || cell === null) return "";
    const o = cell as Record<string, unknown>;
    const s = (x: unknown) => (typeof x === "string" || typeof x === "number" ? String(x) : "");
    switch (c.type) {
      case "status":
        return o.index === undefined ? "" : (labelsOf(c)[s(o.index)] ?? "");
      case "people":
        return (o.personsAndTeams as { id: number }[]).map((p) => users.get(String(p.id))?.name ?? "").join(", ");
      case "date":
        return `${s(o.date)}${o.time ? ` ${s(o.time)}` : ""}`;
      case "tags":
        return (o.tag_ids as number[]).map((id) => [...tags.entries()].find(([, v]) => v === id)?.[0] ?? "").join(", ");
      case "time_tracking":
        return hms(Number(o.duration ?? 0));
      case "long_text":
        return s(o.text);
      case "timeline":
        return `${s(o.from)} - ${s(o.to)}`;
      default:
        return typeof cell === "string" ? cell : "";
    }
  };
  const shownBoard = (b: SimBoard) => ({ id: b.id, name: b.name, type: b.type, workspace: b.workspace, columns: b.columns });
  const shown = (i: SimItem) => {
    const b = board(i.boardId);
    const parent = i.parentId ? items.find((x) => x.id === i.parentId) : undefined;
    return {
      id: i.id,
      name: i.name,
      state: i.state,
      url: urlOf(i),
      created_at: i.createdAt,
      updated_at: i.updatedAt,
      creator: users.get(i.creatorId) ?? null,
      board: shownBoard(b),
      group: b.groups.find((g) => g.id === i.groupId) ?? null,
      parent_item: parent ? { id: parent.id, board: { id: parent.boardId } } : null,
      column_values: b.columns.filter((c) => c.type !== "name").map((c) => ({ id: c.id, type: c.type, text: textOf(c, i.cells[c.id]), value: i.cells[c.id] === undefined ? null : JSON.stringify(i.cells[c.id]) })),
    };
  };
  const shownUpdate = (u: SimUpdate) => ({ id: u.id, body: u.body, text_body: u.body.replace(/<[^>]+>/g, ""), created_at: u.createdAt, updated_at: u.updatedAt, creator: u.creatorId ? (users.get(u.creatorId) ?? null) : null });

  // ---------- HTTP ----------

  type Vars = Record<string, unknown>;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const fail = (message: string, code: string, status = 200, extensions: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    json({ errors: [{ message, locations: [{ line: 1, column: 1 }], path: [], extensions: { code, ...extensions } }], account_id: 1001 }, status, headers);
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

  const visible = (b: SimBoard | undefined): b is SimBoard => b !== undefined && b.access;
  const dayOf = (iso: string) => iso.slice(0, 10);

  /** The rules the adapter sends, and a few a caller would: anything else refuses, as a real schema would. */
  function matches(i: SimItem, rules: Record<string, unknown>[]): boolean {
    return rules.every((r) => {
      const col = String(r.column_id);
      const value = Array.isArray(r.compare_value) ? r.compare_value : [];
      const op = String(r.operator);
      if (col === "name" && op === "contains_text") return i.name.toLowerCase().includes(String(value[0] ?? "").toLowerCase());
      if (col === "__last_updated__" && op === "greater_than_or_equals" && value[0] === "EXACT") return dayOf(i.updatedAt) >= String(value[1]);
      const c = colOf(board(i.boardId), col);
      if (c?.type === "people" && op === "any_of") {
        const mine = ((obj(i.cells[col]).personsAndTeams as { id: number; kind: string }[] | undefined) ?? []).map((p) => `${p.kind}-${p.id}`);
        return value.some((v) => mine.includes(String(v)));
      }
      throw new RuleError(`unsupported rule ${col} ${op}`);
    });
  }
  class RuleError extends Error {}

  const page = <T>(list: T[], limit: number, p: number) => list.slice((p - 1) * limit, p * limit);

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const base = new URL(apiBase);
    if (url.origin !== base.origin || url.pathname.replace(/\/$/, "") !== base.pathname.replace(/\/$/, "")) return json({ errors: [{ message: "Not Found" }] }, 404);
    if ((init?.method ?? "GET").toUpperCase() !== "POST") return json({ errors: [{ message: "Method not allowed" }] }, 405);

    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const version = headers.get("api-version");
    const authorized = !auth ? false : auth.startsWith("Bearer ") ? oauthTokens.has(auth.slice(7)) : tokens.has(auth);
    if (!authorized) return json({ error_code: "UserUnauthorizedException", error_message: "Not Authenticated", status_code: 401, error_data: {} }, 401);
    if (version !== null && !VERSIONS.includes(version)) return fail(`Invalid API version: ${version}`, "InvalidVersionException", 400);

    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { operationName?: string; variables?: Vars };
    const op = body.operationName ?? "";
    const v = body.variables ?? {};
    const limit = typeof v.limit === "number" ? v.limit : 25;
    const ids = (Array.isArray(v.ids) ? v.ids : []).map(String);
    const nodes = op === "SearchItems" ? limit * Math.max(1, ids.length) : op === "BoardItems" || op === "NextItems" ? limit : op === "Items" || op === "ChangeStatus" ? Math.max(1, ids.length) : 0;
    const cost = 1000 + (nodes ? nodes * ITEM_COST : limit * 300);
    calls.push({ operationName: op, cost, authorization: auth, version });

    if (throttled.n > 0) {
      throttled.n--;
      return fail(throttled.daily ? "Daily limit exceeded" : "Rate Limit Exceeded", throttled.daily ? "DAILY_LIMIT_EXCEEDED" : "RateLimitExceeded", 429, {}, throttled.daily ? {} : { "Retry-After": "30" });
    }
    if (cost > SINGLE_QUERY_LIMIT) return fail(`Query has complexity of ${cost}, which exceeds max complexity of ${SINGLE_QUERY_LIMIT}`, "ComplexityException");
    if (clock >= budgetResetAt) {
      budget = MINUTE_BUDGET;
      budgetResetAt = clock + 60_000;
    }
    if (cost > budget) {
      const secs = Math.max(1, Math.ceil((budgetResetAt - clock) / 1000));
      return fail(`Complexity budget exhausted, query cost ${cost} exceeds remaining budget ${budget}. ${secs} seconds remaining until budget reset.`, "COMPLEXITY_BUDGET_EXHAUSTED", 200, { retry_in_seconds: secs });
    }
    budget -= cost;

    const ok = (data: unknown) => json({ data, account_id: 1001 });
    if (ids.some((x) => !/^\d+$/.test(x))) return fail("Invalid argument: ids must be numeric", "InvalidArgumentException");

    try {
      switch (op) {
        case "Me":
          return ok({ me });
        case "Users":
          return ok({ users: ids.map((id) => users.get(id)).filter((u) => u !== undefined) });
        case "Boards": {
          if (limit > MAX_BOARDS_PAGE) return fail(`Invalid argument: limit must not exceed ${MAX_BOARDS_PAGE}`, "InvalidArgumentException");
          const p = typeof v.page === "number" ? v.page : 1;
          // Newest first; archived boards and those the user can't see are not listed.
          const list = boards.filter((b) => visible(b) && b.state === "active").sort((a, b) => b.seq - a.seq);
          return ok({ boards: page(list, limit, p).map(shownBoard) });
        }
        case "Board":
          return ok({ boards: boards.filter((b) => ids.includes(b.id) && visible(b)).map(shownBoard) });
        case "Items":
          return ok({ items: items.filter((i) => ids.includes(i.id) && visible(board(i.boardId))).map(shown) });
        case "BoardItems":
        case "SearchItems": {
          if (limit > MAX_ITEMS_PAGE) return fail(`Invalid argument: limit must not exceed ${MAX_ITEMS_PAGE}`, "InvalidArgumentException");
          const rules = (Array.isArray(v.rules) ? v.rules : []).map(obj);
          const wanted = op === "BoardItems" ? [String(v.board)] : ids;
          const out = wanted
            .map((id) => boards.find((b) => b.id === id))
            .filter(visible)
            .map((b) => {
              const matched = items.filter((i) => i.boardId === b.id && i.state === "active" && matches(i, rules)).map((i) => i.id);
              const cursor = matched.length > limit ? `cur_${b64(`${b.id}:${++seq}`)}` : null;
              if (cursor) cursors.set(cursor, { ids: matched, offset: limit, issuedAt: clock });
              return { id: b.id, items_page: { cursor, items: matched.slice(0, limit).map((id) => shown(item(id))) } };
            });
          return ok({ boards: out });
        }
        case "NextItems": {
          if (limit > MAX_ITEMS_PAGE) return fail(`Invalid argument: limit must not exceed ${MAX_ITEMS_PAGE}`, "InvalidArgumentException");
          const cur = cursors.get(String(v.cursor));
          if (!cur || clock - cur.issuedAt > CURSOR_LIFE_MS) return fail("The cursor is invalid or has expired", "CursorException");
          const slice = cur.ids.slice(cur.offset, cur.offset + limit);
          const more = cur.offset + limit < cur.ids.length;
          cursors.delete(String(v.cursor));
          const cursor = more ? `cur_${b64(`${++seq}`)}` : null;
          if (cursor) cursors.set(cursor, { ids: cur.ids, offset: cur.offset + limit, issuedAt: cur.issuedAt });
          return ok({ next_items_page: { cursor, items: slice.map((id) => shown(item(id))) } });
        }
        case "Updates": {
          const i = items.find((x) => x.id === ids[0]);
          if (!i || !visible(board(i.boardId))) return ok({ items: [] });
          const top = updates.filter((u) => u.itemId === i.id && u.replyTo === null).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
          const p = typeof v.page === "number" ? v.page : 1;
          return ok({ items: [{ id: i.id, updates: page(top, limit, p).map((u) => ({ ...shownUpdate(u), replies: updates.filter((r) => r.replyTo === u.id).map(shownUpdate) })) }] });
        }
        case "CreateUpdate": {
          const i = items.find((x) => x.id === String(v.item));
          if (!i || i.state === "deleted" || !visible(board(i.boardId))) return fail("Item not found", "ResourceNotFoundException");
          const text = typeof v.body === "string" ? v.body : "";
          if (text.trim() === "" || text.length > 64_000) return fail("Invalid argument: the update body is empty or too long", "InvalidArgumentException");
          return ok({ create_update: shownUpdate(outside.comment(i.id, text)) });
        }
        case "ChangeStatus": {
          const i = items.find((x) => x.id === String(v.item));
          const b = boards.find((x) => x.id === String(v.board));
          if (!i || !b || !visible(b) || i.state !== "active" || i.boardId !== b.id) return fail("Item not found", "ResourceNotFoundException");
          if (b.readOnly) return fail("User unauthorized to perform action", "UserUnauthorizedException");
          const c = colOf(b, String(v.column));
          if (!c) return fail(`Column not found: ${String(v.column)}`, "InvalidColumnIdException");
          // The value is JSON in a string; a bare object is refused.
          if (typeof v.value !== "string") return fail("Invalid argument: value must be a JSON string", "InvalidArgumentException");
          const wanted = obj(JSON.parse(v.value)).index;
          if (c.type !== "status" || typeof wanted !== "number" || labelsOf(c)[String(wanted)] === undefined) return fail(`This status label doesn't exist, possible statuses are: ${Object.keys(labelsOf(c)).join(", ")}`, "ColumnValueException");
          const before = i.cells[c.id];
          i.updatedAt = tick();
          i.cells[c.id] = { index: wanted, post_id: null, changed_at: i.updatedAt };
          record(i, "update_column_value", me, { column_id: c.id, column_type: "color", column_title: c.title, value: labelValue(c, i.cells[c.id]), previous_value: labelValue(c, before) ?? {} });
          return ok({ change_column_value: shown(i) });
        }
        case "Activity": {
          const b = boards.find((x) => x.id === String(v.board));
          if (!visible(b)) return ok({ boards: [] });
          const from = typeof v.from === "string" ? Date.parse(v.from) : -Infinity;
          const to = typeof v.to === "string" ? Date.parse(v.to) : Infinity;
          const only = Array.isArray(v.items) ? v.items.map(String) : null;
          const list = logs.filter((l) => l.boardId === b.id && l.at >= from && l.at <= to && (!only || only.includes(l.itemId))).sort((x, y) => y.at - x.at || y.id.localeCompare(x.id));
          const p = typeof v.page === "number" ? v.page : 1;
          return ok({ boards: [{ activity_logs: page(list, limit, p).map((l) => ({ id: l.id, event: l.event, data: JSON.stringify(l.data), created_at: String(Math.round(l.at * 10_000)), user_id: l.userId })) }] });
        }
        default:
          return fail(`Cannot query: unmocked operation ${op}`, "undefinedField", 400);
      }
    } catch (e) {
      if (e instanceof RuleError) return fail(e.message, "InvalidArgumentException");
      throw e;
    }
  }

  // ---------- Webhooks ----------

  const jwt = (secret: string, claims: Record<string, unknown>, alg = "HS256") => {
    const h = b64(JSON.stringify({ alg, typ: "JWT" }));
    const p = b64(JSON.stringify(claims));
    return `${h}.${p}.${alg === "none" ? "" : createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
  };

  /** A delivery as monday sends it: the raw body, and a JWT in Authorization signed with the signing secret. */
  function webhook(payload: Record<string, unknown>, o: { secret: string; ageMs?: number; signedWith?: string; expiresInMs?: number; alg?: string }) {
    const sent = clock - (o.ageMs ?? 0);
    const rawBody = JSON.stringify({ event: { app: "monday", type: "update_column_value", triggerTime: new Date(sent).toISOString(), subscriptionId: 4242, userId: Number(me.id), triggerUuid: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, ...payload } });
    const exp = Math.floor((Date.now() + (o.expiresInMs ?? 600_000)) / 1000);
    return { rawBody, headers: { authorization: jwt(o.signedWith ?? o.secret, { accountId: 1001, userId: Number(me.id), aud: "https://inkledger.example/hook", exp }, o.alg), "content-type": "application/json" } };
  }
  /** The first request of a new subscription: a challenge to echo, signed all the same. */
  function challenge(token: string, secret: string) {
    return { rawBody: JSON.stringify({ challenge: token }), headers: { authorization: jwt(secret, { exp: Math.floor((Date.now() + 600_000) / 1000) }) } };
  }

  return { apiBase, me, users, addUser, addBoard, board, add, addSubitem, item, items, boards, updates, logs, outside, calls, webhook, challenge, tokens, oauthTokens, urlOf, now: () => clock, advance: (ms: number) => void (clock += ms), fetch: handle, version: API_VERSION };
}
