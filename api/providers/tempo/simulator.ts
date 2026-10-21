// Tempo Cloud (API v4) in memory, for tests: the endpoints the adapter calls,
// written from Tempo's documentation (not recorded from a real account), with
// its shapes and traps:
// - Authorization: Bearer <token> or 401; errors are { errors: [{ message }] };
//   the limit answers 429 (Retry-After 30);
// - lists are { metadata: { count, offset, limit, next? }, results }, `next` a full URL; limit tops out at 1000 and more is a 400;
// - a worklog has two ids: tempoWorklogId (every Tempo call) and jiraWorklogId (its mirror in Jira, a different number: using it is a 404);
// - issueId is the Jira issue's numeric id (never the key); an unknown one is a 400;
// - authorAccountId, startDate and timeSpentSeconds are required, startTime is "HH:mm:ss"; startDate/startTime are the user's own zone, with no offset;
//   createdAt/updatedAt are UTC to the second ("…Z"); updatedFrom is to the second too;
// - PUT replaces the worklog: attributes and billableSeconds left out are cleared; billableSeconds may be a part of the time but never more;
// - a required work attribute missing is a 400; a value not in the list is a 400;
// - a worklog in an approved timesheet period can't be created, changed or deleted: a 400 whose message says so;
// - timesheet approvals belong to Tempo Timesheets plans: without them the endpoint answers 403;
// - there is no idempotency key: the same POST twice makes two worklogs; no timers in the API (a running timer is a Jira-side matter that ends as a worklog);
// - the service may keep whole minutes only (roundsToMinutes): the answer says what was kept.
import type { TempoApproval, TempoWorkAttribute, TempoWorklog } from "./client";
import { wallOf } from "./client";
import { timeZone } from "@contracts/values";

export type SimWorklog = {
  tempoWorklogId: number;
  jiraWorklogId: number;
  issueId: number;
  author: string;
  timeSpentSeconds: number;
  billableSeconds: number;
  startDate: string;
  startTime: string;
  description: string;
  created: number;
  updated: number;
  attributes: { key: string; value: string }[];
};
type SimPeriod = { from: string; to: string; status: "OPEN" | "IN_REVIEW" | "APPROVED" };

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

export function tempoSimulator(apiBase = "https://api.tempo.io/4", o: { userZone?: string; roundsToMinutes?: boolean } = {}) {
  const token = "tempo-simulated-token";
  const me = { accountId: "5b10ac8d82e05b22cc7d4ef5", name: "Mario Rossi" };
  const other = { accountId: "712020:ee1a3a29-9d5b", name: "Anna Bianchi" };
  const userZone = timeZone(o.userZone ?? "Europe/Rome");
  const issues = new Map<number, string>();
  const worklogs: SimWorklog[] = [];
  const periods: SimPeriod[] = [];
  const attributes: (TempoWorkAttribute & { required: boolean })[] = [
    { key: "_WorkType_", name: "Work type", type: "STATIC_LIST", required: false, values: ["DEV", "QA", "MEETING"], names: { DEV: "Development", QA: "Testing", MEETING: "Meetings" } },
    { key: "_Ticket_", name: "Ticket", type: "INPUT_FIELD", required: false },
  ];
  let seq = 1000;
  let jiraSeq = 20000;
  // Strictly increasing and never behind the real clock, so "changed since" works with real checkpoints.
  let clock = Date.now();
  const now = () => (clock = Math.max(clock + 1, Date.now()));
  const state = { exhausted: false, calls: 0, revoked: false, approvals: true, roundsToMinutes: o.roundsToMinutes ?? false, maxLimit: 1000 };
  /** Every request seen: method, path and body, for what the tests assert on the wire. */
  const seen: { method: string; path: string; query: string; body: Record<string, unknown> }[] = [];

  const issue = (key: string) => {
    const id = 10000 + issues.size + 1;
    issues.set(id, key);
    return { id, key };
  };

  const add = (
    issueId: number,
    o2: { seconds?: number; date?: string; time?: string; description?: string; author?: string; billable?: number; attributes?: { key: string; value: string }[]; updated?: number } = {},
  ): SimWorklog => {
    const at = o2.updated ?? now();
    const w: SimWorklog = {
      tempoWorklogId: ++seq,
      jiraWorklogId: ++jiraSeq,
      issueId,
      author: o2.author ?? me.accountId,
      timeSpentSeconds: o2.seconds ?? 3600,
      billableSeconds: o2.billable ?? o2.seconds ?? 3600,
      startDate: o2.date ?? "2026-10-14",
      startTime: o2.time ?? "09:00:00",
      description: o2.description ?? "",
      created: at,
      updated: at,
      attributes: o2.attributes ?? [],
    };
    worklogs.push(w);
    return w;
  };

  const shown = (w: SimWorklog): TempoWorklog => ({
    self: `${apiBase}/worklogs/${w.tempoWorklogId}`,
    tempoWorklogId: w.tempoWorklogId,
    jiraWorklogId: w.jiraWorklogId,
    issue: { self: `https://acme.atlassian.net/rest/api/2/issue/${w.issueId}`, id: w.issueId },
    timeSpentSeconds: w.timeSpentSeconds,
    billableSeconds: w.billableSeconds,
    startDate: w.startDate,
    startTime: w.startTime,
    description: w.description,
    createdAt: iso(w.created),
    updatedAt: iso(w.updated),
    author: { self: `https://acme.atlassian.net/rest/api/2/user?accountId=${w.author}`, accountId: w.author },
    attributes: { self: `${apiBase}/worklogs/${w.tempoWorklogId}/work-attribute-values`, values: w.attributes },
  });

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const errors = (...messages: string[]) => json({ errors: messages.map((message) => ({ status: 400, message })) }, 400);

  const locked = (date: string) => periods.some((p) => p.status === "APPROVED" && p.from <= date && date <= p.to);

  /** A page of a list: offset and limit, a full `next` URL while there is more. */
  function listed<T>(url: URL, rows: T[]): Response {
    const limit = url.searchParams.get("limit") === null ? 50 : Number(url.searchParams.get("limit"));
    const offset = url.searchParams.get("offset") === null ? 0 : Number(url.searchParams.get("offset"));
    if (!Number.isInteger(limit) || limit < 1 || limit > state.maxLimit) return errors(`limit must be between 1 and ${state.maxLimit}`);
    if (!Number.isInteger(offset) || offset < 0) return errors("offset is invalid");
    const results = rows.slice(offset, offset + limit);
    const more = offset + limit < rows.length;
    const next = new URL(url);
    next.searchParams.set("offset", String(offset + limit));
    next.searchParams.set("limit", String(limit));
    return json({ self: url.toString(), metadata: { count: results.length, offset, limit, ...(more ? { next: next.toString() } : {}) }, results });
  }

  /** What a body may say, held to the API's rules; the problems in Tempo's words. */
  function problemsOf(b: Record<string, unknown>): string[] {
    const out: string[] = [];
    if (typeof b.authorAccountId !== "string" || !b.authorAccountId) out.push("authorAccountId must not be null");
    if (typeof b.startDate !== "string" || !DATE.test(b.startDate)) out.push("startDate must be a date (yyyy-MM-dd)");
    if (b.startTime !== undefined && (typeof b.startTime !== "string" || !TIME.test(b.startTime))) out.push("startTime must be a time (HH:mm:ss)");
    if (typeof b.timeSpentSeconds !== "number" || !Number.isInteger(b.timeSpentSeconds) || b.timeSpentSeconds < 1) out.push("timeSpentSeconds must be a whole number of seconds, at least 1");
    if (b.billableSeconds !== undefined && (typeof b.billableSeconds !== "number" || b.billableSeconds < 0 || (typeof b.timeSpentSeconds === "number" && b.billableSeconds > b.timeSpentSeconds))) out.push("billableSeconds must be between 0 and timeSpentSeconds");
    if (typeof b.issueId !== "number" || !Number.isInteger(b.issueId)) out.push("issueId must be a number (the Jira issue id)");
    else if (!issues.has(b.issueId)) out.push(`Issue ${b.issueId} not found`);
    const sent = Array.isArray(b.attributes) ? (b.attributes as { key?: unknown; value?: unknown }[]) : [];
    for (const a of sent) {
      const def = attributes.find((x) => x.key === a.key);
      if (!def) out.push(`Work attribute ${String(a.key)} not found`);
      else if (def.type === "STATIC_LIST" && !def.values?.includes(String(a.value))) out.push(`Value ${String(a.value)} is not allowed for work attribute ${def.key}`);
    }
    for (const def of attributes) if (def.required && !sent.some((a) => a.key === def.key)) out.push(`Work attribute ${def.name} is required`);
    return out;
  }

  const kept = (seconds: number) => (state.roundsToMinutes ? Math.max(60, Math.round(seconds / 60) * 60) : seconds);

  async function handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    state.calls++;
    const path = url.pathname.slice(new URL(apiBase).pathname.replace(/\/$/, "").length);
    seen.push({ method, path, query: url.search, body });

    if (state.exhausted) return json({ errors: [{ status: 429, message: "Rate limit exceeded" }] }, 429, { "Retry-After": "30" });
    if (headers.get("authorization") !== `Bearer ${token}` || state.revoked) return json({ errors: [{ status: 401, message: "Invalid access token" }] }, 401);

    if (path === "/work-attributes" && method === "GET") return listed(url, attributes);

    let m = /^\/timesheet-approvals\/user\/([^/]+)$/.exec(path);
    if (m && method === "GET") {
      if (!state.approvals) return json({ errors: [{ status: 403, message: "Timesheet approvals are not part of your Tempo plan" }] }, 403);
      const from = url.searchParams.get("from") ?? "0000-01-01";
      const to = url.searchParams.get("to") ?? "9999-12-31";
      const rows = periods.filter((p) => p.from <= to && p.to >= from).map((p): TempoApproval => ({ self: `${apiBase}/timesheet-approvals/user/${m![1]}?from=${p.from}`, user: { accountId: decodeURIComponent(m![1]) }, period: { from: p.from, to: p.to }, status: { key: p.status } }));
      return listed(url, rows);
    }

    m = /^\/worklogs\/user\/([^/]+)$/.exec(path);
    if (m && method === "GET") {
      const who = decodeURIComponent(m[1]);
      const q = url.searchParams;
      for (const k of ["from", "to"]) if (q.get(k) !== null && !DATE.test(q.get(k)!)) return errors(`${k} must be a date (yyyy-MM-dd)`);
      const updatedFrom = q.get("updatedFrom");
      if (updatedFrom !== null && Number.isNaN(Date.parse(updatedFrom))) return errors("updatedFrom must be a date-time (yyyy-MM-dd'T'HH:mm:ss'Z')");
      const rows = worklogs
        .filter((w) => w.author === who)
        .filter((w) => (!q.get("from") || w.startDate >= q.get("from")!) && (!q.get("to") || w.startDate <= q.get("to")!))
        // To the second: a change within the second of updatedFrom is included.
        .filter((w) => updatedFrom === null || Math.floor(w.updated / 1000) * 1000 >= Date.parse(updatedFrom))
        .sort((a, b) => a.tempoWorklogId - b.tempoWorklogId);
      return listed(url, rows.map(shown));
    }

    if (path === "/worklogs" && method === "POST") {
      const problems = problemsOf(body);
      if (problems.length > 0) return errors(...problems);
      if (locked(String(body.startDate))) return errors(`The worklog can't be created: the timesheet for ${String(body.startDate)} is approved`);
      const seconds = kept(Number(body.timeSpentSeconds));
      const w = add(Number(body.issueId), {
        seconds,
        date: String(body.startDate),
        time: typeof body.startTime === "string" ? body.startTime : "00:00:00",
        description: typeof body.description === "string" ? body.description : "",
        author: String(body.authorAccountId),
        billable: body.billableSeconds === undefined ? 0 : Math.min(Number(body.billableSeconds), seconds),
        attributes: (Array.isArray(body.attributes) ? body.attributes : []) as { key: string; value: string }[],
      });
      return json(shown(w));
    }

    m = /^\/worklogs\/(\d+)$/.exec(path);
    if (m) {
      const w = worklogs.find((x) => x.tempoWorklogId === Number(m[1]));
      if (!w) return json({ errors: [{ status: 404, message: `Worklog ${m[1]} not found` }] }, 404);
      if (method === "GET") return json(shown(w));
      if (locked(w.startDate)) return errors(`The worklog can't be changed: the timesheet for ${w.startDate} is approved`);
      if (method === "DELETE") {
        worklogs.splice(worklogs.indexOf(w), 1);
        return json(null, 204);
      }
      if (method === "PUT") {
        const problems = problemsOf(body);
        if (problems.length > 0) return errors(...problems);
        if (locked(String(body.startDate))) return errors(`The worklog can't be moved into an approved timesheet period (${String(body.startDate)})`);
        // A replace: what the body leaves out is cleared.
        const seconds = kept(Number(body.timeSpentSeconds));
        Object.assign(w, {
          issueId: Number(body.issueId),
          timeSpentSeconds: seconds,
          billableSeconds: body.billableSeconds === undefined ? 0 : Math.min(Number(body.billableSeconds), seconds),
          startDate: String(body.startDate),
          startTime: typeof body.startTime === "string" ? body.startTime : "00:00:00",
          description: typeof body.description === "string" ? body.description : "",
          attributes: (Array.isArray(body.attributes) ? body.attributes : []) as { key: string; value: string }[],
          updated: now(),
        });
        return json(shown(w));
      }
    }
    return json({ errors: [{ status: 404, message: `No such endpoint: ${method} ${path}` }] }, 404);
  }

  /** What happens on the service outside inkledger. */
  const outside = {
    /** The timesheet of a period is approved: its worklogs are locked. */
    approve: (from: string, to: string) => periods.push({ from, to, status: "APPROVED" }),
    /** The timesheet is submitted and waits for approval: still editable. */
    submit: (from: string, to: string) => periods.push({ from, to, status: "IN_REVIEW" }),
    /** Someone changes a worklog in Tempo (its Jira mirror follows). */
    edit(w: SimWorklog, change: { seconds?: number; description?: string }) {
      if (change.seconds !== undefined) w.timeSpentSeconds = change.seconds;
      if (change.description !== undefined) w.description = change.description;
      w.updated = now();
    },
  };

  return {
    apiBase,
    token,
    me,
    other,
    userZone,
    issues,
    worklogs,
    periods,
    attributes,
    state,
    seen,
    issue,
    add,
    outside,
    /** The wall clock the service would show for an instant, in the user's zone. */
    wall: (ms: number) => wallOf(ms, userZone),
    /** Every call from now on is refused as over the limit (429, Retry-After 30). */
    exhaust: () => (state.exhausted = true),
    refill: () => (state.exhausted = false),
    /** The token stops working (401). */
    revoke: () => (state.revoked = true),
    unrevoke: () => (state.revoked = false),
    /** The plan has no timesheet approvals (403). */
    withoutApprovals: () => (state.approvals = false),
    /** A required work attribute: a worklog without it is refused. */
    requireAttribute: (key: string) => {
      const a = attributes.find((x) => x.key === key);
      if (a) a.required = true;
    },
    fetch: handle,
  };
}
