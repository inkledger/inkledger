// A Notion in memory, for tests: the REST (version 1) endpoints the adapter
// calls, written from Notion's public API documentation (not recorded from a
// real workspace: see SPIKES.md), with its shapes and traps:
// - the token is a Bearer token and every call needs the Notion-Version
//   header; a bad token is a 401 (unauthorized), a missing version a 400;
// - every error is JSON ({ object: "error", status, code, message });
//   a page, database or user the integration can't read is a 404
//   (object_not_found), whether it was deleted or never shared with the
//   integration: never a 403. A 403 (restricted_resource) is a missing
//   capability of the integration, such as reading comments;
// - an internal integration's bot belongs to the workspace, not to a person
//   (bot.owner.type "workspace"): only a public one names a user. A user's
//   email is only there when the integration may read user information;
// - ids are dashed UUIDs in the API and 32 hex characters in URLs; a URL's
//   trailing id after the title slug is the page's, but a database opened in
//   a view has the database's id and ?v=<view id>, and a page peeked in a view
//   ?p=<page id>;
// - last_edited_time is rounded down to the minute, and filters compare the
//   rounded value: a change within the minute of a checkpoint is invisible to
//   an exact "since";
// - lists are paged by cursor (page_size 100 at most, start_cursor, has_more /
//   next_cursor); a query leaves archived pages out and lists their parent
//   database only; filter_properties limits which properties come back;
// - an archived (trashed) page is still readable by its id with archived:
//   true, and can't be edited; a page removed for good, or its database unshared,
//   is a 404;
// - property ids are short strings with URL-escaped characters ("%3Ab"), the
//   title's is always "title"; filters and updates take a property's id or
//   its name; a "status" property has options in groups (To-do, In progress,
//   Complete), a "select" one has options only;
// - a date property is a day ("2026-10-30") or an instant with an offset
//   ("2026-10-30T23:30:00.000+00:00"), or a time without offset and a
//   time_zone beside it;
// - comments on a page are listed by block_id=<page id> (oldest first); those
//   on one block of its body are not; created_by is only an id; rich text is
//   limited to 100 elements and 2,000 characters in each text;
// - over the rate limit (an average of 3 requests a second): 429 rate_limited
//   with Retry-After in seconds.
import { createHmac } from "node:crypto";
import type { NotionBlock, NotionColumn, NotionComment, NotionDatabase, NotionGroup, NotionOption, NotionPage, NotionRichText, NotionUser, NotionValue } from "./client";

export type SimUser = { id: string; name: string; email: string | null; avatar: string | null };
type SimColumn = NotionColumn;
type SimDb = { id: string; name: string; shared: boolean; columns: SimColumn[] };
type DateValue = { start: string; end: string | null; time_zone: string | null };
type SimPage = {
  id: string;
  /** The parent database, or null for a page that sits elsewhere */
  dbId: string | null;
  title: string;
  status: string | null;
  tags: string[];
  assignees: string[];
  due: DateValue | null;
  created: number;
  edited: number;
  archived: boolean;
  deleted: boolean;
  blocks: NotionBlock[];
};
type SimComment = { id: string; parent: NotionComment["parent"]; discussion: string; created: number; edited: number; by: string; rich: NotionRichText[] };

export const WORKSPACE_BOT = "bot-integration";

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
const rich = (content: string): NotionRichText[] => [{ type: "text", text: { content, link: null }, annotations: {}, plain_text: content, href: null }];
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
const minute = (ms: number) => Math.floor(ms / 60_000) * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

class Refusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const objOf = (x: unknown): Record<string, unknown> => (isObj(x) ? x : {});

export function notionSimulator(
  apiBase = "https://api.notion.com/v1",
  o: { owner?: "workspace" | "user"; userInfo?: boolean } = {},
) {
  const token = "secret_simulatedtoken0123456789";
  const verificationToken = "secret_verification0123456789";
  const users = new Map<string, SimUser>();
  const dbs: SimDb[] = [];
  const pages: SimPage[] = [];
  const comments: SimComment[] = [];
  const state = { exhausted: false, revoked: false, commentsAllowed: true, userInfo: o.userInfo ?? true, retryAfter: 2 };
  const calls: { method: string; path: string; search: string; body: Record<string, unknown> }[] = [];
  let seq = 0x100;
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  let past = Date.now() - 3 * 3_600_000;
  const earlier = () => (past += 60_000);
  let seeding = true;
  const stamp = () => (seeding ? earlier() : now());
  const uuid = () => {
    const n = ++seq;
    return `${hex(n, 8)}-1111-4111-8111-${hex(n, 12)}`;
  };
  const colId = (name: string) => `${name.slice(0, 1).toUpperCase()}${hex(++seq, 2)}%3${name.length % 10}`;

  const addUser = (name: string, email: string | null = `${name.split(" ")[0].toLowerCase()}@acme.example`) => {
    const u: SimUser = { id: uuid(), name, email, avatar: null };
    users.set(u.id, u);
    return u;
  };
  const me = addUser("Mario Rossi", "mario@acme.example");

  const addDatabase = (name: string, d: { type?: "status" | "select"; options?: string[]; due?: boolean; statusName?: string; assigneeName?: string } = {}) => {
    const names = d.options ?? ["Not started", "In progress", "Done"];
    const options: NotionOption[] = names.map((n, i) => ({ id: `opt${hex(++seq, 4)}${i}`, name: n, color: "default" }));
    const type = d.type ?? "status";
    const statusCol: SimColumn =
      type === "status"
        ? {
            id: colId("Status"),
            name: d.statusName ?? "Status",
            type,
            // Notion's three groups, always in this order; the last option of a list is "complete" here.
            status: {
              options,
              groups: [
                { id: `g${hex(++seq, 3)}`, name: "To-do", option_ids: options.slice(0, Math.max(1, options.length - 2)).map((x) => x.id) },
                { id: `g${hex(++seq, 3)}`, name: "In progress", option_ids: options.length > 2 ? [options[options.length - 2].id] : [] },
                { id: `g${hex(++seq, 3)}`, name: "Complete", option_ids: options.length > 1 ? [options[options.length - 1].id] : [] },
              ] satisfies NotionGroup[],
            },
          }
        : { id: colId("Status"), name: d.statusName ?? "Status", type, select: { options } };
    const db: SimDb = {
      id: uuid(),
      name,
      shared: true,
      columns: [
        { id: "title", name: "Name", type: "title" },
        statusCol,
        { id: colId("Assignee"), name: d.assigneeName ?? "Assignee", type: "people" },
        ...(d.due === false ? [] : [{ id: colId("Due"), name: "Due", type: "date" }]),
        { id: colId("Tags"), name: "Tags", type: "multi_select" },
      ],
    };
    dbs.push(db);
    return db;
  };
  const database = (k: string) => {
    const d = dbs.find((x) => x.name === k || x.id === k);
    if (!d) throw new Error(`no database ${k}`);
    return d;
  };
  const optionsOf = (d: SimDb): NotionOption[] => {
    const c = d.columns.find((x) => x.type === "status" || x.type === "select");
    return c?.status?.options ?? c?.select?.options ?? [];
  };
  const optionIn = (d: SimDb, name: string): NotionOption => {
    const hit = optionsOf(d).find((x) => x.name === name || x.id === name);
    if (!hit) throw new Error(`no option ${name}`);
    return hit;
  };

  const add = (dbName: string, title: string, a: { status?: string | null; assignees?: SimUser[]; due?: DateValue | string | null; tags?: string[]; id?: string; archived?: boolean } = {}) => {
    const d = database(dbName);
    const at = stamp();
    const p: SimPage = {
      id: a.id ?? uuid(),
      dbId: d.id,
      title,
      status: a.status === null ? null : optionIn(d, a.status ?? optionsOf(d)[0].name).id,
      tags: a.tags ?? [],
      assignees: (a.assignees ?? [me]).map((u) => u.id),
      due: typeof a.due === "string" ? { start: a.due, end: null, time_zone: null } : (a.due ?? null),
      created: at,
      edited: at,
      archived: a.archived ?? false,
      deleted: false,
      blocks: [],
    };
    pages.push(p);
    return p;
  };
  const page = (k: string) => {
    const p = pages.find((x) => x.id === k || x.id.replace(/-/g, "") === k);
    if (!p) throw new Error(`no page ${k}`);
    return p;
  };
  const touch = (p: SimPage) => (p.edited = now());
  const block = (type: string, text: string, children = false): NotionBlock => ({ object: "block", id: uuid(), type, has_children: children, [type]: { rich_text: rich(text) } });

  /** Changes made "outside" (in Notion's own app, by someone else). */
  const outside = {
    setStatus(k: string, name: string) {
      const p = page(k);
      p.status = optionIn(dbs.find((d) => d.id === p.dbId)!, name).id;
      touch(p);
    },
    rename(k: string, title: string) {
      const p = page(k);
      p.title = title;
      touch(p);
    },
    assign(k: string, ...who: SimUser[]) {
      const p = page(k);
      p.assignees = who.map((u) => u.id);
      touch(p);
    },
    setDue(k: string, due: DateValue | string | null) {
      const p = page(k);
      p.due = typeof due === "string" ? { start: due, end: null, time_zone: null } : due;
      touch(p);
    },
    /** Trashed: out of every query, still readable by id. */
    archive(k: string) {
      const p = page(k);
      p.archived = true;
      touch(p);
    },
    unarchive(k: string) {
      const p = page(k);
      p.archived = false;
      touch(p);
    },
    /** Removed for good: a 404 from now on. */
    deleteForever(k: string) {
      page(k).deleted = true;
    },
    /** Moved out of the database (under another page). */
    moveOut(k: string) {
      const p = page(k);
      p.dbId = null;
      touch(p);
    },
    setBody(k: string, blocks: { type: string; text: string; children?: boolean }[]) {
      const p = page(k);
      p.blocks = blocks.map((b) => block(b.type, b.text, b.children));
      touch(p);
    },
    comment(k: string, text: string, by: SimUser = me) {
      const p = page(k);
      const at = now();
      const c: SimComment = { id: uuid(), parent: { type: "page_id", page_id: p.id }, discussion: uuid(), created: at, edited: at, by: by.id, rich: rich(text) };
      comments.push(c);
      touch(p);
      return c;
    },
    /** A comment on one block of the body: not among the page's comments. */
    commentOnBlock(k: string, text: string, by: SimUser = me) {
      const p = page(k);
      const b = p.blocks[0] ?? (p.blocks[0] = block("paragraph", "body"));
      const at = now();
      comments.push({ id: uuid(), parent: { type: "block_id", block_id: b.id }, discussion: uuid(), created: at, edited: at, by: by.id, rich: rich(text) });
    },
    /** The database is no longer shared with the integration: everything in it is a 404. */
    unshare(name: string) {
      database(name).shared = false;
    },
    share(name: string) {
      database(name).shared = true;
    },
    renameColumn(dbName: string, from: string, to: string) {
      const c = database(dbName).columns.find((x) => x.name === from)!;
      c.name = to;
    },
  };

  // ---------- HTTP ----------

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
  const failure = (e: Refusal) => json({ object: "error", status: e.status, code: e.code, message: e.message }, e.status, e.headers);
  const notFound = (what: string, id: string) => new Refusal(404, "object_not_found", `Could not find ${what} with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`);
  const invalid = (message: string) => new Refusal(400, "validation_error", message);

  const userJson = (u: SimUser): NotionUser => ({
    object: "user",
    id: u.id,
    type: "person",
    name: u.name,
    avatar_url: u.avatar,
    ...(state.userInfo && u.email ? { person: { email: u.email } } : {}),
  });
  const bot = (): NotionUser => ({
    object: "user",
    id: WORKSPACE_BOT,
    type: "bot",
    name: "inkledger",
    avatar_url: null,
    bot: { owner: o.owner === "user" ? { type: "user", user: userJson(me) } : { type: "workspace", workspace: true }, workspace_name: "Acme" },
  });
  const anyUser = (id: string): NotionUser | null => (id === WORKSPACE_BOT ? bot() : users.has(id) ? userJson(users.get(id)!) : null);

  const dbJson = (d: SimDb): NotionDatabase => ({
    object: "database",
    id: d.id,
    title: rich(d.name),
    url: `https://www.notion.so/${d.id.replace(/-/g, "")}`,
    properties: Object.fromEntries(d.columns.map((c) => [c.name, c])),
  });

  const pageJson = (p: SimPage, only?: Set<string>): NotionPage => {
    const d = dbs.find((x) => x.id === p.dbId);
    const values: Record<string, NotionValue> = {};
    for (const c of d?.columns ?? [{ id: "title", name: "title", type: "title" }]) {
      if (only && !only.has(c.id)) continue;
      const v: NotionValue = { id: c.id, type: c.type };
      const all = [...(c.status?.options ?? []), ...(c.select?.options ?? [])];
      if (c.type === "title") v.title = rich(p.title);
      else if (c.type === "status") v.status = all.find((x) => x.id === p.status) ?? null;
      else if (c.type === "select") v.select = all.find((x) => x.id === p.status) ?? null;
      else if (c.type === "people") v.people = p.assignees.map((id) => anyUser(id)!).filter(Boolean);
      else if (c.type === "date") v.date = p.due;
      else if (c.type === "multi_select") v.multi_select = p.tags.map((t) => ({ id: `tag-${t}`, name: t }));
      values[c.name] = v;
    }
    return {
      object: "page",
      id: p.id,
      created_time: iso(minute(p.created)),
      last_edited_time: iso(minute(p.edited)),
      archived: p.archived,
      in_trash: p.archived,
      url: `https://www.notion.so/${slug(p.title)}-${p.id.replace(/-/g, "")}`,
      parent: p.dbId ? { type: "database_id", database_id: p.dbId } : { type: "page_id", page_id: uuid() },
      properties: values,
    };
  };

  /** A page the integration can read: shared database (a page elsewhere is never shared in this simulator), not removed. */
  const readable = (id: string): SimPage => {
    const p = pages.find((x) => x.id === id && !x.deleted);
    const d = p && dbs.find((x) => x.id === p.dbId);
    // A page elsewhere than a database is shared through its own parent, which this simulator doesn't model: readable.
    if (!p || (d && !d.shared)) throw notFound("page", id);
    return p;
  };
  const dbOf = (id: string): SimDb => {
    const d = dbs.find((x) => x.id === id);
    if (!d || !d.shared) throw notFound("database", id);
    return d;
  };

  /** The id in a path: 32 hex characters or dashed; anything else is a 400. */
  const idIn = (raw: string): string => {
    const id = decodeURIComponent(raw);
    const h = id.replace(/-/g, "");
    if (!/^[0-9a-f]{32}$/i.test(h) && id !== WORKSPACE_BOT) throw invalid(`path failed validation: path.page_id should be a valid uuid, instead was "${id}".`);
    return id === WORKSPACE_BOT ? id : `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toLowerCase();
  };

  const columnOf = (d: SimDb, key: string): SimColumn => {
    const c = d.columns.find((x) => x.id === key || x.name === key);
    if (!c) throw invalid(`Could not find property with name or id: ${key}`);
    return c;
  };

  /** A filter against a page. */
  function matches(p: SimPage, d: SimDb, f: unknown): boolean {
    const x = objOf(f);
    if (Array.isArray(x.and)) return x.and.every((y) => matches(p, d, y));
    if (Array.isArray(x.or)) return x.or.some((y) => matches(p, d, y));
    if (x.timestamp === "last_edited_time" || x.timestamp === "created_time") {
      const cond = objOf(x[x.timestamp]);
      const at = minute(x.timestamp === "created_time" ? p.created : p.edited);
      const [[op, value]] = Object.entries(cond);
      const t = Date.parse(String(value));
      if (!Number.isFinite(t)) throw invalid("body failed validation: filter date is not a date.");
      return op === "on_or_after" ? at >= t : op === "after" ? at > t : op === "on_or_before" ? at <= t : op === "before" ? at < t : (() => { throw invalid(`unsupported timestamp condition ${op}`); })();
    }
    if (typeof x.property !== "string") throw invalid("body failed validation: filter is not a valid filter.");
    const c = columnOf(d, x.property);
    const cond = objOf(x[c.type]);
    if (Object.keys(cond).length === 0) throw invalid(`body failed validation: filter on a ${c.type} property needs a ${c.type} condition.`);
    const [[op, value]] = Object.entries(cond);
    switch (c.type) {
      case "people":
        return op === "contains" ? p.assignees.includes(String(value)) : op === "does_not_contain" ? !p.assignees.includes(String(value)) : op === "is_empty" ? p.assignees.length === 0 : p.assignees.length > 0;
      case "title":
        return op === "contains" ? p.title.toLowerCase().includes(String(value).toLowerCase()) : op === "equals" ? p.title === value : (() => { throw invalid(`unsupported title condition ${op}`); })();
      case "status":
      case "select": {
        const all = [...(c.status?.options ?? []), ...(c.select?.options ?? [])];
        const name = all.find((y) => y.id === p.status)?.name;
        return op === "equals" ? name === value : op === "does_not_equal" ? name !== value : op === "is_empty" ? p.status === null : p.status !== null;
      }
      default:
        throw invalid(`filter on ${c.type} is not simulated`);
    }
  }

  const sortKeys = (list: SimPage[], sorts: unknown): SimPage[] => {
    const s = Array.isArray(sorts) ? objOf(sorts[0]) : {};
    const dir = s.direction === "descending" ? -1 : 1;
    if (s.timestamp === "last_edited_time") return [...list].sort((a, b) => dir * (minute(a.edited) - minute(b.edited)));
    if (s.timestamp === "created_time") return [...list].sort((a, b) => dir * (a.created - b.created));
    // No order is promised: the simulator gives the newest first, so a consumer can't lean on it.
    return [...list].sort((a, b) => b.created - a.created);
  };

  /** Cursor paging of a list: the cursor is opaque, page_size 100 at most. */
  function paged<T>(rows: T[], size: unknown, cursor: unknown): { object: "list"; results: T[]; next_cursor: string | null; has_more: boolean } {
    const n = size === undefined ? 100 : Number(size);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw invalid("body failed validation: body.page_size should be less than or equal to `100`.");
    let from = 0;
    if (cursor !== undefined && cursor !== null) {
      from = Number.parseInt(Buffer.from(typeof cursor === "string" ? cursor : "", "base64url").toString("utf8").replace(/^c/, ""), 10);
      if (!Number.isInteger(from) || from < 0) throw invalid("body failed validation: start_cursor is not a valid cursor.");
    }
    const slice = rows.slice(from, from + n);
    const more = from + n < rows.length;
    return { object: "list", results: slice, next_cursor: more ? Buffer.from(`c${from + n}`).toString("base64url") : null, has_more: more };
  }

  const richOk = (v: unknown): NotionRichText[] => {
    if (!Array.isArray(v) || v.length === 0) throw invalid("body failed validation: body.rich_text should be a non-empty array.");
    if (v.length > 100) throw invalid("body failed validation: body.rich_text.length should be ≤ `100`.");
    return v.map((e) => {
      const t = objOf(objOf(e).text);
      const content = t.content;
      if (typeof content !== "string") throw invalid("body failed validation: body.rich_text[0].text.content should be defined.");
      if (content.length > 2000) throw invalid("body failed validation: body.rich_text[0].text.content.length should be ≤ `2000`, instead was `" + content.length + "`.");
      const link = isObj(t.link) && typeof t.link.url === "string" ? { url: t.link.url } : null;
      const ann = objOf(objOf(e).annotations);
      return { type: "text", text: { content, link }, annotations: ann, plain_text: content, href: link?.url ?? null } satisfies NotionRichText;
    });
  };

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const base = new URL(apiBase);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body && typeof init.body === "string" ? objOf(JSON.parse(init.body)) : {};
    calls.push({ method, path: url.pathname, search: url.search, body });
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)) return json({ object: "error", status: 404, code: "invalid_request_url", message: "Invalid request URL." }, 404);
    const path = url.pathname.slice(base.pathname.length);
    const q = url.searchParams;
    try {
      if (!/^Bearer \S+$/.test(headers.get("authorization") ?? "") || headers.get("authorization") !== `Bearer ${token}` || state.revoked) {
        throw new Refusal(401, "unauthorized", "API token is invalid.");
      }
      if (!headers.get("notion-version")) throw invalid("Notion-Version header failed validation: Notion-Version header should be defined, instead was `undefined`.");
      if (state.exhausted) throw new Refusal(429, "rate_limited", "You have been rate limited. Please try again in a few minutes.", { "Retry-After": String(state.retryAfter) });

      if (method === "GET" && path === "/users/me") return json(bot());
      if (method === "GET" && path === "/users") return json(paged([...users.values()].map(userJson), q.get("page_size") ?? undefined, q.get("start_cursor") ?? undefined));
      let m = /^\/users\/([^/]+)$/.exec(path);
      if (method === "GET" && m) {
        const id = idIn(m[1]);
        const u = anyUser(id);
        if (!u) throw notFound("user", id);
        return json(u);
      }

      m = /^\/databases\/([^/]+)(\/query)?$/.exec(path);
      if (m) {
        const d = dbOf(idIn(m[1]));
        if (method === "GET" && !m[2]) return json(dbJson(d));
        if (method === "POST" && m[2]) {
          const only = q.get("filter_properties") ? new Set(q.getAll("filter_properties")) : undefined;
          const inDb = pages.filter((p) => !p.deleted && !p.archived && p.dbId === d.id);
          const hit = body.filter === undefined ? inDb : inDb.filter((p) => matches(p, d, body.filter));
          const list = paged(sortKeys(hit, body.sorts), body.page_size, body.start_cursor);
          return json({ ...list, results: list.results.map((p) => pageJson(p, only)) });
        }
        throw new Refusal(405, "invalid_request_url", "Invalid request URL.");
      }

      m = /^\/pages\/([^/]+)$/.exec(path);
      if (m) {
        const id = idIn(m[1]);
        // A database's id is not a page's.
        if (dbs.some((d) => d.id === id)) throw invalid(`Provided ID ${id} is a database, not a page. Use the retrieve database API instead.`);
        const p = readable(id);
        if (method === "GET") return json(pageJson(p));
        if (method === "PATCH") {
          if (p.archived && body.archived !== false) throw invalid("Can't edit block that is archived. You must unarchive the block before editing.");
          const d = dbs.find((x) => x.id === p.dbId)!;
          for (const [key, raw] of Object.entries(objOf(body.properties))) {
            const c = columnOf(d, key);
            const v = objOf(raw);
            if (c.type === "status" || c.type === "select") {
              const given = objOf(v[c.type]);
              const options = c.status?.options ?? c.select?.options ?? [];
              const opt = options.find((x) => (typeof given.id === "string" ? x.id === given.id : x.name === given.name));
              if (!opt) throw invalid(`Invalid status option. Status option "${String(given.name ?? given.id)}" does not exist.`);
              p.status = opt.id;
            } else if (c.type === "title") {
              p.title = richOk(v.title).map((r) => r.plain_text).join("");
            } else throw invalid(`Updating ${c.type} is not simulated`);
          }
          if (typeof body.archived === "boolean") p.archived = body.archived;
          touch(p);
          return json(pageJson(p));
        }
      }

      m = /^\/blocks\/([^/]+)\/children$/.exec(path);
      if (method === "GET" && m) {
        const p = readable(idIn(m[1]));
        return json(paged(p.blocks, q.get("page_size") ?? undefined, q.get("start_cursor") ?? undefined));
      }

      if (path === "/comments" && method === "GET") {
        if (!state.commentsAllowed) throw new Refusal(403, "restricted_resource", "Insufficient permissions for this endpoint.");
        const blockId = q.get("block_id");
        if (!blockId) throw invalid("Missing query parameter: block_id.");
        const id = idIn(blockId);
        const rows = comments.filter((c) => (c.parent.type === "page_id" ? c.parent.page_id === id : c.parent.block_id === id));
        readableOrBlock(id);
        const list = paged(rows.sort((a, b) => a.created - b.created).map(commentJson), q.get("page_size") ?? undefined, q.get("start_cursor") ?? undefined);
        return json(list);
      }
      if (path === "/comments" && method === "POST") {
        if (!state.commentsAllowed) throw new Refusal(403, "restricted_resource", "Insufficient permissions for this endpoint.");
        const parent = objOf(body.parent);
        if (typeof parent.page_id !== "string") throw invalid("body failed validation: body.parent.page_id should be defined.");
        const p = readable(idIn(parent.page_id));
        const at = now();
        const c: SimComment = { id: uuid(), parent: { type: "page_id", page_id: p.id }, discussion: uuid(), created: at, edited: at, by: WORKSPACE_BOT, rich: richOk(body.rich_text) };
        comments.push(c);
        touch(p);
        return json(commentJson(c));
      }
      throw new Refusal(404, "invalid_request_url", `Invalid request URL: ${method} ${path}`);
    } catch (e) {
      if (e instanceof Refusal) return failure(e);
      throw e;
    }
  }

  /** A block id that belongs to a readable page. */
  function readableOrBlock(id: string) {
    const p = pages.find((x) => x.id === id || x.blocks.some((b) => b.id === id));
    if (!p) throw notFound("block", id);
    readable(p.id);
  }
  const commentJson = (c: SimComment): NotionComment => ({
    object: "comment",
    id: c.id,
    parent: c.parent,
    discussion_id: c.discussion,
    created_time: iso(minute(c.created)),
    last_edited_time: iso(minute(c.edited)),
    created_by: { object: "user", id: c.by },
    rich_text: c.rich,
  });

  /** A webhook delivery as Notion sends it: the raw body, signed (HMAC-SHA256 of the body under the verification token). */
  function webhook(type: string, entityId: string, w: { secret?: string; signedWith?: string; id?: string; timestamp?: string; entityType?: string } = {}) {
    const rawBody = JSON.stringify({ id: w.id ?? uuid(), timestamp: w.timestamp ?? iso(now()), workspace_id: uuid(), type, entity: { id: entityId, type: w.entityType ?? (type.startsWith("comment") ? "comment" : "page") }, data: {} });
    const signature = `sha256=${createHmac("sha256", w.signedWith ?? w.secret ?? verificationToken).update(rawBody, "utf8").digest("hex")}`;
    return { rawBody, headers: { "x-notion-signature": signature, "content-type": "application/json" } };
  }

  return {
    apiBase,
    token,
    /** What the webhook is signed with */
    verificationToken,
    me,
    users,
    dbs,
    pages,
    comments,
    state,
    calls,
    addUser,
    addDatabase,
    add,
    outside,
    webhook,
    db: database,
    page,
    option: optionIn,
    /** End of setup: from now on, changes are stamped with the real clock. */
    live: () => void (seeding = false),
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    revoke: () => (state.revoked = true),
    fetch: handle,
  };
}
