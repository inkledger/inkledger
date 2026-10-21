// An Everhour in memory, for tests: the endpoints the sink calls, written from
// Everhour's API documentation (not recorded from a real account), with its
// shapes and traps:
// - X-Api-Key or 401; a plan without API access answers 403;
// - 20 requests per 10 seconds per key (opt-in here), 429 with Retry-After;
// - one record per user, day and task: PUT /tasks/{id}/time replaces the day's
//   time, POST adds to it, PUT with 0 removes the record;
// - time is whole seconds (a fraction, a negative or more than a day is a 400),
//   the date a plain day (an instant with a time is a 400): no zone anywhere;
// - a task has to exist (an integration's task, "ji:10001"): 404 otherwise;
// - a locked period (approved time, a locked timesheet) answers 403 "locked";
// - a running timer adds its time to its start day when it stops, on top of
//   whatever was set meanwhile; GET /timers/current says which is running;
// - lists are paged by page/limit and the service caps limit below what the
//   client may ask; there is no idempotency key (a lost answer may have landed).
import type { EverhourTaskRef, EverhourTimeRecord, EverhourTimer, EverhourUser } from "./client";

type SimRecord = { date: string; time: number; user: number; task: string; comment: string | null; history: { id: number; time: number; previousTime: number; createdAt: string }[] };
type SimTimer = { task: string; startedAt: number; user: number };

const isDay = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};

export function everhourSimulator(apiBase = "https://api.everhour.com", me: EverhourUser = { id: 4711, name: "Mario Rossi", email: "mario@example.com", headline: "Dev", role: "member", status: "active" }) {
  const key = "ev-simulated-key";
  const tasks = new Map<string, EverhourTaskRef>();
  const records = new Map<string, SimRecord>();
  const state = {
    exhausted: false,
    revoked: false,
    /** A plan without API access */
    noApi: false,
    calls: 0,
    /** The most `limit` the service honours */
    pageCap: 250,
    /** Requests per 10 seconds before a 429 (0: not enforced) */
    burst: 0,
    /** Time through this day is locked (null: none) */
    lockedThrough: null as string | null,
    /** The answer of the next write is lost after the write is applied */
    loseNext: false,
    timer: null as SimTimer | null,
    seen: [] as number[],
  };
  let seq = 0;

  const recKey = (task: string, date: string, user: number) => `${user}|${task}|${date}`;
  const locked = (date: string) => state.lockedThrough !== null && date <= state.lockedThrough;
  const record = (r: SimRecord): EverhourTimeRecord => ({
    date: r.date,
    time: r.time,
    user: r.user,
    task: tasks.get(r.task),
    comment: r.comment,
    history: r.history,
    ...(locked(r.date) ? { locked: true } : {}),
  });

  const task = (id: string, name: string, extra: Partial<EverhourTaskRef> = {}) => {
    const t: EverhourTaskRef = { id, name, ...extra };
    tasks.set(id, t);
    return t;
  };
  /** Time already on the account before the test began. */
  const put = (taskId: string, date: string, time: number, o: { user?: number; comment?: string | null } = {}) => {
    const user = o.user ?? me.id;
    const k = recKey(taskId, date, user);
    const before = records.get(k);
    const r: SimRecord = { date, time, user, task: taskId, comment: o.comment ?? before?.comment ?? null, history: [...(before?.history ?? []), { id: ++seq, time, previousTime: before?.time ?? 0, createdAt: new Date().toISOString() }] };
    if (time === 0) records.delete(k);
    else records.set(k, r);
    return r;
  };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const fail = (status: number, message: string, headers: Record<string, string> = {}) => json({ code: status, message }, status, headers);

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        return fail(400, "Invalid JSON");
      }
    }
    state.calls++;

    if (headers.get("x-api-key") !== key || state.revoked) return fail(401, "Invalid API key");
    if (state.exhausted) return fail(429, "Too many requests", { "Retry-After": "10" });
    if (state.burst > 0) {
      const now = Date.now();
      state.seen = state.seen.filter((t) => now - t < 10_000);
      if (state.seen.length >= state.burst) return fail(429, "Too many requests", { "Retry-After": String(Math.max(1, Math.ceil((10_000 - (now - state.seen[0])) / 1000))) });
      state.seen.push(now);
    }
    if (state.noApi) return fail(403, "API is not available on your plan");

    const path = url.pathname;
    if (method === "GET" && path === "/users/me") return json(me);

    if (method === "GET" && path === "/timers/current") {
      const t = state.timer;
      if (!t) return json({ status: "stopped" } satisfies EverhourTimer);
      return json({ status: "active", duration: Math.floor((Date.now() - t.startedAt) / 1000), startedAt: new Date(t.startedAt).toISOString(), task: tasks.get(t.task), user: { id: t.user } } satisfies EverhourTimer);
    }

    if (method === "GET" && path === "/users/me/time") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!isDay(from) || !isDay(to)) return fail(400, "from and to must be dates (YYYY-MM-DD)");
      const limit = Math.min(state.pageCap, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const all = [...records.values()].filter((r) => r.user === me.id && r.date >= from && r.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.task.localeCompare(b.task));
      return json(all.slice((page - 1) * limit, page * limit).map(record));
    }

    const m = /^\/tasks\/([^/]+)\/time$/.exec(path);
    if (m && (method === "PUT" || method === "POST")) {
      const taskId = decodeURIComponent(m[1]);
      const { time, date } = body;
      if (!isDay(date)) return fail(400, "date must be a date (YYYY-MM-DD)");
      // Seconds: a fraction, a negative, or more than a day is refused.
      if (typeof time !== "number" || !Number.isInteger(time) || time < 0 || time > 86_400) return fail(400, "time must be a whole number of seconds, at most 24 hours");
      if (!tasks.has(taskId)) return fail(404, "Task not found");
      if (locked(date)) return fail(403, "Time is locked for this period");
      const user = typeof body.user === "number" ? body.user : me.id;
      const before = records.get(recKey(taskId, date, user));
      // POST adds to what is there, PUT replaces it.
      const next = method === "POST" ? (before?.time ?? 0) + time : time;
      if (next > 86_400) return fail(400, "time must be at most 24 hours a day");
      const r = put(taskId, date, next, { user, comment: typeof body.comment === "string" ? body.comment : null });
      if (state.loseNext) {
        state.loseNext = false;
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      return json(record(r));
    }

    return fail(404, `No ${method} ${path}`);
  }

  return {
    apiBase,
    key,
    me,
    tasks,
    records,
    state,
    task,
    put,
    /** The user's records, as stored. */
    mine: () => [...records.values()].filter((r) => r.user === me.id),
    /** Time of another person on the team (never listed under /users/me). */
    other: (taskId: string, date: string, time: number) => put(taskId, date, time, { user: me.id + 1 }),
    /** Time through this day is locked (approved or in a locked timesheet). */
    lock: (through: string | null) => (state.lockedThrough = through),
    /** A timer starts on a task (at an instant, ms). */
    startTimer: (taskId: string, at = Date.now()) => (state.timer = { task: taskId, startedAt: at, user: me.id }),
    /** The timer stops: its time is added to its start day. */
    stopTimer: (now = Date.now()) => {
      const t = state.timer;
      if (!t) return;
      state.timer = null;
      const date = new Date(t.startedAt).toISOString().slice(0, 10);
      const before = records.get(recKey(t.task, date, t.user));
      put(t.task, date, (before?.time ?? 0) + Math.floor((now - t.startedAt) / 1000), { user: t.user });
    },
    /** Every call from now on is refused as over the limit (429, Retry-After 10). */
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** Enforce the documented 20 requests per 10 seconds. */
    burstLimit: (n = 20) => (state.burst = n),
    /** The key stops working (401). */
    revoke: () => (state.revoked = true),
    /** The plan has no API access (403). */
    withoutApi: () => (state.noApi = true),
    /** The next write lands but its answer never arrives. */
    loseNextAnswer: () => (state.loseNext = true),
    fetch: handle,
  };
}
