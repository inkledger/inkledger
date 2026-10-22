// Microsoft Planner in memory, for tests: the Graph v1.0 endpoints the adapter
// calls, written from Microsoft's documentation (not recorded from a real
// tenant), with its shapes and traps:
// - a Bearer token or 401 (InvalidAuthenticationToken; an access token lives about an hour);
//   429 with Retry-After; errors as { error: { code, message, innerError } };
// - lists as { value, "@odata.nextLink" }: an absolute link carrying a $skiptoken that expires (400);
// - ids are 28 characters of a case-sensitive alphabet with "_" and "-": a task has no number or key;
// - a task has no modification time and no change filter: only an ETag (@odata.etag) that moves with
//   every change of the task (not of its details);
// - changing a task needs If-Match with its ETag (428 without, 412 when it moved) and, unless asked
//   with Prefer: return=representation, answers 204 with nothing;
// - percentComplete is 0-100 (the apps use 0, 50 and 100); reaching 100 sets completedDateTime,
//   leaving it clears it;
// - a bucket is a column, not a status: it means nothing in itself (its name is free text);
// - priority is 0-10 (0-1 urgent, 2-4 important, 5-7 medium, 8-10 low);
// - a due date picked in the apps is stored as that day at midnight UTC; others are plain instants;
// - labels are category1..category25 on the task, named in the plan's details (unnamed by default);
// - assignees are user ids: names need GET /users/{id} (User.ReadBasic.All, 403 without);
// - the description is in the task's details (its own ETag), not in the task;
// - a deleted task is a 404; a plan the user lost is a 403, and its tasks leave /me/planner/tasks.

type Rec = Record<string, unknown>;
export type SimUser = { id: string; displayName: string; mail: string; userPrincipalName: string };
export type SimBucket = { id: string; name: string };
export type SimPlan = { id: string; title: string; owner: string; access: boolean; buckets: SimBucket[]; categories: Record<string, string> };
export type SimTask = {
  id: string;
  planId: string;
  bucketId: string | null;
  title: string;
  percent: number;
  priority: number;
  start: string | null;
  due: string | null;
  created: number;
  completedAt: number | null;
  createdBy: string;
  assignees: string[];
  categories: string[];
  description: string;
  /** Moves with every change of the task */
  rev: number;
  deleted: boolean;
};

export function plannerSimulator(apiBase = "https://graph.microsoft.com/v1.0", opts: { pageSize?: number } = {}) {
  const token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.simulated.token";
  const me: SimUser = { id: "4b2f6a1e-9c3d-4e75-8a10-6f0c2d7b5e31", displayName: "Mario Rossi", mail: "mario@acme.example", userPrincipalName: "mario@acme.onmicrosoft.com" };
  const anna = "7d9e0b44-1a52-4c8f-b6e3-2f4a8c9d1e07";
  const users = new Map<string, SimUser>([
    [me.id, me],
    [anna, { id: anna, displayName: "Anna Bianchi", mail: "anna@acme.example", userPrincipalName: "anna@acme.onmicrosoft.com" }],
  ]);
  const plans = new Map<string, SimPlan>();
  const tasks: SimTask[] = [];
  const pageSize = opts.pageSize ?? 100;
  let seq = 0;
  // Mixed case, "_" and "-", and ending in a digit (the conformance suite rewrites a trailing number to make an unknown key).
  const nextId = (kind: string) => `${kind}Ee_Qw-Xr7Kd${String(++seq).padStart(15, "0")}`;
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  let past = Date.now() - 3 * 3_600_000;
  const earlier = () => (past += 1000);
  const iso = (ms: number) => new Date(ms).toISOString();
  const state = { exhausted: false, expired: false, revoked: false, calls: 0, epoch: 0, hideUsers: false, raceNext: false, nextLinkOrigin: null as string | null, noRepresentation: 0 };
  /** Every request, "METHOD path", for tests that count calls. */
  const log: string[] = [];

  // ---------- Data ----------

  const plan = (title: string, o: { buckets?: string[]; access?: boolean; categories?: Record<string, string> } = {}): SimPlan => {
    const known = [...plans.values()].find((p) => p.title === title);
    if (known) {
      if (o.access !== undefined) known.access = o.access;
      return known;
    }
    const p: SimPlan = { id: nextId("Pl"), title, owner: "8c1d5e90-3b6a-4f2e-9d47-0a5b7c3e8f12", access: o.access ?? true, buckets: (o.buckets ?? []).map((name) => ({ id: nextId("Bk"), name })), categories: o.categories ?? {} };
    plans.set(p.id, p);
    return p;
  };
  const bucketOf = (p: SimPlan, name: string) => p.buckets.find((b) => b.name === name);
  const addUser = (displayName: string) => {
    const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
    users.set(id, { id, displayName, mail: `${displayName.split(" ")[0].toLowerCase()}@acme.example`, userPrincipalName: `${displayName.split(" ")[0].toLowerCase()}@acme.onmicrosoft.com` });
    return id;
  };

  const add = (
    title: string,
    o: { plan?: SimPlan; bucket?: string; assignees?: string[]; description?: string; due?: string; start?: string; priority?: number; categories?: string[]; percent?: number; author?: string } = {},
  ): SimTask => {
    const p = o.plan ?? plan("Website", { buckets: ["To do", "Doing", "Done"] });
    const at = earlier();
    const t: SimTask = {
      id: nextId("Tk"),
      planId: p.id,
      bucketId: (o.bucket && bucketOf(p, o.bucket)?.id) || p.buckets[0]?.id || null,
      title,
      percent: o.percent ?? 0,
      priority: o.priority ?? 5,
      start: o.start ?? null,
      due: o.due ?? null,
      created: at,
      completedAt: (o.percent ?? 0) >= 100 ? at : null,
      createdBy: o.author ?? me.id,
      assignees: o.assignees ?? [me.id],
      categories: o.categories ?? [],
      description: o.description ?? "",
      rev: 1,
      deleted: false,
    };
    tasks.push(t);
    return t;
  };
  const keyOf = (t: SimTask) => `PLANNER-${t.id}`;
  const taskById = (id: string) => tasks.find((t) => t.id === id && !t.deleted);
  const touch = (t: SimTask) => void (t.rev += 1);

  /** What happens elsewhere (the web UI, a teammate), for tests of a pass that finds it later. */
  const setPercent = (t: SimTask, percent: number) => {
    t.percent = percent;
    t.completedAt = percent >= 100 ? now() : null;
    touch(t);
  };
  const outside = {
    retitle(t: SimTask, title: string) {
      t.title = title;
      touch(t);
    },
    setPercent,
    moveToBucket(t: SimTask, name: string) {
      const b = bucketOf(plans.get(t.planId)!, name);
      if (!b) throw new Error(`no bucket ${name}`);
      t.bucketId = b.id;
      touch(t);
    },
    assign(t: SimTask, user: string) {
      if (!t.assignees.includes(user)) t.assignees.push(user);
      touch(t);
    },
    unassign(t: SimTask, user: string) {
      t.assignees = t.assignees.filter((u) => u !== user);
      touch(t);
    },
    due(t: SimTask, due: string | null) {
      t.due = due;
      touch(t);
    },
    describe(t: SimTask, text: string) {
      t.description = text;
    },
    /** Gone for good: a 404 from now on. */
    delete(t: SimTask) {
      t.deleted = true;
    },
    renameBucket(p: SimPlan, from: string, to: string) {
      const b = bucketOf(p, from);
      if (b) b.name = to;
    },
    /** The user loses (or regains) a plan: 403 for it and every task in it. */
    access(p: SimPlan, on: boolean) {
      p.access = on;
    },
  };

  // ---------- Shapes ----------

  const etag = (rev: number, id: string) => `W/"${Buffer.from(`1-Task  @@@${id}@@@${rev}`).toString("base64")}"`;
  const taskRec = (t: SimTask): Rec => ({
    "@odata.etag": etag(t.rev, t.id),
    id: t.id,
    planId: t.planId,
    bucketId: t.bucketId,
    title: t.title,
    orderHint: "8585262810526474337",
    assigneePriority: "",
    percentComplete: t.percent,
    priority: t.priority,
    startDateTime: t.start,
    createdDateTime: iso(t.created),
    dueDateTime: t.due,
    hasDescription: t.description !== "",
    previewType: "automatic",
    completedDateTime: t.completedAt === null ? null : iso(t.completedAt),
    referenceCount: 0,
    checklistItemCount: 0,
    activeChecklistItemCount: 0,
    createdBy: { user: { displayName: null, id: t.createdBy } },
    appliedCategories: Object.fromEntries(t.categories.map((c) => [c, true])),
    assignments: Object.fromEntries(t.assignees.map((u) => [u, { "@odata.type": "#microsoft.graph.plannerAssignment", assignedDateTime: iso(t.created), orderHint: "8585262810526474337!", assignedBy: { user: { displayName: null, id: t.createdBy } } }])),
  });
  const userRec = (u: SimUser): Rec => ({ "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users/$entity", id: u.id, displayName: u.displayName, mail: u.mail, userPrincipalName: u.userPrincipalName });

  // ---------- HTTP ----------

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
    json({ error: { code, message, innerError: { date: new Date().toISOString(), "request-id": "11111111-2222-4333-8444-555555555555" } } }, status, headers);
  const unknown = (what: string, id: string) => fail(404, "NotFound", `${what} '${id}' was not found.`);

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = (typeof init?.body === "string" ? JSON.parse(init.body) : {}) as Rec;
    const apiPath = new URL(apiBase).pathname.replace(/\/$/, "");
    state.calls++;
    log.push(`${method} ${url.pathname.slice(apiPath.length)}`);

    if (state.expired) return fail(401, "InvalidAuthenticationToken", "Lifetime validation failed, the token is expired.");
    if (headers.get("authorization") !== `Bearer ${token}` || state.revoked) return fail(401, "InvalidAuthenticationToken", "Access token validation failure. Invalid audience.");
    if (state.exhausted) return fail(429, "TooManyRequests", "Application is over its throttling limit.", { "Retry-After": "30" });
    const path = url.pathname.slice(apiPath.length);
    const q = url.searchParams;

    /** A list: { value, @odata.nextLink } with a skip token good for its own path and epoch. */
    const paged = (list: Rec[]): Response => {
      let from = 0;
      const skip = q.get("$skiptoken");
      if (skip) {
        try {
          const o = JSON.parse(Buffer.from(skip, "base64url").toString()) as { from: number; path: string; epoch: number };
          if (o.epoch !== state.epoch || o.path !== path) return fail(400, "BadRequest", "Invalid $skiptoken value.");
          from = o.from;
        } catch {
          return fail(400, "BadRequest", "Invalid $skiptoken value.");
        }
      }
      const end = Math.min(list.length, from + pageSize);
      const out: Rec = { "@odata.context": `${apiBase}/$metadata#Collection`, value: list.slice(from, end) };
      if (end < list.length) {
        const next = Buffer.from(JSON.stringify({ from: end, path, epoch: state.epoch })).toString("base64url");
        out["@odata.nextLink"] = `${state.nextLinkOrigin ?? new URL(apiBase).origin}${apiPath}${path}?$skiptoken=${next}`;
      }
      return json(out);
    };

    if (path === "/me") return json(userRec(me));

    const user = /^\/users\/([^/]+)$/.exec(path);
    if (user) {
      if (state.hideUsers) return fail(403, "Authorization_RequestDenied", "Insufficient privileges to complete the operation.");
      const u = users.get(decodeURIComponent(user[1]));
      return u ? json(userRec(u)) : unknown("User", user[1]);
    }

    if (path === "/me/planner/tasks") {
      const mine = tasks.filter((t) => !t.deleted && t.assignees.includes(me.id) && plans.get(t.planId)?.access).sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
      return paged(mine.map(taskRec));
    }
    if (path === "/me/planner/plans") return paged([...plans.values()].filter((p) => p.access).map((p) => ({ id: p.id, title: p.title, owner: p.owner })));

    let m = /^\/planner\/tasks\/([^/]+)(?:\/(details))?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const t = taskById(id);
      if (!t) return unknown("Task", id);
      if (!plans.get(t.planId)?.access) return fail(403, "Forbidden", "You do not have access to this plan.");
      if (m[2]) return json({ "@odata.etag": `W/"details-${t.id}"`, id: t.id, description: t.description, previewType: "automatic", references: {}, checklist: {} });
      if (method === "PATCH") {
        if (!headers.get("if-match")) return fail(428, "PreconditionRequired", "The If-Match header is required for this operation.");
        if (state.raceNext) {
          state.raceNext = false;
          touch(t);
        }
        if (headers.get("if-match") !== etag(t.rev, t.id)) return fail(412, "PreconditionFailed", "The request cannot be completed because the resource has been modified since it was last read.");
        if (body.percentComplete !== undefined) {
          const p = body.percentComplete;
          if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 100) return fail(400, "BadRequest", "percentComplete must be an integer between 0 and 100.");
          setPercent(t, p);
        }
        if (typeof body.bucketId === "string") {
          if (!plans.get(t.planId)?.buckets.some((b) => b.id === body.bucketId)) return fail(400, "BadRequest", "The bucket does not belong to the plan of the task.");
          t.bucketId = body.bucketId;
        }
        if (typeof body.title === "string") t.title = body.title;
        touch(t);
        if (headers.get("prefer")?.includes("return=representation") && state.noRepresentation === 0) return json(taskRec(t));
        if (state.noRepresentation > 0) state.noRepresentation--;
        return new Response(null, { status: 204 });
      }
      return json(taskRec(t));
    }

    m = /^\/planner\/plans\/([^/]+)(?:\/(buckets|details))?$/.exec(path);
    if (m) {
      const p = plans.get(decodeURIComponent(m[1]));
      if (!p) return unknown("Plan", m[1]);
      if (!p.access) return fail(403, "Forbidden", "You do not have access to this plan.");
      if (m[2] === "buckets") return paged(p.buckets.map((b) => ({ id: b.id, name: b.name, planId: p.id, orderHint: "8585262810526474337!" })));
      if (m[2] === "details") return json({ "@odata.etag": `W/"plan-details-${p.id}"`, id: p.id, categoryDescriptions: Object.fromEntries(Array.from({ length: 25 }, (_, n) => [`category${n + 1}`, p.categories[`category${n + 1}`] ?? null])) });
      return json({ id: p.id, title: p.title, owner: p.owner, createdDateTime: iso(past), container: { containerId: p.owner, type: "group" } });
    }

    return fail(404, "NotFound", `unmocked ${method} ${path}`);
  }

  const sim = {
    fetch: handle,
    apiBase,
    token,
    me,
    anna,
    users,
    plans,
    tasks,
    state,
    log,
    plan,
    add,
    addUser,
    keyOf,
    outside,
    /** The bucket id of a name in a plan. */
    bucket: (p: SimPlan, name: string) => bucketOf(p, name)?.id,
    /** The next skip tokens stop being good (a pass left waiting). */
    expirePaging: () => void (state.epoch += 1),
    etagOf: (t: SimTask) => etag(t.rev, t.id),
  };
  return sim;
}
