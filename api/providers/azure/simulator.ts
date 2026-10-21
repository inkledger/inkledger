// An Azure DevOps in memory, for tests: the REST endpoints the adapter calls
// (api-version 7.1), written from the service's documentation, with its
// shapes and its traps:
// - a refused token is a 203 and a sign-in page unless the call asks for a
//   401 (X-TFS-FedAuthRedirect: Suppress); no token at all is a 401;
// - ids are unique across the organization; the project is part of the key
//   (Project#12), so a rename or a move changes the key and not the id;
// - WIQL compares dates as days unless asked for time precision (timePrecision),
//   reads a date without a Z in the user's time zone, and ends in an error
//   past its result ceiling (or silently cuts at $top);
// - a batch read with a missing id fails whole unless errorPolicy is "omit",
//   takes 200 ids at most, and `fields` cannot be combined with `$expand`;
// - deleted items answer 404 and only the reporting revisions remember them;
// - times are hours (decimals), and only some types have Completed Work;
// - any new revision (a comment included) breaks a `test /rev`, which is
//   refused with a plain 400 (TF26071);
// - comments are HTML, project-scoped, and a preview API (the version needs
//   "-preview"); their default order is newest first;
// - older servers send identities as "Name <unique name>";
// - a type without listed transitions (an inherited process) allows any state.
import type { AzureIdentity } from "./client";

export type SimUser = { id: string; displayName: string; uniqueName: string };
type StateDef = { name: string; category: "Proposed" | "InProgress" | "Resolved" | "Completed" | "Removed"; color: string };
type TypeDef = { states: StateDef[]; transitions: Record<string, string[]>; completedWork: boolean };

const S = (name: string, category: StateDef["category"], color: string): StateDef => ({ name, category, color });
/** The Agile process, as far as the adapter looks at it. */
const TYPES: Record<string, TypeDef> = {
  Task: {
    states: [S("New", "Proposed", "b2b2b2"), S("Active", "InProgress", "007acc"), S("Closed", "Completed", "339933"), S("Removed", "Removed", "ffffff")],
    transitions: { "": ["New"], New: ["Active", "Removed"], Active: ["New", "Closed", "Removed"], Closed: ["Active", "New"], Removed: ["New"] },
    completedWork: true,
  },
  Bug: {
    states: [S("New", "Proposed", "b2b2b2"), S("Active", "InProgress", "007acc"), S("Resolved", "Resolved", "ff9d00"), S("Closed", "Completed", "339933")],
    transitions: { "": ["New"], New: ["Active", "Resolved", "Closed"], Active: ["Resolved", "Closed", "New"], Resolved: ["Active", "Closed"], Closed: ["Active", "New"] },
    completedWork: true,
  },
  "User Story": {
    states: [S("New", "Proposed", "b2b2b2"), S("Active", "InProgress", "007acc"), S("Resolved", "Resolved", "ff9d00"), S("Closed", "Completed", "339933"), S("Removed", "Removed", "ffffff")],
    transitions: { "": ["New"], New: ["Active", "Removed"], Active: ["Resolved", "Closed", "New", "Removed"], Resolved: ["Active", "Closed"], Closed: ["Active"], Removed: ["New"] },
    completedWork: false,
  },
  Epic: {
    states: [S("New", "Proposed", "b2b2b2"), S("Active", "InProgress", "007acc"), S("Closed", "Completed", "339933")],
    transitions: { "": ["New"], New: ["Active"], Active: ["Closed"], Closed: ["Active"] },
    completedWork: false,
  },
};

type SimComment = { id: number; text: string; by: string; at: string; deleted: boolean };
type SimUpdate = { rev: number; by: string; at: string; fields: Record<string, { oldValue?: unknown; newValue?: unknown }> };
export type SimItem = {
  id: number;
  rev: number;
  project: string;
  type: string;
  /** Stored values by reference name; identities by user id */
  fields: Record<string, unknown>;
  comments: SimComment[];
  updates: SimUpdate[];
  deleted: boolean;
  deletedAt: string | null;
};

export type AddOptions = {
  type?: string;
  state?: string;
  /** "me" (default), "other", or nobody */
  assignee?: "me" | "other" | null;
  priority?: number;
  tags?: string[];
  /** Hours */
  estimate?: number;
  /** Hours */
  completed?: number;
  /** A calendar day, held at midnight of the user's zone as the service does */
  due?: string;
  description?: string;
  parent?: number;
};

const DATE_FIELDS = new Set(["system.changeddate", "system.createddate", "system.statechangedate", "microsoft.vsts.scheduling.duedate"]);
const ALIASES: Record<string, string> = { id: "system.id", title: "system.title", state: "system.state", "assigned to": "system.assignedto", "work item type": "system.workitemtype", "changed date": "system.changeddate", "created date": "system.createddate", "team project": "system.teamproject", tags: "system.tags" };

class SimError extends Error {
  readonly status: number;
  readonly typeKey: string;
  constructor(status: number, message: string, typeKey = "VssServiceException") {
    super(message);
    this.status = status;
    this.typeKey = typeKey;
  }
}
const bad = (message: string, typeKey?: string) => new SimError(400, message, typeKey);

// ---------- WIQL ----------

type Tok = { t: "str" | "num" | "field" | "var" | "op" | "word" | "("  | ")" | ","; v: string };
function tokenize(q: string): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < q.length; ) {
    const c = q[i];
    if (/\s/.test(c)) i++;
    else if (c === "'" || c === '"') {
      let v = "";
      for (i++; ; i++) {
        if (i >= q.length) throw bad("The WIQL query is invalid: unterminated string.", "SyntaxException");
        if (q[i] === c) {
          if (q[i + 1] === c) {
            v += c;
            i++;
          } else break;
        } else v += q[i];
      }
      i++;
      out.push({ t: "str", v });
    } else if (c === "[") {
      const e = q.indexOf("]", i);
      if (e < 0) throw bad("The WIQL query is invalid: unterminated field name.", "SyntaxException");
      out.push({ t: "field", v: q.slice(i + 1, e) });
      i = e + 1;
    } else if (c === "@") {
      const m = /^@[A-Za-z]+(\s*[-+]\s*\d+)?/.exec(q.slice(i));
      if (!m) throw bad("The WIQL query is invalid: bad macro.", "SyntaxException");
      out.push({ t: "var", v: m[0].replace(/\s+/g, "") });
      i += m[0].length;
    } else if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(q.slice(i))!;
      out.push({ t: "num", v: m[0] });
      i += m[0].length;
    } else if (c === "(" || c === ")" || c === ",") {
      out.push({ t: c, v: c });
      i++;
    } else if (/[<>=]/.test(c)) {
      const two = q.slice(i, i + 2);
      const op = ["<>", ">=", "<="].includes(two) ? two : c;
      out.push({ t: "op", v: op });
      i += op.length;
    } else if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z]+/.exec(q.slice(i))!;
      out.push({ t: "word", v: m[0].toUpperCase() });
      i += m[0].length;
    } else throw bad(`The WIQL query is invalid: unexpected "${c}".`, "SyntaxException");
  }
  return out;
}

type Ctx = { me: SimUser; users: SimUser[]; tzMinutes: number; precise: boolean; now: number };
type Expr = (item: SimItem, ctx: Ctx) => boolean;

const cmp = (a: string | number, b: string | number) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));
const refOf = (name: string) => {
  const k = name.toLowerCase();
  return ALIASES[k] ?? k;
};

/** A field as WIQL compares it: a number, a date (ms), or text. */
function valueOf(item: SimItem, ref: string, ctx: Ctx): string | number {
  switch (ref) {
    case "system.id":
      return item.id;
    case "system.rev":
      return item.rev;
    case "system.teamproject":
      return item.project;
    case "system.workitemtype":
      return item.type;
    case "system.assignedto": {
      const u = ctx.users.find((x) => x.id === item.fields["System.AssignedTo"]);
      return u ? u.displayName : "";
    }
  }
  const key = Object.keys(item.fields).find((k) => k.toLowerCase() === ref);
  const raw = key ? item.fields[key] : undefined;
  if (DATE_FIELDS.has(ref)) return typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  return typeof raw === "number" ? raw : typeof raw === "string" ? raw : "";
}

/** A date literal in ms: a Z (or an offset) is exact, none means the user's zone. */
function dateLiteral(s: string, tz: number): number {
  const zoned = /(Z|[+-]\d\d:?\d\d)$/i.test(s) && s.includes("T");
  const ms = Date.parse(zoned ? s : `${s}${s.includes("T") ? "" : "T00:00:00"}Z`);
  if (!Number.isFinite(ms)) throw bad(`The WIQL query is invalid: "${s}" is not a date.`, "SyntaxException");
  return zoned ? ms : ms - tz * 60_000;
}

function parseWhere(toks: Tok[]): Expr {
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const word = (w: string) => peek()?.t === "word" && peek().v === w;
  const orExpr = (): Expr => {
    let left = andExpr();
    while (word("OR")) {
      p++;
      const l = left;
      const r = andExpr();
      left = (i, c) => l(i, c) || r(i, c);
    }
    return left;
  };
  const andExpr = (): Expr => {
    let left = atom();
    while (word("AND")) {
      p++;
      const l = left;
      const r = atom();
      left = (i, c) => l(i, c) && r(i, c);
    }
    return left;
  };
  const literal = (): Tok => {
    const t = next();
    if (!t || !["str", "num", "var"].includes(t.t)) throw bad("The WIQL query is invalid: a value was expected.", "SyntaxException");
    return t;
  };
  const atom = (): Expr => {
    if (peek()?.t === "(") {
      p++;
      const e = orExpr();
      if (next()?.t !== ")") throw bad("The WIQL query is invalid: a ) was expected.", "SyntaxException");
      return e;
    }
    const f = next();
    if (!f || f.t !== "field") throw bad("The WIQL query is invalid: a field was expected.", "SyntaxException");
    const ref = refOf(f.v);
    let negate = false;
    if (word("NOT")) {
      p++;
      negate = true;
    }
    const o = next();
    if (!o) throw bad("The WIQL query is invalid: an operator was expected.", "SyntaxException");
    const test = (item: SimItem, ctx: Ctx, lit: Tok, op: string): boolean => {
      if (lit.t === "var" && lit.v === "@Me") return (ref === "system.assignedto" ? item.fields["System.AssignedTo"] === ctx.me.id : false) === (op === "=");
      const have = valueOf(item, ref, ctx);
      let want: string | number = lit.t === "num" ? Number(lit.v) : lit.v;
      if (lit.t === "var") {
        const m = /^@Today([-+]\d+)?$/i.exec(lit.v);
        if (!m) throw bad(`The WIQL query is invalid: unknown macro ${lit.v}.`, "SyntaxException");
        want = Math.floor((ctx.now + ctx.tzMinutes * 60_000) / 86_400_000) * 86_400_000 - ctx.tzMinutes * 60_000 + Number(m[1] ?? 0) * 86_400_000;
      }
      if (op === "CONTAINS") return String(have).toLowerCase().includes(String(want).toLowerCase());
      let a = have;
      let b = want;
      if (DATE_FIELDS.has(ref)) {
        a = Number(have);
        b = typeof want === "number" ? want : dateLiteral(want, ctx.tzMinutes);
        // Without time precision a date is only a day: the user's.
        if (!ctx.precise) {
          const day = (ms: number) => Math.floor((ms + ctx.tzMinutes * 60_000) / 86_400_000);
          a = day(a);
          b = day(b);
        }
      } else if (typeof have === "number") b = Number(want);
      else if (typeof want === "number") b = String(want);
      else {
        a = String(have).toLowerCase();
        b = String(want).toLowerCase();
      }
      switch (op) {
        case "=":
          return a === b;
        case "<>":
          return a !== b;
        case ">":
          return cmp(a, b) > 0;
        case "<":
          return cmp(a, b) < 0;
        case ">=":
          return cmp(a, b) >= 0;
        case "<=":
          return cmp(a, b) <= 0;
        default:
          throw bad(`The WIQL query is invalid: unknown operator ${op}.`, "SyntaxException");
      }
    };
    if (o.t === "word" && o.v === "IN") {
      if (next()?.t !== "(") throw bad("The WIQL query is invalid: a ( was expected.", "SyntaxException");
      const list: Tok[] = [literal()];
      while (peek()?.t === ",") {
        p++;
        list.push(literal());
      }
      if (next()?.t !== ")") throw bad("The WIQL query is invalid: a ) was expected.", "SyntaxException");
      return (i, c) => list.some((l) => test(i, c, l, "=")) !== negate;
    }
    const op = o.v;
    if (!(o.t === "op" || (o.t === "word" && op === "CONTAINS"))) throw bad(`The WIQL query is invalid: unexpected "${o.v}".`, "SyntaxException");
    const lit = literal();
    return (i, c) => test(i, c, lit, op) !== negate;
  };
  const e = orExpr();
  if (p < toks.length) throw bad(`The WIQL query is invalid: unexpected "${toks[p].v}".`, "SyntaxException");
  return e;
}

function runWiql(query: string, items: SimItem[], ctx: Ctx): SimItem[] {
  const toks = tokenize(query);
  if (!(toks[0]?.t === "word" && toks[0].v === "SELECT")) throw bad("The WIQL query is invalid: it must start with SELECT.", "SyntaxException");
  const from = toks.findIndex((t) => t.t === "word" && t.v === "FROM");
  if (from < 0 || toks[from + 1]?.v.toUpperCase() !== "WORKITEMS") throw bad("The WIQL query is invalid: only FROM WorkItems is supported here.", "SyntaxException");
  const where = toks.findIndex((t, i) => i > from && t.t === "word" && t.v === "WHERE");
  const order = toks.findIndex((t, i) => i > from && t.t === "word" && t.v === "ORDER" && toks[i + 1]?.v === "BY");
  const whereToks = where < 0 ? [] : toks.slice(where + 1, order < 0 ? undefined : order);
  const pred: Expr = where < 0 ? () => true : parseWhere(whereToks);
  const keys: { ref: string; dir: 1 | -1 }[] = [];
  if (order >= 0) {
    const t = toks.slice(order + 2);
    for (let i = 0; i < t.length; i++) {
      if (t[i].t === "field") {
        const dir = t[i + 1]?.v === "DESC" ? -1 : 1;
        keys.push({ ref: refOf(t[i].v), dir });
      }
    }
  }
  const hits = items.filter((i) => !i.deleted && pred(i, ctx));
  return hits.sort((a, b) => {
    for (const k of keys) {
      const x = valueOf(a, k.ref, ctx);
      const y = valueOf(b, k.ref, ctx);
      if (x !== y) return cmp(x, y) * k.dir;
    }
    return a.id - b.id;
  });
}

// ---------- The service ----------

export function azureSimulator(o: { apiBase?: string; wiqlLimit?: number; legacyIdentities?: boolean; tzOffsetMinutes?: number } = {}) {
  const apiBase = (o.apiBase ?? "https://dev.azure.com/acme").replace(/\/+$/, "");
  const basePath = new URL(apiBase).pathname.replace(/\/$/, "");
  const token = "pat-sim";
  const me: SimUser = { id: "6e0f1f2a-0000-4000-8000-000000000001", displayName: "Mario Rossi", uniqueName: "mario@example.com" };
  const other: SimUser = { id: "6e0f1f2a-0000-4000-8000-000000000002", displayName: "Anna Bianchi", uniqueName: "anna@example.com" };
  const users = [me, other];
  const settings = { wiqlLimit: o.wiqlLimit ?? 20_000, legacy: o.legacyIdentities ?? false, tz: o.tzOffsetMinutes ?? 60 };
  const projects: { id: string; name: string; inherited: boolean }[] = [];
  const items: SimItem[] = [];
  const failures: { status: number; headers: Record<string, string> }[] = [];
  const calls: string[] = [];
  let clock = Date.UTC(2026, 9, 1, 9, 0, 0);
  let seq = 0;
  let commentSeq = 0;

  const iso = () => new Date(clock).toISOString();
  const tick = () => {
    clock += 1000;
    return iso();
  };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
  const fail = (e: SimError) => json({ $id: "1", innerException: null, message: e.message, typeName: `Microsoft.TeamFoundation.${e.typeKey}`, typeKey: e.typeKey, errorCode: 0, eventId: 3000 }, e.status);

  const addProject = (name: string, o2: { inherited?: boolean } = {}) => {
    const p = { id: `0b5a0000-0000-4000-8000-${String(projects.length + 1).padStart(12, "0")}`, name, inherited: o2.inherited ?? false };
    projects.push(p);
    return p;
  };
  const project = (name: string) => projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const typeDef = (p: { inherited: boolean }, type: string): TypeDef | undefined => {
    const d = TYPES[Object.keys(TYPES).find((k) => k.toLowerCase() === type.toLowerCase()) ?? ""];
    return d && p.inherited ? { ...d, transitions: {} } : d;
  };
  /** A calendar day at midnight of the user's zone, as the service stores a due date. */
  const dueAt = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - settings.tz * 60_000).toISOString();

  /** Changes an item the way the service does: a new revision, its dates, its update record. */
  function mutate(item: SimItem, changes: Record<string, unknown>, by: SimUser = me) {
    const at = tick();
    const delta: SimUpdate["fields"] = {};
    for (const [k, v] of Object.entries(changes)) {
      const before = k === "System.TeamProject" ? item.project : item.fields[k];
      if (JSON.stringify(before) === JSON.stringify(v)) continue;
      delta[k] = { ...(before === undefined ? {} : { oldValue: before }), newValue: v };
      if (k === "System.TeamProject") item.project = String(v);
      else item.fields[k] = v;
      if (k === "System.State") item.fields["System.StateChangeDate"] = at;
    }
    item.rev += 1;
    const oldChanged = item.fields["System.ChangedDate"];
    item.fields["System.ChangedDate"] = at;
    item.fields["System.ChangedBy"] = by.id;
    item.updates.push({ rev: item.rev, by: by.id, at, fields: { "System.Rev": { oldValue: item.rev - 1, newValue: item.rev }, "System.ChangedDate": { oldValue: oldChanged, newValue: at }, ...delta } });
  }

  function add(projectName: string, title: string, a: AddOptions = {}): SimItem {
    const p = project(projectName) ?? addProject(projectName);
    const type = a.type ?? "Task";
    const def = typeDef(p, type);
    if (!def) throw new Error(`unknown type ${type}`);
    const at = tick();
    const item: SimItem = {
      id: ++seq,
      rev: 1,
      project: p.name,
      type,
      fields: {
        "System.Title": title,
        "System.State": a.state ?? def.states[0].name,
        "System.Reason": "New",
        "System.CreatedDate": at,
        "System.ChangedDate": at,
        "System.StateChangeDate": at,
        "System.CreatedBy": me.id,
        "System.ChangedBy": me.id,
        ...(a.assignee === null ? {} : { "System.AssignedTo": a.assignee === "other" ? other.id : me.id }),
        ...(a.priority === undefined ? {} : { "Microsoft.VSTS.Common.Priority": a.priority }),
        ...(a.tags ? { "System.Tags": a.tags.join("; ") } : {}),
        ...(a.estimate === undefined ? {} : { "Microsoft.VSTS.Scheduling.OriginalEstimate": a.estimate }),
        ...(a.completed === undefined ? {} : { "Microsoft.VSTS.Scheduling.CompletedWork": a.completed }),
        ...(a.due ? { "Microsoft.VSTS.Scheduling.DueDate": dueAt(a.due) } : {}),
        ...(a.description ? { "System.Description": a.description } : {}),
        ...(a.parent === undefined ? {} : { "System.Parent": a.parent }),
      },
      comments: [],
      updates: [],
      deleted: false,
      deletedAt: null,
    };
    item.updates.push({ rev: 1, by: me.id, at, fields: { "System.Rev": { newValue: 1 }, "System.Title": { newValue: title }, "System.State": { newValue: item.fields["System.State"] }, "System.ChangedDate": { newValue: at } } });
    items.push(item);
    return item;
  }

  // ---------- Rendering ----------

  const identity = (id: unknown): AzureIdentity | string | undefined => {
    const u = users.find((x) => x.id === id);
    if (!u) return undefined;
    if (settings.legacy) return `${u.displayName} <${u.uniqueName}>`;
    return {
      displayName: u.displayName,
      url: `https://spsprodweu5.vssps.visualstudio.com/A0000/_apis/Identities/${u.id}`,
      _links: { avatar: { href: `${apiBase}/_apis/GraphProfile/MemberAvatars/aad.${u.id}` } },
      id: u.id,
      uniqueName: u.uniqueName,
      imageUrl: `${apiBase}/_api/_common/identityImage?id=${u.id}`,
      descriptor: `aad.${u.id}`,
    };
  };
  const IDENTITY_FIELDS = new Set(["System.AssignedTo", "System.CreatedBy", "System.ChangedBy"]);
  const render = (item: SimItem, only?: string[]) => {
    const all: Record<string, unknown> = { ...item.fields, "System.Id": item.id, "System.Rev": item.rev, "System.TeamProject": item.project, "System.WorkItemType": item.type };
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(all)) {
      if (only && !only.some((f) => f.toLowerCase() === k.toLowerCase())) continue;
      // The description is heavy: sent only when asked for.
      if (!only && k === "System.Description") continue;
      const shown = IDENTITY_FIELDS.has(k) ? identity(v) : v;
      if (shown !== undefined) fields[k] = shown;
    }
    return { id: item.id, rev: item.rev, fields, url: `${apiBase}/_apis/wit/workItems/${item.id}` };
  };

  // ---------- Requests ----------

  const checkAuth = (headers: Headers): Response | null => {
    const auth = headers.get("authorization");
    if (!auth) return json({ message: "TF400813: The user '' is not authorized to access this resource." }, 401, { "WWW-Authenticate": "Basic" });
    const given = Buffer.from(auth.replace(/^Basic\s+/i, ""), "base64").toString("utf8");
    if (given === `:${token}`) return null;
    // A refused token: a sign-in page with a 203, unless the call asked for a plain 401.
    if (headers.get("x-tfs-fedauthredirect") === "Suppress") return json({ message: "TF400813: The user is not authorized to access this resource." }, 401, { "WWW-Authenticate": "Basic" });
    return new Response("<html><title>Sign in to your account</title></html>", { status: 203, headers: { "Content-Type": "text/html; charset=utf-8" } });
  };

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push(`${method} ${url.pathname}${url.search}`);
    const denied = checkAuth(headers);
    if (denied) return denied;
    const queued = failures.shift();
    if (queued) return json({ message: `simulated ${queued.status}` }, queued.status, queued.headers);
    try {
      return await route(url, method, headers, typeof init?.body === "string" ? init.body : "");
    } catch (e) {
      if (e instanceof SimError) return fail(e);
      throw e;
    }
  }

  const q = (url: URL, name: string) => url.searchParams.get(name);
  const missing = (id: number | string) => new SimError(404, `TF401232: Work item ${id} does not exist, or you do not have permissions to read it.`, "WorkItemUnauthorizedAccessException");
  const noProject = (name: string) => new SimError(404, `TF200016: The following project does not exist: ${name}. Verify that the name of the project is correct and that the project exists on the specified Azure DevOps Server.`, "ProjectDoesNotExistException");
  const find = (id: number) => items.find((i) => i.id === id);
  const live = (id: number) => {
    const i = find(id);
    if (!i || i.deleted) throw missing(id);
    return i;
  };

  async function route(url: URL, method: string, headers: Headers, rawBody: string): Promise<Response> {
    const segs = url.pathname
      .slice(basePath.length)
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
    const scope = segs[0] && !segs[0].startsWith("_") ? segs.shift()! : null;
    if (segs.shift() !== "_apis") return fail(new SimError(404, `unmocked ${method} ${url.pathname}`));
    const rest = segs.join("/").toLowerCase();
    const scoped = scope === null ? null : project(scope);
    if (scope !== null && !scoped) throw noProject(scope);
    const body = rawBody ? (JSON.parse(rawBody) as unknown) : null;
    const ctx: Ctx = { me, users, tzMinutes: settings.tz, precise: q(url, "timePrecision") === "true", now: clock };

    if (rest === "connectiondata") {
      return json({ authenticatedUser: { id: me.id, providerDisplayName: me.displayName, isActive: true, properties: { Account: { $type: "System.String", $value: me.uniqueName } } }, deploymentType: "hosted", instanceId: "a0000000-0000-4000-8000-000000000000" });
    }
    if (rest === "projects") {
      const top = Number(q(url, "$top") ?? 100);
      const skip = Number(q(url, "$skip") ?? 0);
      const page = projects.slice(skip, skip + top).map((p) => ({ id: p.id, name: p.name, state: "wellFormed", visibility: "private" }));
      return json({ count: page.length, value: page });
    }

    if (scoped && rest === "wit/workitemtypes") return json({ count: Object.keys(TYPES).length, value: Object.keys(TYPES).map((name) => ({ name, referenceName: `Microsoft.VSTS.WorkItemTypes.${name.replace(/\s/g, "")}`, isDisabled: false })) });
    const t = scoped ? /^wit\/workitemtypes\/([^/]+)(\/states)?$/.exec(rest) : null;
    if (t && scoped) {
      const name = segs[2];
      const def = typeDef(scoped, name);
      if (!def) throw new SimError(404, `TF400499: The work item type ${name} does not exist.`, "WorkItemTypeDoesNotExistException");
      const states = def.states.map((s) => ({ name: s.name, color: s.color, category: s.category }));
      if (t[2]) return json({ count: states.length, value: states });
      // `category` is not part of the type's own state list: the states endpoint has it.
      return json({ name, transitions: Object.fromEntries(Object.entries(def.transitions).map(([from, to]) => [from, to.map((x) => ({ to: x, actions: [] }))])), states: states.map(({ name: n, color }) => ({ name: n, color })) });
    }

    if (rest === "wit/wiql" && method === "POST") {
      const query = (body as { query?: unknown } | null)?.query;
      if (typeof query !== "string") throw bad("VS403474: The query is missing.", "ArgumentException");
      const hits = runWiql(query, items, ctx);
      const topParam = q(url, "$top");
      let ids = hits.map((i) => i.id);
      if (topParam === null && ids.length > settings.wiqlLimit) {
        throw bad(`VS402337: The number of work items returned exceeds the size limit of ${settings.wiqlLimit}. To avoid this error, add additional filters to your query.`, "WorkItemTrackingQueryResultSizeLimitExceededException");
      }
      // $top cuts the answer, silently, at the smaller of itself and the ceiling.
      if (topParam !== null) ids = ids.slice(0, Math.min(Number(topParam), settings.wiqlLimit));
      return json({ queryType: "flat", queryResultType: "workItem", asOf: iso(), columns: [{ referenceName: "System.Id", name: "ID", url: "x" }], sortColumns: [], workItems: ids.map((id) => ({ id, url: `${apiBase}/_apis/wit/workItems/${id}` })) });
    }

    if (rest === "wit/workitemsbatch" && method === "POST") {
      const b = (body ?? {}) as { ids?: number[]; fields?: string[]; $expand?: string; errorPolicy?: string };
      const ids = b.ids ?? [];
      if (ids.length > 200) throw bad("VS403492: The maximum number of work items that can be requested at once is 200.", "ArgumentException");
      if (b.fields && b.$expand) throw bad("VS403476: The expand parameter can not be used with the fields parameter.", "ArgumentException");
      const omit = (b.errorPolicy ?? "fail").toLowerCase() === "omit";
      const value = ids.map((id) => {
        const i = find(id);
        if (!i || i.deleted) {
          if (omit) return null;
          throw missing(id);
        }
        return render(i, b.fields);
      });
      return json({ count: value.length, value });
    }

    const wi = /^wit\/workitems\/(\d+)(?:\/(comments|updates))?$/.exec(rest);
    if (wi) {
      const id = Number(wi[1]);
      if (!wi[2]) {
        if (method === "GET") {
          const fields = q(url, "fields");
          if (fields && q(url, "$expand")) throw bad("VS403476: The expand parameter can not be used with the fields parameter.", "ArgumentException");
          return json(render(live(id), fields ? fields.split(",") : undefined));
        }
        if (method === "PATCH") return json(patch(live(id), headers, body));
      }
      if (wi[2] === "comments") return comments(live(id), url, method, body, scoped ?? null);
      if (wi[2] === "updates") {
        const item = live(id);
        const top = Number(q(url, "$top") ?? 200);
        const skip = Number(q(url, "$skip") ?? 0);
        const value = item.updates.slice(skip, skip + top).map((u) => ({
          id: u.rev,
          workItemId: item.id,
          rev: u.rev,
          revisedBy: identity(u.by),
          revisedDate: u.at,
          fields: Object.fromEntries(Object.entries(u.fields).map(([k, v]) => [k, IDENTITY_FIELDS.has(k) ? { oldValue: identity(v.oldValue), newValue: identity(v.newValue) } : v])),
        }));
        return json({ count: value.length, value });
      }
    }

    if (rest === "wit/reporting/workitemrevisions" && method === "GET") {
      const start = Date.parse(q(url, "startDateTime") ?? "");
      const withDeleted = q(url, "includeDeleted") === "true";
      const page = Number(q(url, "$maxPageSize") ?? 200);
      const from = Number(q(url, "continuationToken") ?? 0);
      const all = items.filter((i) => (withDeleted || !i.deleted) && (!Number.isFinite(start) || Date.parse(String(i.fields["System.ChangedDate"])) >= start)).sort((a, b) => a.id - b.id);
      const values = all.slice(from, from + page).map((i) => ({ id: i.id, rev: i.rev, fields: { "System.Id": i.id }, ...(i.deleted ? { isDeleted: true } : {}) }));
      const last = from + page >= all.length;
      return json({ values, nextLink: last ? null : "next", continuationToken: last ? null : String(from + page), isLastBatch: last });
    }

    return fail(new SimError(404, `unmocked ${method} ${url.pathname}`));
  }

  /** PATCH on a work item: JSON patch, all or nothing, tests first. */
  function patch(item: SimItem, headers: Headers, body: unknown) {
    if (!/application\/json-patch\+json/i.test(headers.get("content-type") ?? "")) throw new SimError(415, "The request content type must be application/json-patch+json.", "VssRequestContentTypeException");
    if (!Array.isArray(body)) throw bad("VS403474: A JSON patch document was expected.", "ArgumentException");
    const ops = body as { op: string; path: string; value?: unknown }[];
    for (const o of ops.filter((x) => x.op === "test")) {
      if (o.path === "/rev" && o.value !== item.rev) throw bad(`TF26071: This work item has been changed by someone else since you opened it. You will need to refresh it and discard your changes.`, "WorkItemConflictException");
    }
    const def = typeDef(project(item.project)!, item.type)!;
    const changes: Record<string, unknown> = {};
    for (const o of ops.filter((x) => x.op !== "test")) {
      const m = /^\/fields\/(.+)$/.exec(o.path);
      if (!m) throw bad(`VS403505: Unsupported path ${o.path}.`, "ArgumentException");
      const f = m[1];
      if (o.op === "remove") {
        changes[f] = undefined;
        continue;
      }
      switch (f) {
        case "System.State": {
          const to = def.states.find((s) => s.name === o.value);
          const from = String(item.fields["System.State"]);
          const allowed = Object.keys(def.transitions).length === 0 ? def.states.map((s) => s.name) : (def.transitions[from] ?? []);
          if (!to || to.name === from || !allowed.includes(to.name)) throw bad(`TF401320: Rule Error for field State. Error code: InvalidListValue, ${String(o.value)}`, "RuleValidationException");
          changes[f] = to.name;
          changes["System.Reason"] = `Moved to state ${to.name}`;
          break;
        }
        case "Microsoft.VSTS.Scheduling.CompletedWork":
        case "Microsoft.VSTS.Scheduling.OriginalEstimate":
          if (!def.completedWork) throw bad(`TF51535: Cannot find field ${f}.`, "RuleValidationException");
          if (typeof o.value !== "number" || o.value < 0) throw bad(`TF401320: Rule Error for field ${f}. Error code: InvalidNotEmpty`, "RuleValidationException");
          changes[f] = o.value;
          break;
        case "System.AssignedTo": {
          const u = users.find((x) => x.uniqueName === o.value || x.displayName === o.value);
          if (!u) throw bad(`TF401320: Rule Error for field Assigned To. Error code: IdentityNotFound`, "RuleValidationException");
          changes[f] = u.id;
          break;
        }
        case "System.Title":
        case "System.Tags":
        case "System.Description":
        case "Microsoft.VSTS.Common.Priority":
          changes[f] = o.value;
          break;
        default:
          throw bad(`TF51535: Cannot find field ${f}.`, "RuleValidationException");
      }
    }
    mutate(item, changes);
    return render(item, undefined);
  }

  function comments(item: SimItem, url: URL, method: string, body: unknown, scoped: { name: string } | null) {
    if (!/-preview/.test(q(url, "api-version") ?? "")) throw bad('The requested version "7.1" of the resource is under preview. The -preview flag must be supplied in the api-version for such requests. For example: "7.1-preview"', "VssInvalidPreviewVersionException");
    if (!scoped) throw new SimError(404, "VS402362: A project is needed to read the comments of a work item.", "ProjectNotSpecifiedException");
    if (scoped.name !== item.project) throw missing(item.id);
    const shown = (c: SimComment) => ({ workItemId: item.id, id: c.id, version: 1, text: c.text, createdBy: identity(c.by), createdDate: c.at, modifiedBy: identity(c.by), modifiedDate: c.at, isDeleted: c.deleted });
    if (method === "POST") {
      const text = (body as { text?: unknown } | null)?.text;
      if (typeof text !== "string" || !text) throw bad("VS403474: The comment text is missing.", "ArgumentException");
      const c: SimComment = { id: ++commentSeq, text, by: me.id, at: tick(), deleted: false };
      item.comments.push(c);
      // A comment is a new revision of the work item.
      mutate(item, {});
      return json(shown(c), 200);
    }
    const asc = q(url, "order") === "asc";
    const ordered = asc ? item.comments : [...item.comments].reverse();
    const top = Number(q(url, "$top") ?? 200);
    const from = Number(q(url, "continuationToken") ?? 0);
    const page = ordered.slice(from, from + top);
    const more = from + top < ordered.length;
    return json({ totalCount: ordered.length, count: page.length, comments: page.map(shown), ...(more ? { continuationToken: String(from + top) } : {}) });
  }

  return {
    apiBase,
    token,
    me,
    other,
    projects,
    items,
    /** Every request made, as "METHOD /path?query" */
    calls,
    fetch: handle,
    add,
    addProject,
    /** The next request fails with this status (a 429 carries Retry-After and the rate-limit headers) */
    failNext(status: number, headers: Record<string, string> = status === 429 ? { "Retry-After": "30", "X-RateLimit-Resource": "WIT", "X-RateLimit-Limit": "200", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 30) } : {}) {
      failures.push({ status, headers });
    },
    /** The server's clock moves on */
    advance(ms: number) {
      clock += ms;
    },
    now: () => clock,
    /** Things done by someone else, on the service itself */
    outside: {
      change: (id: number, changes: Record<string, unknown>, by: SimUser = other) => mutate(find(id)!, changes, by),
      comment(id: number, text: string, by: SimUser = other) {
        const i = find(id)!;
        i.comments.push({ id: ++commentSeq, text, by: by.id, at: tick(), deleted: false });
        mutate(i, {}, by);
      },
      assign: (id: number, who: "me" | "other" | null) => mutate(find(id)!, { "System.AssignedTo": who === null ? undefined : who === "me" ? me.id : other.id }, other),
      /** Into the recycle bin: gone for every read, remembered by the reporting revisions */
      delete(id: number) {
        const i = find(id)!;
        mutate(i, {}, other);
        i.deleted = true;
        i.deletedAt = iso();
      },
      restore(id: number) {
        const i = find(id)!;
        i.deleted = false;
        mutate(i, {}, other);
      },
      /** A new name for a project: its id stays, every key changes */
      renameProject(from: string, to: string) {
        const p = project(from)!;
        p.name = to;
        for (const i of items.filter((x) => x.project === from)) mutate(i, { "System.TeamProject": to }, other);
      },
      /** The item goes to another project: same id, new key */
      move: (id: number, to: string) => mutate(find(id)!, { "System.TeamProject": project(to)?.name ?? addProject(to).name }, other),
    },
  };
}
