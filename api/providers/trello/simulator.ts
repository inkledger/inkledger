// A Trello in memory, for tests: the REST (version 1) endpoints the adapter
// calls, written from Trello's public API documentation (not recorded from a
// real account: see SPIKES.md), with its shapes and traps:
// - the API key and the member's token come in the Authorization header
//   (OAuth oauth_consumer_key=…, oauth_token=…) or as query parameters; a bad
//   one is a 401 with a plain-text body ("invalid key", "invalid token");
// - 401 is also what a card or board the token can't read answers
//   ("unauthorized card permission requested"), not 403 or 404; a malformed id
//   is 400 "invalid id"; a deleted card is 404 with a plain-text body;
// - ids are 24 hex characters whose first 8 are the creation time (seconds);
//   a card also has a shortLink (8 characters, unique, kept through every
//   move) and idShort, its number on the board (new with every board move);
//   any of id and shortLink reaches a card;
// - budgets of 100 calls per 10 s per token and 300 per key, in
//   x-rate-limit-api-token-* / x-rate-limit-api-key-* headers; over them a 429
//   (JSON error API_TOKEN_LIMIT_EXCEEDED), with no Retry-After;
// - due is an instant (UTC, with milliseconds), start a date kept as an
//   instant; archived cards, lists and boards stay readable with closed: true;
// - /members/me/cards takes no "since": it lists the whole set, with
//   dateLastActivity on each card;
// - comments are actions (commentCard), newest first, 50 by default, 1,000 at
//   most, paged by `before` (an action id); without a filter, a card's actions
//   are only comments and list moves; deleted cards and removed members are
//   only in the board's action log;
// - search matches whole words unless partial=true, only on boards the member
//   belongs to, and leaves archived cards out;
// - a member's avatarUrl is a base (the size and .png are appended), or null.
import { createHmac } from "node:crypto";
import type { TrelloAction, TrelloBoard, TrelloCard, TrelloLabel, TrelloList, TrelloMember } from "./client";

export type SimMember = TrelloMember;
type SimList = TrelloList;
type SimBoard = { id: string; name: string; shortLink: string; closed: boolean; members: Set<string>; nextShort: number; pos: number };
type SimCard = {
  id: string;
  shortLink: string;
  idShort: number;
  boardId: string;
  listId: string;
  name: string;
  desc: string;
  closed: boolean;
  members: string[];
  labels: TrelloLabel[];
  due: number | null;
  dueComplete: boolean;
  start: number | null;
  activity: number;
  pos: number;
  subscribed: Set<string>;
  deleted: boolean;
};
type SimAction = { id: string; seq: number; type: string; date: number; boardId: string; cardId: string | null; creator: string; data: TrelloAction["data"] };

const oid = (seconds: number, n: number) => seconds.toString(16).padStart(8, "0") + n.toString(16).padStart(16, "0");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const HEX24 = /^[0-9a-f]{24}$/;
const SHORT = /^[A-Za-z0-9]{8}$/;

export const TOKEN_BUDGET = 100;
export const KEY_BUDGET = 300;
export const WINDOW_MS = 10_000;

export function trelloSimulator(
  apiBase = "https://api.trello.com",
  me: SimMember = { id: oid(1_700_000_000, 1), username: "mrossi", fullName: "Mario Rossi", avatarUrl: "https://trello-members.s3.amazonaws.com/avatars/mrossi", email: "mario@acme.example" },
) {
  const key = "simkey0123456789";
  const token = "simtoken_0123456789";
  /** What the connection's secret holds */
  const secret = `${key}:${token}`;
  const users = new Map<string, SimMember>([[me.id, me]]);
  const boards: SimBoard[] = [];
  const lists: SimList[] = [];
  const cards: SimCard[] = [];
  const actions: SimAction[] = [];
  const state = { exhausted: false, revoked: false, tokenBudget: TOKEN_BUDGET, keyBudget: KEY_BUDGET };
  const calls: { method: string; path: string; authorization: string | null; search: string }[] = [];
  const budgetWindow: number[] = [];
  let seq = 100;
  // Strictly increasing and never behind the real clock, so "changed since" works with real checkpoints.
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  // What existed before the test began is dated hours ago, one second apart.
  let past = Date.now() - 3 * 3_600_000;
  const earlier = () => (past += 1000);
  const iso = (ms: number) => new Date(ms).toISOString();
  /** Setup time while seeding, the real clock afterwards */
  let seeding = true;
  const stamp = () => (seeding ? earlier() : now());
  const id = (ms: number) => oid(Math.floor(ms / 1000), ++seq);

  const addUser = (fullName: string, username = fullName.split(" ")[0].toLowerCase()) => {
    const u: SimMember = { id: id(stamp()), username, fullName, avatarUrl: null };
    users.set(u.id, u);
    return u;
  };

  const addBoard = (name: string, o: { listNames?: string[]; member?: boolean; closed?: boolean; shortLink?: string } = {}) => {
    const at = stamp();
    const b: SimBoard = { id: id(at), name, shortLink: o.shortLink ?? `Bd${String(++seq).padStart(6, "0")}`, closed: o.closed ?? false, members: new Set(o.member === false ? [] : [me.id]), nextShort: 1, pos: boards.length };
    boards.push(b);
    (o.listNames ?? ["To Do", "Doing", "Done"]).forEach((n, i) => addList(b.name, n, i));
    return b;
  };
  const board = (name: string) => {
    const b = boards.find((x) => x.name === name || x.id === name);
    if (!b) throw new Error(`no board ${name}`);
    return b;
  };
  const addList = (boardName: string, name: string, pos?: number) => {
    const b = board(boardName);
    const l: SimList = { id: id(stamp()), name, closed: false, pos: (pos ?? lists.filter((x) => x.idBoard === b.id).length) * 65536, idBoard: b.id };
    lists.push(l);
    return l;
  };
  const listIn = (b: SimBoard, name: string) => {
    const l = lists.find((x) => x.idBoard === b.id && x.name === name);
    if (!l) throw new Error(`no list ${name} on ${b.name}`);
    return l;
  };

  const record = (type: string, c: SimCard, creator: string, data: TrelloAction["data"], at = stamp()) => {
    const b = boards.find((x) => x.id === c.boardId)!;
    const a: SimAction = {
      id: id(at),
      seq: ++seq,
      type,
      date: at,
      boardId: c.boardId,
      cardId: c.id,
      creator,
      data: { board: { id: b.id, name: b.name, shortLink: b.shortLink }, ...data, card: { id: c.id, shortLink: c.shortLink, idShort: c.idShort, name: c.name, ...data.card } },
    };
    actions.push(a);
    return a;
  };

  const add = (
    boardName: string,
    name: string,
    o: { list?: string; members?: SimMember[]; desc?: string; labels?: TrelloLabel[]; due?: string; start?: string; shortLink?: string; closed?: boolean } = {},
  ) => {
    const b = board(boardName);
    const at = stamp();
    const l = o.list ? listIn(b, o.list) : lists.filter((x) => x.idBoard === b.id && !x.closed).sort((x, y) => x.pos - y.pos)[0];
    const c: SimCard = {
      id: id(at),
      shortLink: o.shortLink ?? `Cd${String(++seq).padStart(6, "0")}`,
      idShort: b.nextShort++,
      boardId: b.id,
      listId: l.id,
      name,
      desc: o.desc ?? "",
      closed: o.closed ?? false,
      members: (o.members ?? [me]).map((m) => m.id),
      labels: o.labels ?? [],
      due: o.due ? Date.parse(o.due) : null,
      dueComplete: false,
      start: o.start ? Date.parse(o.start) : null,
      activity: at,
      pos: 65536 * cards.length,
      subscribed: new Set(),
      deleted: false,
    };
    cards.push(c);
    record("createCard", c, me.id, { list: { id: l.id, name: l.name } }, at);
    return c;
  };

  const cardBy = (k: string) => {
    const c = cards.find((x) => x.id === k || x.shortLink === k);
    if (!c) throw new Error(`no card ${k}`);
    return c;
  };
  const touch = (c: SimCard) => (c.activity = now());

  /** Changes made "outside" (in Trello's own app, by someone else). */
  const outside = {
    setList(k: string, listName: string, by: SimMember = me) {
      const c = cardBy(k);
      const b = boards.find((x) => x.id === c.boardId)!;
      const from = lists.find((x) => x.id === c.listId)!;
      const to = listIn(b, listName);
      c.listId = to.id;
      const at = touch(c);
      record("updateCard", c, by.id, { listBefore: { id: from.id, name: from.name }, listAfter: { id: to.id, name: to.name }, old: { idList: from.id } }, at);
    },
    rename(k: string, name: string, by: SimMember = me) {
      const c = cardBy(k);
      const old = c.name;
      c.name = name;
      record("updateCard", c, by.id, { old: { name: old } }, touch(c));
    },
    describe(k: string, desc: string, by: SimMember = me) {
      const c = cardBy(k);
      const old = c.desc;
      c.desc = desc;
      record("updateCard", c, by.id, { old: { desc: old }, card: { id: c.id, desc } }, touch(c));
    },
    setDue(k: string, due: string | null, by: SimMember = me) {
      const c = cardBy(k);
      const old = c.due === null ? null : iso(c.due);
      c.due = due ? Date.parse(due) : null;
      record("updateCard", c, by.id, { old: { due: old }, card: { id: c.id, due } }, touch(c));
    },
    archive(k: string, by: SimMember = me) {
      const c = cardBy(k);
      c.closed = true;
      record("updateCard", c, by.id, { old: { closed: false }, card: { id: c.id, closed: true } }, touch(c));
    },
    unarchive(k: string, by: SimMember = me) {
      const c = cardBy(k);
      c.closed = false;
      record("updateCard", c, by.id, { old: { closed: true }, card: { id: c.id, closed: false } }, touch(c));
    },
    /** Deleting is final: the card is gone, only the board's log remembers. */
    delete(k: string, by: SimMember = me) {
      const c = cardBy(k);
      c.deleted = true;
      const b = boards.find((x) => x.id === c.boardId)!;
      actions.push({ id: id(now()), seq: ++seq, type: "deleteCard", date: now(), boardId: b.id, cardId: null, creator: by.id, data: { card: { id: c.id, shortLink: c.shortLink, idShort: c.idShort }, board: { id: b.id, name: b.name, shortLink: b.shortLink } } });
    },
    addMember(k: string, who: SimMember, by: SimMember = me) {
      const c = cardBy(k);
      if (!c.members.includes(who.id)) c.members.push(who.id);
      record("addMemberToCard", c, by.id, { idMember: who.id }, touch(c));
    },
    removeMember(k: string, who: SimMember, by: SimMember = me) {
      const c = cardBy(k);
      c.members = c.members.filter((m) => m !== who.id);
      record("removeMemberFromCard", c, by.id, { idMember: who.id }, touch(c));
    },
    addLabel(k: string, label: TrelloLabel, by: SimMember = me) {
      const c = cardBy(k);
      c.labels.push(label);
      record("addLabelToCard", c, by.id, { label: { id: label.id, name: label.name ?? "", color: label.color ?? "" } }, touch(c));
    },
    comment(k: string, text: string, by: SimMember = me) {
      const c = cardBy(k);
      const a = record("commentCard", c, by.id, { text }, now());
      c.activity = a.date;
      return a;
    },
    editComment(actionId: string, text: string) {
      const a = actions.find((x) => x.id === actionId)!;
      a.data.text = text;
      a.data.dateLastEdited = iso(now());
      const c = cards.find((x) => x.id === a.cardId)!;
      touch(c);
    },
    /** To a list of another board: same id and shortLink, a new idShort and board. */
    moveToBoard(k: string, boardName: string, listName: string, by: SimMember = me) {
      const c = cardBy(k);
      const from = boards.find((x) => x.id === c.boardId)!;
      const to = board(boardName);
      c.boardId = to.id;
      c.idShort = to.nextShort++;
      c.listId = listIn(to, listName).id;
      const at = touch(c);
      actions.push({ id: id(at), seq: ++seq, type: "moveCardFromBoard", date: at, boardId: from.id, cardId: c.id, creator: by.id, data: { card: { id: c.id, shortLink: c.shortLink }, board: { id: from.id, name: from.name } } });
      record("moveCardToBoard", c, by.id, {}, at);
    },
    archiveList(boardName: string, listName: string) {
      listIn(board(boardName), listName).closed = true;
    },
    archiveBoard(boardName: string) {
      board(boardName).closed = true;
    },
    /** The member leaves a board (or is removed): its cards answer 401 from now on. */
    leaveBoard(boardName: string) {
      board(boardName).members.delete(me.id);
    },
  };

  // ---------- HTTP ----------

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
  // Most of Trello's refusals are plain text.
  const text = (body: string, status: number, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
  const notFound = () => text("The requested resource was not found.", 404);
  const invalidId = () => text("invalid id", 400);
  const denied = (what: string) => text(`unauthorized ${what} permission requested`, 401);

  const memberJson = (m: SimMember, fields?: string[]) => {
    const full: Record<string, unknown> = { id: m.id, username: m.username, fullName: m.fullName, avatarUrl: m.avatarUrl ?? null, ...(m.email ? { email: m.email } : {}) };
    if (!fields) return full;
    return Object.fromEntries(Object.entries(full).filter(([k]) => k === "id" || fields.includes(k)));
  };
  const csv = (v: string | null) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

  const cardJson = (c: SimCard, q: URLSearchParams, withMembers = q.get("members") === "true", prefix = ""): TrelloCard => {
    const full: Record<string, unknown> = {
      id: c.id,
      name: c.name,
      desc: c.desc,
      closed: c.closed,
      idList: c.listId,
      idBoard: c.boardId,
      idShort: c.idShort,
      shortLink: c.shortLink,
      shortUrl: `https://trello.com/c/${c.shortLink}`,
      url: `https://trello.com/c/${c.shortLink}/${c.idShort}-${slug(c.name)}`,
      idMembers: c.members,
      labels: c.labels,
      due: c.due === null ? null : iso(c.due),
      dueComplete: c.dueComplete,
      start: c.start === null ? null : iso(c.start),
      dateLastActivity: iso(c.activity),
      subscribed: c.subscribed.has(me.id),
      pos: c.pos,
    };
    const fields = csv(q.get(`${prefix}fields`));
    const out = fields ? Object.fromEntries(Object.entries(full).filter(([k]) => k === "id" || fields.includes(k))) : full;
    if (withMembers) out.members = c.members.map((m) => memberJson(users.get(m)!, csv(q.get(`${prefix}member_fields`))));
    return out as TrelloCard;
  };
  const boardJson = (b: SimBoard, q: URLSearchParams) => {
    const full: Record<string, unknown> = { id: b.id, name: b.name, shortLink: b.shortLink, url: `https://trello.com/b/${b.shortLink}/${slug(b.name)}`, closed: b.closed };
    const fields = csv(q.get("fields"));
    const out = fields ? Object.fromEntries(Object.entries(full).filter(([k]) => k === "id" || fields.includes(k))) : full;
    const which = q.get("lists");
    if (which && which !== "none") out.lists = lists.filter((l) => l.idBoard === b.id && (which === "all" || (which === "open") === !l.closed));
    return out as TrelloBoard;
  };

  /** A card the way the id in the path says it; undefined when malformed, null when not there. */
  const resolveCard = (k: string): SimCard | null | undefined => {
    if (!HEX24.test(k) && !SHORT.test(k)) return undefined;
    return cards.find((c) => !c.deleted && (c.id === k || c.shortLink === k)) ?? null;
  };
  const canSee = (c: SimCard) => !!boards.find((b) => b.id === c.boardId)?.members.has(me.id);

  const actionJson = (a: SimAction) => ({ id: a.id, idMemberCreator: a.creator, type: a.type, date: iso(a.date), data: a.data, memberCreator: memberJson(users.get(a.creator) ?? me, ["fullName", "username", "avatarUrl"]), ...(a.data.idMember && users.has(a.data.idMember) ? { member: memberJson(users.get(a.data.idMember)!, ["fullName", "username", "avatarUrl"]) } : {}) });

  /** Newest first, `before` an action id (or a date), `since` a date; limit 50 by default and 1,000 at most. */
  function pageActions(list: SimAction[], q: URLSearchParams, defaults?: (a: SimAction) => boolean): Response {
    const filter = csv(q.get("filter"));
    let rows = [...list].sort((a, b) => b.date - a.date || b.seq - a.seq);
    if (filter) {
      if (!filter.includes("all")) rows = rows.filter((a) => filter.includes(a.type));
    } else if (defaults) rows = rows.filter(defaults);
    const since = q.get("since");
    if (since) rows = rows.filter((a) => a.date >= Date.parse(since));
    const before = q.get("before");
    if (before) {
      const at = rows.findIndex((a) => a.id === before);
      rows = at >= 0 ? rows.slice(at + 1) : rows.filter((a) => a.date < Date.parse(before));
    }
    const requested = q.get("limit") === null ? 50 : Number(q.get("limit"));
    if (!Number.isInteger(requested) || requested < 1 || requested > 1000) return text("invalid value for limit", 400);
    return json(rows.slice(0, requested).map(actionJson));
  }

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const base = new URL(apiBase);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push({ method, path: url.pathname, authorization: headers.get("authorization"), search: url.search });
    if (url.origin !== base.origin || !url.pathname.startsWith("/1/")) return text("Not Found", 404);
    const path = url.pathname.slice(2);
    const q = url.searchParams;
    const body: Record<string, unknown> = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    // Parameters of a write come in the query or in a JSON body.
    const param = (name: string): string | undefined => {
      const v = q.get(name) ?? body[name];
      return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) || undefined : undefined;
    };

    // Credentials: the header, else the query.
    const auth = /^OAuth oauth_consumer_key="([^"]*)", oauth_token="([^"]*)"$/.exec(headers.get("authorization") ?? "");
    const sentKey = auth?.[1] ?? q.get("key");
    const sentToken = auth?.[2] ?? q.get("token");
    if (sentKey !== key) return text("invalid key", 401);
    if (sentToken !== token || state.revoked) return text("invalid token", 401);

    // Budgets: calls in the last window.
    const t = Date.now();
    while (budgetWindow.length && budgetWindow[0] <= t - WINDOW_MS) budgetWindow.shift();
    budgetWindow.push(t);
    const used = budgetWindow.length;
    const budgets = (over: boolean): Record<string, string> => ({
      "x-rate-limit-api-token-interval-ms": String(WINDOW_MS),
      "x-rate-limit-api-token-max": String(state.tokenBudget),
      "x-rate-limit-api-token-remaining": String(over ? 0 : Math.max(0, state.tokenBudget - used)),
      "x-rate-limit-api-key-interval-ms": String(WINDOW_MS),
      "x-rate-limit-api-key-max": String(state.keyBudget),
      "x-rate-limit-api-key-remaining": String(Math.max(0, state.keyBudget - used)),
    });
    if (state.exhausted || used > state.tokenBudget) return json({ error: "API_TOKEN_LIMIT_EXCEEDED", message: "Rate limit exceeded" }, 429, budgets(true));
    const ok = (data: unknown, status = 200) => json(data, status, budgets(false));
    // Every answer carries the budgets.
    const send = (r: Response) => {
      for (const [k, v] of Object.entries(budgets(false))) if (!r.headers.has(k)) r.headers.set(k, v);
      return r;
    };

    if (method === "GET" && path === "/members/me") return ok(memberJson(me, csv(q.get("fields"))));

    if (method === "GET" && path === "/members/me/boards") {
      const filter = q.get("filter") ?? "all";
      if (!["all", "open", "closed"].includes(filter)) return send(text("invalid value for filter", 400));
      return ok(boards.filter((b) => b.members.has(me.id) && (filter === "all" || (filter === "open") === !b.closed)).map((b) => boardJson(b, q)));
    }

    if (method === "GET" && path === "/members/me/cards") {
      const filter = q.get("filter") ?? "visible";
      if (!["all", "open", "closed", "visible"].includes(filter)) return send(text("invalid value for filter", 400));
      const mine = cards.filter((c) => !c.deleted && c.members.includes(me.id) && canSee(c));
      const shown = mine.filter((c) => {
        const open = !boards.find((b) => b.id === c.boardId)!.closed;
        return filter === "all" || (filter === "closed" ? c.closed : filter === "open" ? !c.closed : !c.closed && open);
      });
      // No order is promised; the adapter sorts.
      return ok(shown.map((c) => cardJson(c, q)));
    }

    let m = /^\/boards\/([^/]+)(?:\/(lists|actions))?$/.exec(path);
    if (method === "GET" && m) {
      if (!HEX24.test(m[1]) && !SHORT.test(m[1])) return send(invalidId());
      const b = boards.find((x) => x.id === m![1] || x.shortLink === m![1]);
      if (!b) return send(notFound());
      if (!b.members.has(me.id)) return send(denied("board"));
      if (!m[2]) return ok(boardJson(b, q));
      if (m[2] === "lists") {
        const which = q.get("filter") ?? "open";
        return ok(lists.filter((l) => l.idBoard === b.id && (which === "all" || (which === "open") === !l.closed)).sort((x, y) => x.pos - y.pos));
      }
      return send(pageActions(actions.filter((a) => a.boardId === b.id), q));
    }

    m = /^\/lists\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      if (!HEX24.test(m[1])) return send(invalidId());
      const l = lists.find((x) => x.id === m![1]);
      if (!l) return send(notFound());
      if (!boards.find((b) => b.id === l.idBoard)!.members.has(me.id)) return send(denied("list"));
      return ok(l);
    }

    m = /^\/cards\/([^/]+)(?:\/(actions\/comments|actions|subscribed))?$/.exec(path);
    if (m) {
      const c = resolveCard(m[1]);
      if (c === undefined) return send(invalidId());
      if (c === null) return send(notFound());
      if (!canSee(c)) return send(denied("card"));
      const sub = m[2];
      if (!sub) {
        if (method === "PUT") {
          const to = param("idList");
          if (to !== undefined) {
            if (!HEX24.test(to)) return send(invalidId());
            const l = lists.find((x) => x.id === to);
            if (!l) return send(text("invalid value for idList", 400));
            if (!boards.find((b) => b.id === l.idBoard)!.members.has(me.id)) return send(denied("list"));
            const from = lists.find((x) => x.id === c.listId)!;
            // A list of another board takes the card there, with a new number.
            if (l.idBoard !== c.boardId) {
              c.boardId = l.idBoard;
              c.idShort = boards.find((b) => b.id === l.idBoard)!.nextShort++;
            }
            c.listId = l.id;
            const at = touch(c);
            record("updateCard", c, me.id, { listBefore: { id: from.id, name: from.name }, listAfter: { id: l.id, name: l.name }, old: { idList: from.id } }, at);
          }
        } else if (method !== "GET") return send(text("Method not allowed", 405));
        return ok(cardJson(c, q, method === "GET" ? undefined : false));
      }
      if (sub === "actions" && method === "GET") {
        return send(pageActions(actions.filter((a) => a.cardId === c.id), q, (a) => a.type === "commentCard" || (a.type === "updateCard" && !!a.data.listAfter)));
      }
      if (sub === "actions/comments" && method === "POST") {
        const body = param("text");
        if (!body) return send(text("invalid value for text", 400));
        return ok(actionJson(outside.comment(c.id, body)), 200);
      }
      if (sub === "subscribed" && method === "PUT") {
        if (param("value") === "true") c.subscribed.add(me.id);
        else c.subscribed.delete(me.id);
        return ok({ subscribed: c.subscribed.has(me.id) });
      }
      return send(notFound());
    }

    if (method === "GET" && path === "/search") {
      const query = (q.get("query") ?? "").trim();
      if (!query) return send(text("invalid value for query", 400));
      if (csv(q.get("modelTypes"))?.some((x) => x !== "cards")) return send(text("only cards are simulated", 400));
      const limit = q.get("cards_limit") === null ? 10 : Number(q.get("cards_limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return send(text("invalid value for cards_limit", 400));
      const partial = q.get("partial") === "true";
      const terms = query.toLowerCase().split(/\s+/);
      const words = (c: SimCard) => `${c.name} ${c.desc}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const hit = (c: SimCard) => terms.every((term) => words(c).some((w) => (partial ? w.startsWith(term) : w === term)) || c.shortLink.toLowerCase() === term);
      const found = cards.filter((c) => !c.deleted && !c.closed && canSee(c) && hit(c)).sort((a, b) => b.activity - a.activity);
      const wantsMembers = q.get("card_members") === "true";
      return ok({ options: { terms: terms.map((t2) => ({ text: t2, partial })), modelTypes: ["cards"] }, cards: found.slice(0, limit).map((c) => cardJson(c, new URLSearchParams({ ...(q.get("card_fields") ? { fields: q.get("card_fields")! } : {}), members: String(wantsMembers) }))) });
    }

    return send(text(`unmocked ${method} ${path}`, 404));
  }

  /** A webhook delivery as Trello sends it: the raw body, signed (base64 HMAC-SHA1 of body + callback URL) under the app's secret. */
  function webhook(action: Omit<TrelloAction, "id" | "date" | "idMemberCreator"> & { id?: string; date?: string }, o: { secret: string; callbackUrl: string; signedWith?: string; callbackSignedWith?: string }) {
    const rawBody = JSON.stringify({ action: { id: action.id ?? id(now()), idMemberCreator: me.id, date: action.date ?? iso(now()), type: action.type, data: action.data }, model: { id: oid(1_700_000_000, 7) }, webhook: { id: oid(1_700_000_000, 8), idModel: oid(1_700_000_000, 7) } });
    const signature = createHmac("sha1", o.signedWith ?? o.secret).update(rawBody + (o.callbackSignedWith ?? o.callbackUrl), "utf8").digest("base64");
    return { rawBody, headers: { "x-trello-webhook": signature, "content-type": "application/json" } };
  }

  return {
    apiBase,
    key,
    token,
    secret,
    me,
    users,
    boards,
    lists,
    cards,
    actions,
    state,
    calls,
    addUser,
    addBoard,
    addList,
    add,
    board,
    outside,
    webhook,
    card: cardBy,
    /** End of setup: from now on, changes are stamped with the real clock. */
    live: () => void (seeding = false),
    /** Every call from now on is refused as over the limit (429). */
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** The token stops working (401 "invalid token"). */
    revoke: () => (state.revoked = true),
    now: () => clock,
    fetch: handle,
  };
}
