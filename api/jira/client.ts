import type { JiraCredentials } from "@contracts/types";
import { originate, originOf } from "../providers/core/origin";
import { safeFetch, type Intent } from "../providers/core/http";
import { t } from "@contracts/i18n";

/**
 * Typed client for the Jira REST API.
 * Supports Jira Cloud (REST API v3) and Jira Server / Data Center 8.x (REST API v2),
 * including Jira Server 8.21.
 */

export class JiraApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
  }
}

/** Upper bound for a single Jira HTTP call. */
export const JIRA_TIMEOUT_MS = 15_000;

/**
 * True when Jira could not be reached at all (DNS, connection, timeout),
 * as opposed to a JiraApiError where Jira answered with an error status.
 */
export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  // undici: TypeError("fetch failed") with the socket error as cause. Any other
  // TypeError is a bug and must surface, not be queued as "offline".
  if (!(e instanceof TypeError)) return false;
  if (e.message === "fetch failed") return true;
  const code = (e.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && NETWORK_CODES.test(code);
}

const NETWORK_CODES = /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_\w+)$/;

/** Jira issue key, e.g. "PRJ-123". */
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

function normalizeSiteUrl(siteUrl: string): string {
  return siteUrl.replace(/\/+$/, "");
}

function authHeader(creds: JiraCredentials): string {
  if (creds.authType === "bearer") {
    return `Bearer ${creds.secret}`;
  }
  return (
    "Basic " +
    Buffer.from(`${creds.username}:${creds.secret}`).toString("base64")
  );
}

function apiBase(creds: JiraCredentials): string {
  return creds.deployment === "server" ? "/rest/api/2" : "/rest/api/3";
}

/** The safe fetch (core/http) with Jira's site and errors. */
function siteFetch(creds: JiraCredentials, url: string, init: RequestInit, opts: { intent?: Intent; allowCrossOrigin?: boolean } = {}) {
  return safeFetch({
    site: normalizeSiteUrl(creds.siteUrl),
    url,
    init,
    ...opts,
    fail: (status, message) => new JiraApiError(status, message),
    // Jira Server/DC lives on the company network; Jira Cloud on the internet.
    network: creds.deployment === "server" ? "private" : "public",
  });
}

async function jiraFetch<T>(
  creds: JiraCredentials,
  path: string,
  init: RequestInit = {},
  /** Only for a POST that reads (core/http.ts): GET and HEAD read, the rest writes. */
  intent?: Intent,
): Promise<T> {
  try {
    return await jiraCall<T>(creds, path, init, intent);
  } catch (e) {
    // A refusal names the connection whose credentials were used.
    const from = originOf(creds);
    throw e instanceof Error && from !== undefined ? originate(e, from) : e;
  }
}

async function jiraCall<T>(creds: JiraCredentials, path: string, init: RequestInit, intent?: Intent): Promise<T> {
  const url = `${normalizeSiteUrl(creds.siteUrl)}${path}`;
  const res = await siteFetch(creds, url, {
    signal: AbortSignal.timeout(JIRA_TIMEOUT_MS),
    ...init,
    headers: {
      Authorization: authHeader(creds),
      Accept: "application/json",
      // FormData bodies get their multipart boundary from fetch itself
      ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  }, { intent });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as {
        errorMessages?: string[];
        errors?: Record<string, string>;
      };
      const msgs = [
        ...(body.errorMessages ?? []),
        ...Object.values(body.errors ?? {}),
      ];
      if (msgs.length > 0) detail = msgs.join("; ");
    } catch {
      /* keep statusText */
    }
    throw new JiraApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------- Types ----------

export type JiraMyself = {
  /** Cloud only */
  accountId?: string;
  /** Server/DC only */
  name?: string;
  key?: string;
  emailAddress?: string;
  displayName: string;
  avatarUrls?: { "48x48"?: string };
};

export type JiraSearchedIssue = {
  id: string;
  key: string;
  fields: {
    summary: string;
    status?: { name?: string; statusCategory?: { key?: string; name?: string } };
    project?: { id?: string; key?: string; name?: string; avatarUrls?: Record<string, string> };
    issuetype?: { name?: string };
    priority?: { name?: string };
    labels?: string[];
    assignee?: { accountId?: string; name?: string; displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    timeestimate?: number | null;
    timespent?: number | null;
    duedate?: string | null;
    updated?: string;
    created?: string;
    /** Missing on older Jira Server versions */
    statuscategorychangedate?: string | null;
    comment?: {
      comments?: {
        created?: string;
        author?: { accountId?: string; name?: string; key?: string };
      }[];
    };
  };
  /** Present with expand=changelog */
  changelog?: {
    histories?: {
      created?: string;
      author?: { accountId?: string; name?: string; key?: string };
      items?: { field?: string }[];
    }[];
  };
};

export type JiraWorklog = {
  id: string;
  /** Present in /worklog/list answers (not in an issue's worklog list) */
  issueId?: string;
  timeSpentSeconds: number;
  started: string;
  comment?: unknown;
  author?: { accountId?: string; name?: string; key?: string; displayName?: string };
  created?: string;
  updated?: string;
};

// ---------- Status categories ----------

/**
 * Canonical status category ("To Do" | "In Progress" | "Done").
 * Jira localizes the category *name* (e.g. "Completato" on an Italian
 * server); the *key* (new / indeterminate / done) is language-independent.
 */
export function canonicalCategory(cat?: { key?: string; name?: string }): string {
  switch (cat?.key) {
    case "new":
      return "To Do";
    case "indeterminate":
      return "In Progress";
    case "done":
      return "Done";
    default:
      return cat?.name ?? "";
  }
}

// ---------- Comment helpers ----------

/**
 * Cloud worklog comments use Atlassian Document Format (ADF);
 * Server/DC 8.x expects a plain-text string.
 */
export function adfFromText(text: string) {
  const paragraphs = text.split(/\n+/).filter((l) => l.trim().length > 0);
  return {
    type: "doc",
    version: 1,
    content:
      paragraphs.length > 0
        ? paragraphs.map((line) => ({
            type: "paragraph",
            content: [{ type: "text", text: line }],
          }))
        : [{ type: "paragraph", content: [] }],
  };
}

/**
 * Plain text of an ADF document (Cloud). Links become Jira wiki markup
 * ("[text|url]", smart links "[url]") so the app renders Cloud and Server
 * text the same way.
 */
export function textFromAdf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textFromAdf).join("");
  if (typeof node === "object") {
    const n = node as {
      type?: string;
      text?: string;
      content?: unknown;
      marks?: { type?: string; attrs?: { href?: unknown } }[];
      attrs?: { url?: unknown };
    };
    if (n.type === "text") {
      const text = n.text ?? "";
      const href = n.marks?.find((m) => m.type === "link")?.attrs?.href;
      if (typeof href !== "string" || !href) return text;
      return text === href ? `[${href}]` : `[${text.replace(/[[\]|]/g, " ")}|${href}]`;
    }
    if (n.type === "inlineCard" || n.type === "blockCard" || n.type === "embedCard") {
      const url = n.attrs?.url;
      return typeof url === "string" && url ? `[${url}]` + (n.type === "inlineCard" ? "" : "\n") : "";
    }
    const inner = textFromAdf(n.content);
    if (n.type === "paragraph" || n.type === "heading") return inner + "\n";
    if (n.type === "hardBreak") return "\n";
    return inner;
  }
  return "";
}

function encodeComment(creds: JiraCredentials, text: string): unknown {
  return creds.deployment === "server" ? text : adfFromText(text);
}

// ---------- API calls ----------

export async function getMyself(creds: JiraCredentials): Promise<JiraMyself> {
  return jiraFetch<JiraMyself>(creds, `${apiBase(creds)}/myself`);
}

const ISSUE_FIELDS =
  "summary,status,project,issuetype,priority,labels,assignee,reporter,timeestimate,timespent,duedate,updated,created,statuscategorychangedate";

/** Generic JQL search with automatic pagination. */
export async function searchIssues(
  creds: JiraCredentials,
  jql: string,
  maxTotal = 500,
  fields: string = ISSUE_FIELDS,
  expand?: string,
): Promise<JiraSearchedIssue[]> {
  if (creds.deployment === "server") {
    const out: JiraSearchedIssue[] = [];
    const pageSize = 100;
    let startAt = 0;
    let total = Infinity;
    while (startAt < total && out.length < maxTotal) {
      const params = new URLSearchParams({
        jql,
        fields,
        maxResults: String(pageSize),
        startAt: String(startAt),
      });
      if (expand) params.set("expand", expand);
      const page = await jiraFetch<{
        issues?: JiraSearchedIssue[];
        total?: number;
      }>(creds, `${apiBase(creds)}/search?${params.toString()}`);
      out.push(...(page.issues ?? []));
      total = page.total ?? out.length;
      // Jira may cap maxResults below pageSize: advance by what was returned.
      const got = (page.issues ?? []).length;
      if (got === 0) break;
      startAt += got;
    }
    return out.slice(0, maxTotal);
  }

  const out: JiraSearchedIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      jql,
      fields,
      maxResults: "100",
    });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    if (expand) params.set("expand", expand);
    const page = await jiraFetch<{
      issues?: JiraSearchedIssue[];
      nextPageToken?: string;
      isLast?: boolean;
    }>(creds, `${apiBase(creds)}/search/jql?${params.toString()}`);
    out.push(...(page.issues ?? []));
    nextPageToken = page.isLast === false ? page.nextPageToken : undefined;
  } while (nextPageToken && out.length < maxTotal);
  return out.slice(0, maxTotal);
}

/** Jira timestamps ("…+0200", "…Z") as epoch ms; null when missing/invalid. */
export function parseJiraDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export type IssueActivity = {
  lastCommentAt: number | null;
  statusChangedAt: number | null;
  /** Same two, by someone other than the user (drives "unread") */
  othersCommentAt: number | null;
  othersStatusChangedAt: number | null;
};

type JiraAuthor = { accountId?: string; name?: string; key?: string } | undefined;

/** Author is the given user (Cloud: accountId, Server/DC: name or key). */
export function isAuthor(author: JiraAuthor, me: string): boolean {
  return !!author && (author.accountId === me || author.name === me || author.key === me);
}

/**
 * Latest comment and latest status change of the open assigned issues, from
 * comments and the changelog: by anyone (ordering) and by others than `me`
 * (unread). Kept to open issues: both are heavy and done work is quiet.
 */
export async function fetchOpenIssueActivity(
  creds: JiraCredentials,
  me: string,
  /** Incremental sync: only issues updated in the last N minutes */
  updatedWithinMin?: number,
): Promise<Map<string, IssueActivity>> {
  const open = await searchIssues(
    creds,
    `assignee = currentUser() AND statusCategory != done${updatedWithinMin ? ` AND ${updatedWindow(updatedWithinMin)}` : ""}`,
    1000,
    "comment",
    "changelog",
  );
  const latest = (dates: (string | undefined)[]) =>
    dates.reduce<number | null>((best, d) => {
      const at = parseJiraDate(d);
      return at !== null && (best === null || at > best) ? at : best;
    }, null);
  const out = new Map<string, IssueActivity>();
  for (const i of open) {
    const comments = i.fields.comment?.comments ?? [];
    const statusChanges = (i.changelog?.histories ?? []).filter((h) =>
      (h.items ?? []).some((it) => it.field === "status"),
    );
    out.set(i.key, {
      lastCommentAt: latest(comments.map((c) => c.created)),
      statusChangedAt: latest(statusChanges.map((h) => h.created)),
      othersCommentAt: latest(
        comments.filter((c) => !isAuthor(c.author, me)).map((c) => c.created),
      ),
      othersStatusChangedAt: latest(
        statusChanges.filter((h) => !isAuthor(h.author, me)).map((h) => h.created),
      ),
    });
  }
  return out;
}

/** JQL clause: issues updated in the last `minutes` minutes. */
export function updatedWindow(minutes: number): string {
  return `updated >= "-${Math.max(1, Math.floor(minutes))}m"`;
}

/**
 * Incremental sync: issues assigned to me now or in the past, updated in the
 * last `minutes` minutes (reassignments away from me included).
 */
/** Which issues are "mine" on a connection: assigned to me, or also the ones I reported. */
export type JiraMine = "assigned" | "involved";

const mineJql = (mine: JiraMine) => (mine === "involved" ? "(assignee = currentUser() OR reporter = currentUser())" : "assignee = currentUser()");

export async function fetchRecentlyAssignedIssues(
  creds: JiraCredentials,
  minutes: number,
  mine: JiraMine = "assigned",
): Promise<JiraSearchedIssue[]> {
  const was = mine === "involved" ? "assignee = currentUser() OR assignee was currentUser() OR reporter = currentUser()" : "assignee = currentUser() OR assignee was currentUser()";
  return searchIssues(creds, `(${was}) AND ${updatedWindow(minutes)} ORDER BY updated DESC`, 10000);
}

/** Issues the current user watches (full sync only). */
export async function fetchWatchedIssues(creds: JiraCredentials): Promise<JiraSearchedIssue[]> {
  return searchIssues(creds, "watcher = currentUser() ORDER BY updated DESC", 10000);
}

/** Fetch all issues assigned to the current user (paginates automatically). */
export async function fetchAssignedIssues(
  creds: JiraCredentials,
  mine: JiraMine = "assigned",
): Promise<JiraSearchedIssue[]> {
  return searchIssues(creds, `${mineJql(mine)} ORDER BY updated DESC`, 10000);
}

/**
 * Fetch a single issue by key (null when missing or not visible). A JQL
 * `key = X` search fails with 400 for unknown keys, hence the direct GET.
 */
export async function fetchIssueByKey(
  creds: JiraCredentials,
  key: string,
): Promise<JiraSearchedIssue | null> {
  if (!ISSUE_KEY_RE.test(key)) return null;
  try {
    return await jiraFetch<JiraSearchedIssue>(
      creds,
      `${apiBase(creds)}/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`,
    );
  } catch (e) {
    if (e instanceof JiraApiError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

/** A field's value as text: options by value or name, people by name, lists joined; objects without a readable part left out. */
function fieldText(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(fieldText).filter((x): x is string => !!x);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["value", "name", "displayName", "key"]) {
      const part = o[k];
      if (typeof part === "string" && part) return part;
    }
  }
  return null;
}

/** The issue's custom fields with a value, by the site's names (read-only, on demand). */
export async function fetchOtherFields(creds: JiraCredentials, key: string): Promise<{ name: string; value: string }[]> {
  if (!ISSUE_KEY_RE.test(key)) return [];
  const data = await jiraFetch<{ fields?: Record<string, unknown>; names?: Record<string, string> }>(
    creds,
    `${apiBase(creds)}/issue/${encodeURIComponent(key)}?fields=*all&expand=names`,
  );
  return Object.entries(data.fields ?? {})
    .filter(([id]) => id.startsWith("customfield_"))
    .flatMap(([id, v]) => {
      const value = fieldText(v);
      // Rich text (ADF) and the like have no one-line form here.
      return value ? [{ name: data.names?.[id] ?? id, value: value.length > 500 ? `${value.slice(0, 500)}…` : value }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A field a transition's screen shows (expand=transitions.fields). */
export type JiraTransitionField = {
  required: boolean;
  name?: string;
  schema?: { type?: string; items?: string; system?: string; custom?: string };
  allowedValues?: { id: string; name?: string; value?: string }[];
};

export type JiraTransition = {
  id: string;
  name: string;
  to?: { name?: string; statusCategory?: { key?: string; name?: string } };
  /** Present with expand=transitions.fields. On Server hasScreen is absent: only `required` counts. */
  fields?: Record<string, JiraTransitionField>;
};

/** The site's priorities, in Jira's own order (highest first). */
export async function fetchPriorities(creds: JiraCredentials): Promise<{ id: string; name: string }[]> {
  return jiraFetch<{ id: string; name: string }[]>(creds, `${apiBase(creds)}/priority`);
}

export async function fetchTransitions(
  creds: JiraCredentials,
  issueKey: string,
  opts: { fields?: boolean } = {},
): Promise<JiraTransition[]> {
  const res = await jiraFetch<{ transitions?: JiraTransition[] }>(
    creds,
    `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}/transitions${opts.fields ? "?expand=transitions.fields" : ""}`,
  );
  return res.transitions ?? [];
}

export async function doTransition(
  creds: JiraCredentials,
  issueKey: string,
  transitionId: string,
  fields?: Record<string, unknown>,
): Promise<void> {
  await jiraFetch<void>(
    creds,
    `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}/transitions`,
    { method: "POST", body: JSON.stringify({ transition: { id: transitionId }, ...(fields && Object.keys(fields).length ? { fields } : {}) }) },
  );
}


export async function fetchWorklogs(
  creds: JiraCredentials,
  issueKey: string,
): Promise<JiraWorklog[]> {
  const out: JiraWorklog[] = [];
  const pageSize = 1000;
  let startAt = 0;
  for (;;) {
    const params = new URLSearchParams({
      startAt: String(startAt),
      maxResults: String(pageSize),
    });
    const res = await jiraFetch<{ worklogs?: JiraWorklog[]; total?: number }>(
      creds,
      `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}/worklog?${params.toString()}`,
    );
    const page = res.worklogs ?? [];
    out.push(...page);
    startAt += page.length;
    if (page.length === 0 || startAt >= (res.total ?? startAt)) break;
  }
  return out;
}

/** Ids of worklogs changed (or deleted) since `since` (epoch ms), all pages; `until` = Jira's clock. */
async function worklogIdsSince(
  creds: JiraCredentials,
  what: "updated" | "deleted",
  since: number,
): Promise<{ ids: string[]; until: number }> {
  const ids: string[] = [];
  let cursor = since;
  let until = since;
  for (let page = 0; page < 200; page++) {
    const res = await jiraFetch<{
      values?: { worklogId: number | string }[];
      until?: number;
      lastPage?: boolean;
    }>(creds, `${apiBase(creds)}/worklog/${what}?since=${cursor}`);
    ids.push(...(res.values ?? []).map((v) => String(v.worklogId)));
    until = res.until ?? until;
    if (res.lastPage !== false || !res.until || res.until === cursor) break;
    cursor = res.until;
  }
  return { ids, until };
}

export function fetchUpdatedWorklogIds(creds: JiraCredentials, since: number) {
  return worklogIdsSince(creds, "updated", since);
}

export function fetchDeletedWorklogIds(creds: JiraCredentials, since: number) {
  return worklogIdsSince(creds, "deleted", since);
}

/** Full worklogs by id (with their issueId), in blocks of 1000. */
export async function fetchWorklogsByIds(creds: JiraCredentials, ids: string[]): Promise<JiraWorklog[]> {
  const out: JiraWorklog[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const block = ids.slice(i, i + 1000).map(Number);
    out.push(
      // A POST that only reads: allowed on a read-only server.
      ...(await jiraFetch<JiraWorklog[]>(creds, `${apiBase(creds)}/worklog/list`, {
        method: "POST",
        body: JSON.stringify({ ids: block }),
      }, "read")),
    );
  }
  return out;
}

/** An issue by its numeric id (worklogs carry the id, not the key); null if gone. */
export async function fetchIssueById(creds: JiraCredentials, id: string): Promise<JiraSearchedIssue | null> {
  if (!/^\d+$/.test(id)) return null;
  try {
    return await jiraFetch<JiraSearchedIssue>(creds, `${apiBase(creds)}/issue/${id}?fields=${ISSUE_FIELDS}`);
  } catch (e) {
    if (e instanceof JiraApiError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

/** A single worklog of an issue; null when Jira no longer has it (404). */
export async function fetchWorklog(
  creds: JiraCredentials,
  issueKey: string,
  worklogId: string,
): Promise<JiraWorklog | null> {
  try {
    return await jiraFetch<JiraWorklog>(
      creds,
      `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(worklogId)}`,
    );
  } catch (e) {
    if (e instanceof JiraApiError && e.status === 404) return null;
    throw e;
  }
}

// ---------- Creating issues ----------

export type JiraProject = { id: string; key: string; name: string; avatarUrl: string | null; category: string | null };
type JiraProjectRow = { id: string; key: string; name: string; avatarUrls?: Record<string, string>; projectCategory?: { name?: string } };
const projectOf = (p: JiraProjectRow): JiraProject => ({ id: p.id, key: p.key, name: p.name, avatarUrl: p.avatarUrls?.["48x48"] ?? null, category: p.projectCategory?.name ?? null });
export type JiraIssueType = { id: string; name: string; subtask: boolean };

/** Projects the user can see (Server: GET /project; Cloud: paginated search). */
export async function fetchProjects(creds: JiraCredentials): Promise<JiraProject[]> {
  if (creds.deployment === "server") {
    const list = await jiraFetch<JiraProjectRow[]>(creds, `${apiBase(creds)}/project`);
    return list.map(projectOf);
  }
  const out: JiraProject[] = [];
  for (let startAt = 0; startAt < 2000; ) {
    const page = await jiraFetch<{ values: JiraProjectRow[]; isLast?: boolean; total?: number }>(
      creds,
      `${apiBase(creds)}/project/search?startAt=${startAt}&maxResults=100`,
    );
    out.push(...page.values.map(projectOf));
    if (page.isLast !== false || page.values.length === 0) break;
    startAt += page.values.length;
  }
  return out;
}

/** Issue types that can be created in a project (createmeta, Server 8.4+ / Cloud). */
export async function fetchCreateIssueTypes(
  creds: JiraCredentials,
  projectKey: string,
): Promise<JiraIssueType[]> {
  const out: JiraIssueType[] = [];
  for (let startAt = 0; startAt < 500; ) {
    const page = await jiraFetch<{
      values?: { id: string; name: string; subtask?: boolean }[];
      isLast?: boolean;
    }>(
      creds,
      `${apiBase(creds)}/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?startAt=${startAt}&maxResults=50`,
    );
    const values = page.values ?? [];
    out.push(...values.map((t) => ({ id: t.id, name: t.name, subtask: t.subtask === true })));
    if (page.isLast !== false || values.length === 0) break;
    startAt += values.length;
  }
  return out;
}

/** Create an issue; the assignee is `me` (Server: username, Cloud: accountId) or nobody. */
export async function createIssue(
  creds: JiraCredentials,
  input: {
    projectKey: string;
    issueTypeId: string;
    summary: string;
    description: string;
    assignee: string | null;
  },
): Promise<{ id: string; key: string }> {
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    issuetype: { id: input.issueTypeId },
    summary: input.summary,
  };
  if (input.description.trim()) fields.description = encodeComment(creds, input.description);
  if (input.assignee) {
    fields.assignee =
      creds.deployment === "server" ? { name: input.assignee } : { accountId: input.assignee };
  }
  return jiraFetch<{ id: string; key: string }>(creds, `${apiBase(creds)}/issue`, {
    method: "POST",
    body: JSON.stringify({ fields }),
  });
}

export async function addWorklog(
  creds: JiraCredentials,
  issueKey: string,
  input: { timeSpentSeconds: number; started: string; comment: string },
): Promise<JiraWorklog> {
  return jiraFetch<JiraWorklog>(
    creds,
    `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}/worklog`,
    {
      method: "POST",
      body: JSON.stringify({
        timeSpentSeconds: input.timeSpentSeconds,
        started: input.started,
        comment: encodeComment(creds, input.comment),
      }),
    },
  );
}

export async function updateWorklog(
  creds: JiraCredentials,
  issueKey: string,
  worklogId: string,
  input: { timeSpentSeconds: number; started: string; comment: string },
): Promise<JiraWorklog> {
  return jiraFetch<JiraWorklog>(
    creds,
    `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(worklogId)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        timeSpentSeconds: input.timeSpentSeconds,
        started: input.started,
        comment: encodeComment(creds, input.comment),
      }),
    },
  );
}

export async function deleteWorklog(
  creds: JiraCredentials,
  issueKey: string,
  worklogId: string,
): Promise<void> {
  await jiraFetch<void>(
    creds,
    `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}/worklog/${encodeURIComponent(worklogId)}`,
    { method: "DELETE" },
  );
}

// ---------- Watchers ----------

/**
 * Start or stop watching an issue as `me` (Cloud: accountId, Server/DC:
 * username). Jira answers 204 either way.
 */
export async function setWatching(
  creds: JiraCredentials,
  issueKey: string,
  me: string,
  watch: boolean,
): Promise<void> {
  const path = `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}/watchers`;
  if (watch) {
    await jiraFetch<void>(creds, path, { method: "POST", body: JSON.stringify(me) });
    return;
  }
  const param = creds.deployment === "server" ? "username" : "accountId";
  await jiraFetch<void>(creds, `${path}?${param}=${encodeURIComponent(me)}`, { method: "DELETE" });
}

// ---------- Comments ----------

export type JiraComment = {
  id: string;
  author?: { displayName?: string; accountId?: string; name?: string; avatarUrls?: { "48x48"?: string } };
  body?: unknown;
  created: string;
  updated?: string;
};

export async function fetchComments(creds: JiraCredentials, issueKey: string): Promise<JiraComment[]> {
  const params = new URLSearchParams({ orderBy: "-created", maxResults: "50" });
  const res = await jiraFetch<{ comments?: JiraComment[] }>(
    creds,
    `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}/comment?${params.toString()}`,
  );
  return res.comments ?? [];
}

// ---------- History ----------

export type JiraHistory = {
  created: string;
  author?: { displayName?: string; name?: string; accountId?: string };
  items?: { field?: string; fromString?: string | null; toString?: string | null }[];
};

/**
 * Who changed what and when, plus comments and creation, newest data first
 * (read-only). Server returns the changelog with the issue; Cloud pages it.
 */
export async function fetchIssueHistory(
  creds: JiraCredentials,
  issueKey: string,
): Promise<{
  created: string | null;
  reporter: string | null;
  histories: JiraHistory[];
  comments: JiraComment[];
}> {
  const key = encodeURIComponent(issueKey);
  const issue = await jiraFetch<{
    fields?: { created?: string; reporter?: { displayName?: string } | null };
    changelog?: { histories?: JiraHistory[] };
  }>(
    creds,
    `${apiBase(creds)}/issue/${key}?fields=created,reporter${creds.deployment === "server" ? "&expand=changelog" : ""}`,
  );
  let histories = issue.changelog?.histories ?? [];
  if (creds.deployment !== "server") {
    histories = [];
    for (let startAt = 0; startAt < 2000; ) {
      const page = await jiraFetch<{ values?: JiraHistory[]; isLast?: boolean }>(
        creds,
        `${apiBase(creds)}/issue/${key}/changelog?startAt=${startAt}&maxResults=100`,
      );
      const values = page.values ?? [];
      histories.push(...values);
      if (page.isLast !== false || values.length === 0) break;
      startAt += values.length;
    }
  }
  const comments = await fetchComments(creds, issueKey);
  return {
    created: issue.fields?.created ?? null,
    reporter: issue.fields?.reporter?.displayName ?? null,
    histories,
    comments,
  };
}

export async function addComment(creds: JiraCredentials, issueKey: string, text: string): Promise<JiraComment> {
  return jiraFetch<JiraComment>(creds, `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: "POST",
    body: JSON.stringify({ body: encodeComment(creds, text) }),
  });
}

// ---------- Attachments ----------

export type JiraAttachment = {
  id: string;
  filename: string;
  mimeType?: string;
  size?: number;
  created?: string;
  author?: { displayName?: string };
  /** Absolute URLs on the Jira site (require auth) */
  content?: string;
  thumbnail?: string;
};

export async function fetchAttachments(creds: JiraCredentials, issueKey: string): Promise<JiraAttachment[]> {
  const res = await jiraFetch<{ fields?: { attachment?: JiraAttachment[] } }>(
    creds,
    `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}?fields=attachment`,
  );
  return res.fields?.attachment ?? [];
}

/** A link on the issue to another service (Confluence, Drive, …): Jira "remote links". */
export type JiraRemoteLink = {
  id: number;
  object?: { url?: string; title?: string; summary?: string; icon?: { title?: string } };
  application?: { name?: string };
};

export async function fetchRemoteLinks(creds: JiraCredentials, issueKey: string): Promise<JiraRemoteLink[]> {
  return jiraFetch<JiraRemoteLink[]>(creds, `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}/remotelink`);
}

export async function fetchAttachmentMeta(creds: JiraCredentials, id: string): Promise<JiraAttachment> {
  return jiraFetch<JiraAttachment>(creds, `${apiBase(creds)}/attachment/${encodeURIComponent(id)}`);
}

/** Upload files to an issue (multipart; Jira requires the XSRF opt-out header). */
export async function uploadAttachments(
  creds: JiraCredentials,
  issueKey: string,
  files: File[],
): Promise<JiraAttachment[]> {
  const form = new FormData();
  for (const f of files) form.append("file", f, f.name);
  return jiraFetch<JiraAttachment[]>(creds, `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}/attachments`, {
    method: "POST",
    body: form,
    headers: { "X-Atlassian-Token": "no-check" },
    signal: AbortSignal.timeout(JIRA_TRANSFER_TIMEOUT_MS),
  });
}

/** Upper bound for attachment downloads/uploads. */
export const JIRA_TRANSFER_TIMEOUT_MS = 60_000;

/**
 * Authenticated GET of an absolute Jira URL (attachment content/thumbnail).
 * The URL must belong to the user's Jira site: never follow arbitrary hosts.
 */
export async function fetchFromSite(creds: JiraCredentials, absoluteUrl: string): Promise<Response> {
  const site = new URL(normalizeSiteUrl(creds.siteUrl));
  const target = new URL(absoluteUrl);
  if (target.origin !== site.origin) {
    throw new JiraApiError(400, t("server.jira.externalUrl"));
  }
  // The timeout bounds the wait for Jira to answer, not the streamed body: a
  // big attachment on a slow line would otherwise be cut off mid-download.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timed out", "TimeoutError")), JIRA_TRANSFER_TIMEOUT_MS);
  try {
    // Jira Cloud redirects attachment content to its media CDN (another origin,
    // signed URL): followed without the Authorization header.
    const res = await siteFetch(
      creds,
      target.toString(),
      { headers: { Authorization: authHeader(creds) }, signal: ctrl.signal },
      { allowCrossOrigin: creds.deployment === "cloud" },
    );
    if (!res.ok) throw new JiraApiError(res.status, res.statusText);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Issue description as plain text (Cloud ADF flattened; Server wiki markup kept). */
/** The description as Jira keeps it: an ADF document (Cloud) or wiki markup (Server); null when empty. */
export async function fetchIssueDescriptionRaw(creds: JiraCredentials, issueKey: string): Promise<unknown> {
  const res = await jiraFetch<{ fields?: { description?: unknown } }>(
    creds,
    `${apiBase(creds)}/issue/${encodeURIComponent(issueKey)}?fields=description`,
  );
  return res.fields?.description ?? null;
}
