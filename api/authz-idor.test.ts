import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));
// Module storage is per user; a module only has to count as installed and licensed here.
vi.mock("./modules/registry", async (original) => ({ ...(await original<typeof import("./modules/registry")>()), isActive: async () => true }));

// Every outbound call is recorded: someone else's things are refused before any is made.
const fetched: string[] = [];
vi.stubGlobal("fetch", async (url: string | URL | Request) => {
  fetched.push(url instanceof Request ? url.url : String(url));
  return new Response(JSON.stringify({ errorMessages: ["unexpected call"] }), { status: 500 });
});

/**
 * Authorization, enumerated (IDOR): every procedure in the frozen inventory
 * (api/parity/trpc-procedures.json) whose input names something of a user's
 * own is called by Bob with Ann's ids. Each is refused, or answers with
 * nothing of Ann's; no row that isn't Bob's changes; nothing is fetched with
 * Ann's connections. The same calls made by Ann on her own rows go through,
 * so a refusal is about the owner, not about a wrong seed. Server-wide
 * powers (permProcedure) are reached only with their permission.
 */

type Caller = ReturnType<typeof import("./router").appRouter.createCaller>;
type Row = Record<string, unknown>;
const q = async <T = Row>(text: string, ...params: unknown[]): Promise<T[]> => (await import("./queries/connection")).q<T>(text, ...params);
const one = async <T = Row>(text: string, ...params: unknown[]): Promise<T> => (await q<T>(text, ...params))[0];

/** Text in every row of Ann's: an answer that holds it gave her data away. */
const SECRET = "ann-secret";
/** The same for rows of Bob's own, seeded to check the owner's calls go through. */
const OWN = "bob-own";
const ANN_HOST = "ann.example";
const BOB_HOST = "bob.example";

const PROCEDURES = (JSON.parse(readFileSync(path.join(import.meta.dirname, "parity/trpc-procedures.json"), "utf8")) as { path: string; type: string }[]).map((p) => p.path);

// ---------------------------------------------------------------------------
// What an input names: field paths found in each procedure's input schema.

type JsonSchema = { properties?: Record<string, JsonSchema>; items?: JsonSchema; anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; allOf?: JsonSchema[] };

function fieldsOf(schema: JsonSchema, at = "", out = new Set<string>()): Set<string> {
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    out.add(at + k);
    fieldsOf(v, at + k + ".", out);
  }
  if (schema.items) fieldsOf(schema.items, at.replace(/\.$/, "") + "[].", out);
  for (const v of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])]) fieldsOf(v, at, out);
  return out;
}

/** A field that names a row, a connection, an issue, a user… by its id or key. */
const ID_FIELD = /(^|\.)(id|ids|key|keys|batch|items)$|Ids?$|Key$/;

/** Id-like fields that name nothing another user could own, with why. */
const NOT_OWNED: Record<string, string> = {
  opId: "an idempotency key, stored per user",
  transitionId: "the tracker's transition, asked of the caller's own connection once the issue is checked",
  statusId: "the tracker's status, on a connection checked first",
  commentId: "the tracker's comment, on an issue checked first",
  activityId: "the sink's activity, on a sink checked first",
  "steps[].id": "an item inside the caller's own row",
  "acceptance[].id": "an item inside the caller's own row",
  "questions[].id": "an item inside the caller's own row",
  "dashboardLayout[].id": "a dashboard widget's name",
  "people[].remoteId": "the tracker's people, on an issue checked first",
  actorUserId: "a filter on the audit log, which is server-wide (viewAudit), not anyone's own",
  targetId: "a filter on the audit log, which is server-wide (viewAudit), not anyone's own",
  "target.remoteId": "the sink's target, on a sink checked first",
  "target.path[].remoteId": "the sink's target, on a sink checked first",
};

/** Procedures (or a field of one) not covered here, with why. */
const SKIPS: Record<string, string> = {
  "connections.githubPoll": "a device sign-in lives in memory with the user who started it and needs the provider",
  "mails.signInPoll": "a device sign-in lives in memory with the user who started it and needs the provider",
  "connections.setOption key": "the name of an option, on a connection checked first",
  "modules.licenceProof": "a licence is the server's, not a user's",
  "modules.licenceProofFile": "a licence is the server's, not a user's",
  "modules.removeLicense": "server-wide, manageStore (the permission tests below)",
  "modules.uninstall": "server-wide, manageStore (the permission tests below)",
  "users.reinvite": "accounts, manageUsers (the permission tests below)",
  "users.setAccess": "accounts, manageUsers (the permission tests below)",
  "users.rename": "accounts, manageUsers (the permission tests below)",
  "users.resetPassword": "accounts, manageUsers (the permission tests below)",
  "users.setDisabled": "accounts, manageUsers (the permission tests below)",
  "users.setBreakGlass": "accounts, manageAuth (the permission tests below)",
  "sso.updateProvider": "identity providers are the server's, manageAuth (the permission tests below)",
  "sso.removeProvider": "identity providers are the server's, manageAuth (the permission tests below)",
  "sso.setEnforced": "identity providers are the server's, manageAuth (the permission tests below)",
  "sso.createScimToken": "identity providers are the server's, manageAuth (the permission tests below)",
  "sso.revokeScimToken": "SCIM tokens are the server's, manageAuth (the permission tests below)",
  "users.invite roleId": "a role is the server's, not a user's (manageUsers, the escalation tests below)",
  "users.invite teams[].teamId": "a team is the server's, not a user's (manageUsers, the escalation tests below)",
  "roles.create key": "the new role's own name, not a row of anyone's",
  "roles.update": "roles are the server's, manageUsers (the permission tests below)",
  "roles.remove": "roles are the server's, manageUsers (the permission tests below)",
  "teams.rename": "teams are the server's, manageTeams (the permission tests below)",
  "teams.remove": "teams are the server's, manageTeams (the permission tests below)",
  "teams.setMember": "teams are the server's, manageTeams (the permission tests below)",
  "teams.removeMember": "teams are the server's, manageTeams (the permission tests below)",
  "team.person": "reads another user by design, viewTeamTime (the permission tests below)",
  "team.day": "reads another user by design, viewTeamTime (the permission tests below)",
  "notifications.createTest issueKey": "a test notification for the caller, about any key typed",
  "mails.save internetMessageId": "covered with exchangeId by the mails.save case",
  "forecast.finish issues[].issueKey": "needs the forecast service, not available in tests",
  "forecast.finish issues[].connectionId": "needs the forecast service, not available in tests",
  "pinboard.unpinIssue issueKey": "picks among the pins of the board, checked first",
  "pinboard.unpinIssue connectionId": "picks among the pins of the board, checked first",
  "decisions.patchDraft id": "read and written under (id, user_id) in decisions/store.ts patchDraft",
  "decisions.dismiss id": "claimed under (id, user_id, revision) in decisions/store.ts answer",
  "decisions.askTimerLog issueKey": "the caller's own connection (issueConnection) and timer (user_id filter)",
  "decisions.askTimerLog connectionId": "the caller's own connection (issueConnection) and timer (user_id filter)",
  "worklogs.create decision.id": "claimed under (id, user_id, revision) in decisions/store.ts answer",
};
/** Whole routers whose ids are keys under the caller's own (user, surface, device) scope. */
const SKIPPED_ROUTERS: Record<string, string> = {
  workspace: "layout ids are keys under the caller's own scope: every workspace table's key starts with user_id; workspace.test.ts covers another user's revisions",
  flowMap: "layout ids are keys under the caller's own scope: every workspace table's key starts with user_id",
  planner: "layout ids are keys under the caller's own scope: every workspace table's key starts with user_id",
};

// ---------------------------------------------------------------------------
// Seeds: Bob's things once, Ann's afresh for every case.

let annId = 0;
let bobId = 0;
let bob: Caller;
let callerOf: (user: Row) => Caller;

type Bob = Awaited<ReturnType<typeof seedBob>>;
let b: Bob;

async function sealed(id: number) {
  const { sealSecret } = await import("./lib/crypto");
  await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("t", id), id);
}

async function connection(userId: number, type: string, host: string, account: string, options: object = {}) {
  const c = await one<{ id: number }>(
    "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, ?, ?, ?, ?, 'x', 1) RETURNING id",
    userId,
    type,
    "https://" + host,
    account,
    JSON.stringify(options),
  );
  await sealed(c.id);
  return c.id;
}

const jiraOptions = (who: string) => ({ deployment: "cloud", authType: "basic", username: who + "@example.com" });

/** Bob's own things a case may point Ann's ids from (for the owner's control, another account's). */
async function seedBob(bobId: number, tag = "bob") {
  const conn = await connection(bobId, "jira", BOB_HOST, tag, jiraOptions("bob"));
  const sink = await connection(bobId, "everhour", BOB_HOST, tag + "-sink");
  const tempo = await connection(bobId, "tempo", BOB_HOST, tag + "-tempo");
  const container = (await one<{ id: number }>("INSERT INTO containers (connection_id, remote_id, key, name, created_at) VALUES (?, 'b1', 'BOB', 'Bob', 1) RETURNING id", conn)).id;
  await q("INSERT INTO issues (user_id, connection_id, container_id, jira_id, key, summary, status, project_key, project_name, url, favorite, favorite_rank, synced_at) VALUES (?, ?, ?, '1', 'BOB-1', 'Bob''s', 'To Do', 'BOB', 'Bob', 'u', 1, 5, 1)", bobId, conn, container);
  const bucket = (await one<{ id: number }>("INSERT INTO buckets (user_id, name, position, created_at) VALUES (?, 'Bob', 0, 1) RETURNING id", bobId)).id;
  const board = (await one<{ id: number }>("INSERT INTO pinboards (user_id, name, position, created_at) VALUES (?, 'Bob', 0, 1) RETURNING id", bobId)).id;
  const pin = (await one<{ id: number }>("INSERT INTO pinboard_notes (user_id, board_id, note, x, y, created_at, updated_at) VALUES (?, ?, 'bob', 1, 1, 1, 1) RETURNING id", bobId, board)).id;
  const todo = (await one<{ id: number }>("INSERT INTO todos (user_id, text, position, created_at, updated_at) VALUES (?, 'bob', 0, 1, 1) RETURNING id", bobId)).id;
  const issueNote = (await one<{ id: number }>("INSERT INTO issue_notes (user_id, connection_id, issue_key, body, created_at, updated_at) VALUES (?, ?, 'BOB-1', 'bob', 1, 1) RETURNING id", bobId, conn)).id;
  const mail = (await one<{ id: number }>("INSERT INTO mails (user_id, subject, source, created_at, updated_at) VALUES (?, 'bob', 'eml', 1, 1) RETURNING id", bobId)).id;
  const note = (await one<{ id: string }>("INSERT INTO markdown_notes (user_id, title, body, created_at, updated_at) VALUES (?, 'bob', 'bob', 1, 1) RETURNING id", bobId)).id;
  const idea = (await one<{ id: number }>("INSERT INTO ideas (user_id, title, created_at, updated_at) VALUES (?, 'bob', 1, 1) RETURNING id", bobId)).id;
  const planned = (await one<{ id: string }>("INSERT INTO planned_entries (user_id, kind, starts_at, ends_at, note, created_at, updated_at) VALUES (?, 'travel', ?, ?, 'bob', 1, 1) RETURNING id", bobId, Date.parse("2026-10-20T09:00:00Z"), Date.parse("2026-10-20T10:00:00Z"))).id;
  await q("INSERT INTO timers (user_id, connection_id, issue_key, started_at, created_at, updated_at) VALUES (?, ?, 'BOB-1', 1, 1, 1)", bobId, conn);
  return { conn, sink, tempo, container, key: "BOB-1", bucket, board, pin, todo, issueNote, mail, note, idea, planned };
}

let seeds = 0;
/** A project key of its own per seed: a key typed alone names exactly one issue of Ann's. */
const projectOf = (n: number) => "Q" + [26 * 26, 26, 1].map((d) => String.fromCharCode(65 + (Math.floor(n / d) % 26))).join("");

async function seedFor(userId: number, who: "ann" | "bob") {
  const n = ++seeds;
  const mark = who === "ann" ? SECRET : OWN;
  const host = who === "ann" ? ANN_HOST : BOB_HOST;
  const P = projectOf(n);
  const key = P + "-1";
  const conn = await connection(userId, "jira", host, who + "-" + n, jiraOptions(who));
  const sink = await connection(userId, "everhour", host, who + "-sink-" + n);
  const tempo = await connection(userId, "tempo", host, who + "-tempo-" + n);
  const container = (await one<{ id: number }>("INSERT INTO containers (connection_id, remote_id, key, name, created_at) VALUES (?, ?, ?, ?, 1) RETURNING id", conn, "c" + n, P, mark)).id;
  const remoteId = String(1000 + n);
  const issue = (
    await one<{ id: number }>(
      "INSERT INTO issues (user_id, connection_id, container_id, jira_id, key, summary, status, project_key, project_name, url, favorite, favorite_rank, synced_at) VALUES (?, ?, ?, ?, ?, ?, 'To Do', ?, ?, 'u', 1, 5, 1) RETURNING id",
      userId,
      conn,
      container,
      remoteId,
      key,
      mark,
      P,
      mark,
    )
  ).id;
  const worklogRemote = who + "-w" + n;
  const worklog = (
    await one<{ id: number }>(
      "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, ?, ?, 600, 1760000000000, ?, 1) RETURNING id",
      userId,
      conn,
      key,
      worklogRemote,
      mark,
    )
  ).id;
  await q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (?, ?, ?, ?, 300, 1760000000000, ?, 1)", userId, conn, key, who + "-gone" + n, mark);
  await q("DELETE FROM worklogs WHERE jira_worklog_id = ?", who + "-gone" + n);
  const trash = (await one<{ id: number }>("SELECT id FROM worklog_trash WHERE user_id = ? ORDER BY id DESC LIMIT 1", userId)).id;
  const bucket = (await one<{ id: number }>("INSERT INTO buckets (user_id, name, position, created_at) VALUES (?, ?, 0, 1) RETURNING id", userId, mark + n)).id;
  await q("INSERT INTO bucket_sources (bucket_id, connection_id, container_id) VALUES (?, ?, ?)", bucket, conn, container);
  const folder = (await one<{ id: string }>("INSERT INTO markdown_notes (user_id, kind, title, body, created_at, updated_at) VALUES (?, 'folder', ?, '', 1, 1) RETURNING id", userId, mark)).id;
  const note = (await one<{ id: string }>("INSERT INTO markdown_notes (user_id, parent_id, title, body, issue_key, connection_id, noted_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1) RETURNING id", userId, folder, mark, mark, key, conn, today)).id;
  const version = (await one<{ id: string }>("INSERT INTO markdown_note_versions (note_id, user_id, title, body, content_revision, origin, created_at) VALUES (?, ?, ?, ?, 1, 'manual', 1) RETURNING id", note, userId, mark, mark)).id;
  const deleted = await one<{ id: string; batch: string }>(
    "INSERT INTO markdown_notes (user_id, title, body, deleted_at, delete_batch, created_at, updated_at) VALUES (?, ?, ?, 1, gen_random_uuid(), 1, 1) RETURNING id, delete_batch AS batch",
    userId,
    mark,
    mark,
  );
  await q("UPDATE markdown_notes SET delete_root_id = id WHERE id = ?", deleted.id);
  const todo = (await one<{ id: number }>("INSERT INTO todos (user_id, text, position, issue_key, connection_id, created_at, updated_at) VALUES (?, ?, 0, ?, ?, 1, 1) RETURNING id", userId, mark, key, conn)).id;
  const issueNote = (await one<{ id: number }>("INSERT INTO issue_notes (user_id, connection_id, issue_key, body, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1) RETURNING id", userId, conn, key, mark)).id;
  const messageId = "<" + who + "-" + n + "@example.com>";
  const exchangeId = who + "-x" + n;
  const mail = (
    await one<{ id: number }>(
      "INSERT INTO mails (user_id, subject, internet_message_id, exchange_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'graph', 1, 1) RETURNING id",
      userId,
      mark,
      messageId,
      exchangeId,
    )
  ).id;
  await q("INSERT INTO mail_links (user_id, mail_id, issue_key, connection_id, created_at) VALUES (?, ?, ?, ?, 1)", userId, mail, key, conn);
  await q("INSERT INTO mail_links (user_id, mail_id, note_id, created_at) VALUES (?, ?, ?, 1)", userId, mail, note);
  const idea = (await one<{ id: number }>("INSERT INTO ideas (user_id, title, body, container_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1) RETURNING id", userId, mark, mark, container)).id;
  const deletedIdea = (await one<{ id: number }>("INSERT INTO ideas (user_id, title, deleted_at, created_at, updated_at) VALUES (?, ?, 1, 1, 1) RETURNING id", userId, mark)).id;
  await q("INSERT INTO status_snapshots (connection_id, status_id, name, category, seen_at) VALUES (?, '1', 'Doing', 'doing', 1)", conn);
  const board = (await one<{ id: number }>("INSERT INTO pinboards (user_id, name, position, bucket_id, created_at) VALUES (?, ?, 0, ?, 1) RETURNING id", userId, mark + n, bucket)).id;
  const pin = (await one<{ id: number }>("INSERT INTO pinboard_notes (user_id, board_id, issue_key, connection_id, note, x, y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, 1, 1) RETURNING id", userId, board, key, conn, mark)).id;
  const client = (await one<{ id: number }>("INSERT INTO clients (user_id, name, created_at) VALUES (?, ?, 1) RETURNING id", userId, mark + n)).id;
  await q("INSERT INTO client_containers (client_id, container_id) VALUES (?, ?)", client, container);
  const query = (await one<{ id: number }>("INSERT INTO saved_queries (user_id, name, query, created_at) VALUES (?, ?, ?, 1) RETURNING id", userId, mark + n, mark)).id;
  const outbox = (await one<{ id: number }>("INSERT INTO outbox (user_id, connection_id, kind, issue_key, jira_worklog_id, comment, attempts, created_at) VALUES (?, ?, 'delete', ?, ?, ?, 3, 1) RETURNING id", userId, conn, key, worklogRemote, mark)).id;
  const notification = (await one<{ id: number }>("INSERT INTO notifications (user_id, connection_id, kind, issue_key, detail, dedupe, created_at) VALUES (?, ?, 'assigned', ?, ?, ?, 1) RETURNING id", userId, conn, key, mark, "n" + n)).id;
  const planned = (
    await one<{ id: string }>(
      "INSERT INTO planned_entries (user_id, kind, starts_at, ends_at, note, connection_id, issue_key, created_at, updated_at) VALUES (?, 'work', ?, ?, ?, ?, ?, 1, 1) RETURNING id",
      userId,
      Date.parse("2026-10-21T09:00:00Z"),
      Date.parse("2026-10-21T10:00:00Z"),
      mark,
      conn,
      key,
    )
  ).id;
  await q("INSERT INTO timers (user_id, connection_id, issue_key, started_at, note, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 1)", userId, conn, key, mark);
  await q("INSERT INTO sink_mappings (sink_connection_id, container_id, target_remote_id, target_name) VALUES (?, ?, 't1', ?)", sink, container, mark);
  await q("INSERT INTO module_storage (user_id, module_id, key, value, updated_at) VALUES (?, 'm1', ?, ?, 1)", userId, "k" + n, JSON.stringify(mark));
  await q("INSERT INTO module_files (user_id, module_id, key, content_type, data, size, updated_at, used_at) VALUES (?, 'm1', ?, 'application/json', ?, 10, 1, 1)", userId, "f" + n, Buffer.from(mark));
  return { n, conn, sink, tempo, container, key, project: P, issue, remoteId, worklog, worklogRemote, trash, bucket, folder, note, version, batch: deleted.batch, todo, issueNote, mail, messageId, exchangeId, idea, deletedIdea, board, pin, client, query, outbox, notification, planned, moduleKey: "k" + n, moduleFile: "f" + n };
}
type Ann = Awaited<ReturnType<typeof seedFor>>;

// ---------------------------------------------------------------------------
// The cases: Bob calls with Ann's ids. "refused": an error whose code is in
// codes (NOT_FOUND or FORBIDDEN unless given); "noLeak": whatever it answers
// holds nothing of Ann's (a key typed alone names an issue on Bob's own tracker).

type Code = "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST" | "PRECONDITION_FAILED" | "CONFLICT";
type Case = {
  proc: string;
  fields: string[];
  call: (c: Caller, a: Ann, b: Bob) => Promise<unknown>;
  expect?: "refused" | "noLeak";
  codes?: Code[];
  /** Why the owner's own call can't run here (a provider is needed, the call is the same as another's). */
  noOwner?: string;
  /** What in an answer is the owner's (default: his marker text); Bob's answers never show Ann's. */
  sees?: (answer: unknown, a: Ann) => boolean;
  name?: string;
};

const started = "2026-10-14T09:00:00+02:00";
const on = (a: Ann) => ({ key: a.key, connectionId: a.conn });
const keyOnly = (a: Ann) => ({ key: a.key });
const today = "2026-10-23";
const scopeAll = "all" as const;

/** Procedures on one issue ({key, connectionId?}): by Ann's connection, refused; by her key alone, Bob's own tracker answers. */
const issueProcs: [string, (c: Caller, ref: { key: string; connectionId?: number }) => Promise<unknown>][] = [
  ["issues.history", (c, r) => c.issues.history(r)],
  ["issues.watch", (c, r) => c.issues.watch({ ...r, watch: true })],
  ["issues.import", (c, r) => c.issues.import(r)],
  ["issues.toggleFavorite", (c, r) => c.issues.toggleFavorite(r)],
  ["issues.setHidden", (c, r) => c.issues.setHidden({ ...r, hidden: true })],
  ["issues.otherFields", (c, r) => c.issues.otherFields(r)],
  ["issues.description", (c, r) => c.issues.description(r)],
  ["issues.comments", (c, r) => c.issues.comments(r)],
  ["issues.addComment", (c, r) => c.issues.addComment({ ...r, text: "hi" })],
  ["issues.attachments", (c, r) => c.issues.attachments(r)],
  ["issues.copyForAgent", (c, r) => c.issues.copyForAgent(r)],
  ["issues.analyzeCommand", (c, r) => c.issues.analyzeCommand(r)],
  ["issues.remoteLinks", (c, r) => c.issues.remoteLinks(r)],
  ["issues.manageable", (c, r) => c.issues.manageable(r)],
  ["issues.assignable", (c, r) => c.issues.assignable(r)],
  ["issues.assign", (c, r) => c.issues.assign({ ...r, people: [] })],
  ["issues.labelOptions", (c, r) => c.issues.labelOptions(r)],
  ["issues.setLabels", (c, r) => c.issues.setLabels({ ...r, labels: ["x"] })],
  ["issues.edit", (c, r) => c.issues.edit({ ...r, title: "mine" })],
  ["issues.transitions", (c, r) => c.issues.transitions(r)],
  ["issues.transition", (c, r) => c.issues.transition({ ...r, toStatus: "Done" })],
  ["issues.markSeen", (c, r) => c.issues.markSeen(r)],
  ["issues.get", (c, r) => c.issues.get(r)],
];

/** The same, with the issue as {issueKey, connectionId?}. */
const issueKeyProcs: [string, (c: Caller, ref: { issueKey: string; connectionId?: number }) => Promise<unknown>][] = [
  ["worklogs.team", (c, r) => c.worklogs.team(r)],
  ["worklogs.syncIssue", (c, r) => c.worklogs.syncIssue(r)],
  ["worklogs.create", (c, r) => c.worklogs.create({ ...r, seconds: 600, started, comment: "" })],
  ["timers.start", (c, r) => c.timers.start(r)],
  ["timers.pause", (c, r) => c.timers.pause(r)],
  ["timers.stop", (c, r) => c.timers.stop(r)],
  ["timers.setNote", (c, r) => c.timers.setNote({ ...r, note: "mine" })],
  ["timers.trim", (c, r) => c.timers.trim({ ...r, seconds: 60 })],
  ["timers.split", (c, r) => c.timers.split(r)],
  ["timers.discard", (c, r) => c.timers.discard(r)],
  ["issueNotes.list", (c, r) => c.issueNotes.list(r)],
  ["issueNotes.add", (c, r) => c.issueNotes.add({ ...r, body: "hi" })],
  ["issueNotes.restore", (c, r) => c.issueNotes.restore({ ...r, body: "hi", createdAt: 1 })],
  ["pinboard.where", (c, r) => c.pinboard.where(r)],
  ["todos.forIssue", (c, r) => c.todos.forIssue(r)],
  ["estimates.forIssue", (c, r) => c.estimates.forIssue(r)],
  ["ideas.fromIssue", (c, r) => c.ideas.fromIssue(r)],
  ["ideas.forIssue", (c, r) => c.ideas.forIssue(r)],
  ["mails.forIssue", (c, r) => c.mails.forIssue(r)],
];

const CASES: Case[] = [
  ...issueProcs.flatMap(([proc, call]): Case[] => [
    { proc, fields: ["connectionId", "key"], call: (c, a) => call(c, on(a)) },
    { proc, fields: ["key"], call: (c, a) => call(c, keyOnly(a)), expect: "noLeak", name: "key alone", noOwner: "same as by connection" },
  ]),
  ...issueKeyProcs.flatMap(([proc, call]): Case[] => [
    { proc, fields: ["connectionId", "issueKey"], call: (c, a) => call(c, { issueKey: a.key, connectionId: a.conn }) },
    { proc, fields: ["issueKey"], call: (c, a) => call(c, { issueKey: a.key }), expect: "noLeak", name: "key alone", noOwner: "same as by connection" },
  ]),

  // Connections
  { proc: "connections.reconnectJira", fields: ["id"], call: (c, a) => c.connections.reconnectJira({ id: a.conn, siteUrl: "https://" + ANN_HOST, deployment: "cloud", authType: "basic", username: "ann@example.com", secret: "t" }) },
  { proc: "connections.test", fields: ["id"], call: (c, a) => c.connections.test({ id: a.conn }) },
  { proc: "connections.reconnectToken", fields: ["id"], call: (c, a) => c.connections.reconnectToken({ id: a.sink, token: "token-123456" }) },
  { proc: "connections.allowWrites", fields: ["id"], call: (c, a) => c.connections.allowWrites({ id: a.conn, on: true }) },
  { proc: "connections.standIn", fields: ["id"], call: (c, a) => c.connections.standIn({ id: a.tempo, trackerId: null }) },
  { proc: "connections.standIn", fields: ["trackerId"], call: (c, a, b) => c.connections.standIn({ id: b.tempo, trackerId: a.conn }) },
  { proc: "connections.containers", fields: ["id"], call: (c, a) => c.connections.containers({ id: a.conn }) },
  { proc: "connections.setExcluded", fields: ["id", "keys"], call: (c, a) => c.connections.setExcluded({ id: a.conn, keys: [a.project] }) },
  { proc: "connections.webhook", fields: ["id"], call: (c, a) => c.connections.webhook({ id: a.conn }) },
  { proc: "connections.setWebhook", fields: ["id"], call: (c, a) => c.connections.setWebhook({ id: a.conn, on: true }) },
  { proc: "connections.setOption", fields: ["id"], call: (c, a) => c.connections.setOption({ id: a.conn, key: "label", value: "mine" }) },
  { proc: "connections.rename", fields: ["id"], call: (c, a) => c.connections.rename({ id: a.conn, label: "mine" }) },
  { proc: "connections.archive", fields: ["id"], call: (c, a) => c.connections.archive({ id: a.conn }) },
  { proc: "issues.syncConnection", fields: ["id"], call: (c, a) => c.issues.syncConnection({ id: a.conn }) },

  // Issues: by connection, in lists, to create
  { proc: "issues.searchOn", fields: ["connectionId"], call: (c, a) => c.issues.searchOn({ connectionId: a.conn, query: "xy" }) },
  { proc: "issues.createTypes", fields: ["connectionId"], call: (c, a) => c.issues.createTypes({ connectionId: a.conn, container: a.project }) },
  { proc: "issues.createFields", fields: ["connectionId"], call: (c, a) => c.issues.createFields({ connectionId: a.conn, container: a.project, type: "Task" }) },
  { proc: "issues.createIn", fields: ["connectionId"], call: (c, a) => c.issues.createIn({ connectionId: a.conn, container: a.project, title: "x" }) },
  { proc: "issues.locate", fields: ["connectionId", "key", "remoteId"], call: (c, a) => c.issues.locate({ connectionId: a.conn, key: a.key, remoteId: a.remoteId }), expect: "noLeak", sees: (v) => v !== null },
  { proc: "issues.reorderFavorites", fields: ["keys", "items", "items[].key", "items[].connectionId"], call: (c, a, b) => c.issues.reorderFavorites({ keys: [b.key, a.key], items: [{ key: b.key, connectionId: b.conn }, on(a)] }), expect: "noLeak" },
  { proc: "issues.list", fields: ["projectKey"], call: (c, a) => c.issues.list({ projectKey: a.project, includeDone: true, includeUnassigned: true, hidden: "exclude", excludeFavorites: false, sort: "updated", page: 1, pageSize: 50 }), expect: "noLeak" },
  { proc: "desks.add", fields: ["connectionId", "key"], call: (c, a) => c.desks.add(on(a)) },
  { proc: "desks.add", fields: ["remoteId"], call: (c, a) => c.desks.add({ connectionId: a.conn, remoteId: a.remoteId }) },
  { proc: "desks.add", fields: ["key"], call: (c, a) => c.desks.add(keyOnly(a)), expect: "noLeak", name: "key alone", noOwner: "same as by connection" },
  {
    proc: "desks.setCurrent",
    fields: [],
    name: "Ann's issue stored, read back",
    call: async (c, a) => {
      await c.desks.setCurrent({ layout: { panes: [{ connectionId: a.conn, key: a.key, remoteId: a.remoteId }], parked: [] } });
      return c.desks.current();
    },
    expect: "noLeak",
  },

  // Worklogs and the trash
  { proc: "worklogs.resolveConflict", fields: ["id"], call: (c, a) => c.worklogs.resolveConflict({ id: a.worklog, keep: "mine" }) },
  { proc: "worklogs.list", fields: ["issueKey", "connectionId"], call: (c, a) => c.worklogs.list({ issueKey: a.key, connectionId: a.conn, scope: scopeAll }), expect: "noLeak" },
  { proc: "worklogs.update", fields: ["id"], call: (c, a) => c.worklogs.update({ id: a.worklog, seconds: 60, started, comment: "" }) },
  { proc: "worklogs.update", fields: ["connectionId", "issueKey", "remoteId"], call: (c, a) => c.worklogs.update({ connectionId: a.conn, issueKey: a.key, remoteId: a.worklogRemote, seconds: 60, started, comment: "" }) },
  { proc: "worklogs.update", fields: ["jiraWorklogId"], call: (c, a) => c.worklogs.update({ issueKey: a.key, jiraWorklogId: a.worklogRemote, seconds: 60, started, comment: "" }), expect: "noLeak" },
  { proc: "worklogs.restore", fields: ["id"], call: (c, a) => c.worklogs.restore({ id: a.trash }) },
  { proc: "worklogs.delete", fields: ["id"], call: (c, a) => c.worklogs.delete({ id: a.worklog }) },
  { proc: "worklogs.delete", fields: ["connectionId", "issueKey", "remoteId"], call: (c, a) => c.worklogs.delete({ connectionId: a.conn, issueKey: a.key, remoteId: a.worklogRemote }) },
  { proc: "worklogs.delete", fields: ["jiraWorklogId"], call: (c, a) => c.worklogs.delete({ issueKey: a.key, jiraWorklogId: a.worklogRemote }), expect: "noLeak" },
  { proc: "timers.move", fields: ["connectionId", "issueKey"], call: (c, a, b) => c.timers.move({ issueKey: a.key, connectionId: a.conn, toIssueKey: b.key, toConnectionId: b.conn }) },
  { proc: "timers.move", fields: ["toIssueKey", "toConnectionId"], call: (c, a, b) => c.timers.move({ issueKey: b.key, connectionId: b.conn, toIssueKey: a.key, toConnectionId: a.conn }) },
  { proc: "outbox.discard", fields: ["id"], call: (c, a) => c.outbox.discard({ id: a.outbox }), expect: "noLeak" },
  { proc: "notifications.dismiss", fields: ["id"], call: (c, a) => c.notifications.dismiss({ id: a.notification }), expect: "noLeak" },
  { proc: "notifications.dismissMany", fields: ["ids"], call: (c, a) => c.notifications.dismissMany({ ids: [a.notification] }), expect: "noLeak" },

  // Private notes on issues
  { proc: "issueNotes.update", fields: ["id"], call: (c, a) => c.issueNotes.update({ id: a.issueNote, body: "mine" }) },
  { proc: "issueNotes.remove", fields: ["id"], call: (c, a) => c.issueNotes.remove({ id: a.issueNote }) },

  // The pinboard
  { proc: "pinboard.boards", fields: ["connectionId"], call: (c, a) => c.pinboard.boards({ connectionId: a.conn }), expect: "noLeak" },
  { proc: "pinboard.setBoardScope", fields: ["id"], call: (c, a) => c.pinboard.setBoardScope({ id: a.board, bucketId: a.bucket }) },
  { proc: "pinboard.setBoardScope", fields: ["bucketId"], call: (c, a, b) => c.pinboard.setBoardScope({ id: b.board, bucketId: a.bucket }) },
  { proc: "pinboard.createBoard", fields: ["bucketId"], call: (c, a) => c.pinboard.createBoard({ name: "mine", bucketId: a.bucket }) },
  { proc: "pinboard.createBoard", fields: ["follow.connectionId"], call: (c, a) => c.pinboard.createBoard({ name: "mine", follow: { field: "label", value: a.project, connectionId: a.conn } }) },
  { proc: "pinboard.renameBoard", fields: ["id"], call: (c, a) => c.pinboard.renameBoard({ id: a.board, name: "mine" }) },
  { proc: "pinboard.deleteBoard", fields: ["id"], call: (c, a) => c.pinboard.deleteBoard({ id: a.board }) },
  { proc: "pinboard.list", fields: ["boardId"], call: (c, a) => c.pinboard.list({ boardId: a.board }) },
  { proc: "pinboard.list", fields: ["connectionId"], call: (c, a) => c.pinboard.list({ connectionId: a.conn }), expect: "noLeak", noOwner: "narrows the caller's own board, whose rows are the caller's pins" },
  { proc: "pinboard.add", fields: ["boardId"], call: (c, a) => c.pinboard.add({ boardId: a.board, note: "mine", color: "yellow" }) },
  { proc: "pinboard.add", fields: ["issueKey", "connectionId"], call: (c, a, b) => c.pinboard.add({ boardId: b.board, issueKey: a.key, connectionId: a.conn, note: "", color: "yellow" }) },
  { proc: "pinboard.pinNote", fields: ["noteId"], call: (c, a, b) => c.pinboard.pinNote({ noteId: a.issueNote, boardId: b.board }) },
  { proc: "pinboard.pinNote", fields: ["boardId"], call: (c, a, b) => c.pinboard.pinNote({ noteId: b.issueNote, boardId: a.board }) },
  { proc: "pinboard.pinTodo", fields: ["todoId"], call: (c, a, b) => c.pinboard.pinTodo({ todoId: a.todo, boardId: b.board }) },
  { proc: "pinboard.pinTodo", fields: ["boardId"], call: (c, a, b) => c.pinboard.pinTodo({ todoId: b.todo, boardId: a.board }) },
  { proc: "pinboard.pinMail", fields: ["mailId"], call: (c, a, b) => c.pinboard.pinMail({ mailId: a.mail, boardId: b.board }) },
  { proc: "pinboard.pinMail", fields: ["boardId"], call: (c, a, b) => c.pinboard.pinMail({ mailId: b.mail, boardId: a.board }) },
  { proc: "pinboard.update", fields: ["id"], call: (c, a) => c.pinboard.update({ id: a.pin, note: "mine" }) },
  { proc: "pinboard.update", fields: ["boardId"], call: (c, a, b) => c.pinboard.update({ id: b.pin, boardId: a.board }), expect: "noLeak" },
  { proc: "pinboard.unpinIssue", fields: ["boardId"], call: (c, a) => c.pinboard.unpinIssue({ boardId: a.board, issueKey: a.key, connectionId: a.conn }) },
  { proc: "pinboard.copy", fields: ["id"], call: (c, a, b) => c.pinboard.copy({ id: a.pin, boardId: b.board, move: true }) },
  { proc: "pinboard.copy", fields: ["boardId"], call: (c, a, b) => c.pinboard.copy({ id: b.pin, boardId: a.board, move: false }) },
  { proc: "pinboard.remove", fields: ["id"], call: (c, a) => c.pinboard.remove({ id: a.pin }) },
  { proc: "pinboard.restore", fields: ["boardId"], call: (c, a) => c.pinboard.restore({ boardId: a.board, issueKey: a.key, connectionId: a.conn, note: "", color: "yellow", x: 1, y: 1, rotation: 0 }) },
  {
    proc: "pinboard.restore",
    fields: ["issueKey", "connectionId", "issueNoteId", "todoId", "mailId"],
    call: (c, a, b) => c.pinboard.restore({ boardId: b.board, issueKey: a.key, connectionId: a.conn, issueNoteId: a.issueNote, todoId: a.todo, mailId: a.mail, note: "", color: "yellow", x: 1, y: 1, rotation: 0 }),
  },
  { proc: "pinboard.link", fields: ["id"], call: (c, a) => c.pinboard.link({ id: a.pin, issueKey: a.key, connectionId: a.conn }) },
  { proc: "pinboard.link", fields: ["issueKey", "connectionId"], call: (c, a, b) => c.pinboard.link({ id: b.pin, issueKey: a.key, connectionId: a.conn }) },

  // TODOs
  { proc: "todos.add", fields: ["issueKey", "connectionId"], call: (c, a) => c.todos.add({ text: "x", issueKey: a.key, connectionId: a.conn }) },
  { proc: "todos.add", fields: ["issueNoteId"], call: (c, a) => c.todos.add({ text: "x", issueNoteId: a.issueNote }) },
  { proc: "todos.add", fields: ["mailId"], call: (c, a) => c.todos.add({ text: "x", mailId: a.mail }) },
  { proc: "todos.update", fields: ["id"], call: (c, a) => c.todos.update({ id: a.todo, text: "mine" }) },
  { proc: "todos.update", fields: ["issueKey", "connectionId"], call: (c, a, b) => c.todos.update({ id: b.todo, issueKey: a.key, connectionId: a.conn }) },
  { proc: "todos.update", fields: ["mailId"], call: (c, a, b) => c.todos.update({ id: b.todo, mailId: a.mail }) },
  { proc: "todos.reorder", fields: ["ids"], call: (c, a) => c.todos.reorder({ ids: [a.todo] }) },
  { proc: "todos.remove", fields: ["id"], call: (c, a) => c.todos.remove({ id: a.todo }) },
  {
    proc: "todos.restore",
    fields: ["issueKey", "connectionId", "issueNoteId", "mailId"],
    call: (c, a) =>
      c.todos.restore({ text: "x", dueOn: null, done: false, position: 0, issueKey: a.key, connectionId: a.conn, commentId: null, commentExcerpt: null, issueNoteId: a.issueNote, mailId: a.mail }),
    expect: "noLeak",
  },
  { proc: "todos.startWork", fields: ["id"], call: (c, a) => c.todos.startWork({ id: a.todo }) },
  { proc: "todos.dismissReminder", fields: ["id"], call: (c, a) => c.todos.dismissReminder({ id: a.todo, today }) },

  // Estimates and the forecast
  { proc: "estimates.forTodo", fields: ["id"], call: (c, a) => c.estimates.forTodo({ id: a.todo }), expect: "noLeak", noOwner: "an estimate needs closed issues with history, none here; the TODO is read under the caller" },
  { proc: "estimates.workStatuses", fields: ["connectionId"], call: (c, a) => c.estimates.workStatuses({ connectionId: a.conn }) },
  { proc: "estimates.setWorkStatus", fields: ["connectionId"], call: (c, a) => c.estimates.setWorkStatus({ connectionId: a.conn, statusId: "1", counts: true }) },
  { proc: "forecast.finish", fields: ["bucketId"], call: (c, a) => c.forecast.finish({ issues: [], bucketId: a.bucket, scope: "active" }) },

  // Ideas
  { proc: "ideas.list", fields: ["containerId"], call: (c, a) => c.ideas.list({ containerId: a.container }), expect: "noLeak" },
  { proc: "ideas.get", fields: ["id"], call: (c, a) => c.ideas.get({ id: a.idea }) },
  { proc: "ideas.capture", fields: ["containerId"], call: (c, a) => c.ideas.capture({ text: "x", containerId: a.container }) },
  { proc: "ideas.update", fields: ["id"], call: (c, a) => c.ideas.update({ id: a.idea, title: "mine" }) },
  { proc: "ideas.update", fields: ["containerId"], call: (c, a, b) => c.ideas.update({ id: b.idea, containerId: a.container }) },
  { proc: "ideas.move", fields: ["id"], call: (c, a) => c.ideas.move({ id: a.idea, state: "ready", index: 0 }) },
  { proc: "ideas.reorder", fields: ["ids"], call: (c, a, b) => c.ideas.reorder({ state: "raw", ids: [b.idea, a.idea] }), expect: "noLeak" },
  { proc: "ideas.linkPromoted", fields: ["id"], call: (c, a) => c.ideas.linkPromoted({ id: a.idea, issueKey: a.key, connectionId: a.conn }) },
  { proc: "ideas.linkPromoted", fields: ["issueKey", "connectionId"], call: (c, a, b) => c.ideas.linkPromoted({ id: b.idea, issueKey: a.key, connectionId: a.conn }) },
  { proc: "ideas.handoff", fields: ["id"], call: (c, a) => c.ideas.handoff({ id: a.idea }) },
  { proc: "ideas.suggest", fields: ["id"], call: (c, a) => c.ideas.suggest({ id: a.idea }) },
  { proc: "ideas.askMail", fields: ["id"], call: (c, a) => c.ideas.askMail({ id: a.idea, to: "someone@example.com" }) },
  { proc: "ideas.remove", fields: ["id"], call: (c, a) => c.ideas.remove({ id: a.idea }) },
  { proc: "ideas.restore", fields: ["id"], call: (c, a) => c.ideas.restore({ id: a.deletedIdea }) },

  // Module storage: keys are the caller's own
  { proc: "modules.storageGet", fields: ["moduleId", "key"], call: (c, a) => c.modules.storageGet({ moduleId: "m1", key: a.moduleKey }), expect: "noLeak" },
  { proc: "modules.storageSet", fields: ["moduleId", "key"], call: (c, a) => c.modules.storageSet({ moduleId: "m1", key: a.moduleKey, value: "mine" }), expect: "noLeak" },
  { proc: "modules.storageSetIf", fields: ["moduleId", "key"], call: (c, a) => c.modules.storageSetIf({ moduleId: "m1", key: a.moduleKey, value: "mine", ifRevision: 0 }), expect: "noLeak" },
  { proc: "modules.storageDelete", fields: ["moduleId", "key"], call: (c, a) => c.modules.storageDelete({ moduleId: "m1", key: a.moduleKey }), expect: "noLeak" },
  { proc: "modules.fileGet", fields: ["moduleId", "key"], call: (c, a) => c.modules.fileGet({ moduleId: "m1", key: a.moduleFile }), expect: "noLeak" },
  { proc: "modules.filePut", fields: ["moduleId", "key"], call: (c, a) => c.modules.filePut({ moduleId: "m1", key: a.moduleFile, contentType: "image/png", data: btoa("png") }), expect: "noLeak" },
  { proc: "modules.fileDelete", fields: ["moduleId", "key"], call: (c, a) => c.modules.fileDelete({ moduleId: "m1", key: a.moduleFile }), expect: "noLeak" },
  { proc: "modules.setEnabled", fields: ["id"], call: (c) => c.modules.setEnabled({ id: "m1", enabled: false }), expect: "noLeak" },
  { proc: "modules.exportProgress", fields: ["id"], call: (c) => c.modules.exportProgress({ id: "m1" }), expect: "noLeak" },
  { proc: "modules.totals", fields: ["moduleId"], call: (c) => c.modules.totals({ moduleId: "m1" }), expect: "noLeak" },
  { proc: "modules.claimClosures", fields: ["moduleId"], call: (c) => c.modules.claimClosures({ moduleId: "m1" }), expect: "noLeak" },
  { proc: "modules.historyDaily", fields: ["moduleId"], call: (c) => c.modules.historyDaily({ moduleId: "m1" }), expect: "noLeak" },
  { proc: "modules.weather", fields: ["moduleId"], call: (c) => c.modules.weather({ moduleId: "m1", lat: 45, lon: 9 }), expect: "noLeak", noOwner: "asks a weather provider" },
  { proc: "modules.geocode", fields: ["moduleId"], call: (c) => c.modules.geocode({ moduleId: "m1", query: "x", language: "en" }), expect: "noLeak", noOwner: "asks a geocoding provider" },

  // Buckets, clients, saved searches, project paths
  { proc: "buckets.save", fields: ["id"], call: (c, a, b) => c.buckets.save({ id: a.bucket, name: "mine", sources: [{ connectionId: b.conn, containerId: null }] }) },
  { proc: "buckets.save", fields: ["sources[].connectionId", "sources[].containerId"], call: (c, a) => c.buckets.save({ name: "mine", sources: [{ connectionId: a.conn, containerId: a.container }] }), codes: ["BAD_REQUEST"] },
  { proc: "buckets.setBoardMode", fields: ["id"], call: (c, a) => c.buckets.setBoardMode({ id: a.bucket, mode: "lanes" }) },
  { proc: "buckets.reorder", fields: ["ids"], call: (c, a, b) => c.buckets.reorder({ ids: [b.bucket, a.bucket] }), expect: "noLeak" },
  { proc: "buckets.delete", fields: ["id"], call: (c, a) => c.buckets.delete({ id: a.bucket }) },
  { proc: "buckets.setActive", fields: ["id"], call: (c, a) => c.buckets.setActive({ id: a.bucket }) },
  { proc: "clients.save", fields: ["id"], call: (c, a) => c.clients.save({ id: a.client, name: "mine", containerIds: [] }) },
  { proc: "clients.save", fields: ["containerIds"], call: (c, a) => c.clients.save({ name: "mine " + a.n, containerIds: [a.container] }), codes: ["BAD_REQUEST"] },
  { proc: "clients.delete", fields: ["id"], call: (c, a) => c.clients.delete({ id: a.client }) },
  { proc: "queries.delete", fields: ["id"], call: (c, a) => c.queries.delete({ id: a.query }) },
  { proc: "projectPaths.save", fields: ["containerId"], call: (c, a) => c.projectPaths.save({ containerId: a.container, paths: [{ label: "x", path: "/tmp/x" }] }) },

  // Time sinks
  { proc: "sinks.targets", fields: ["id"], call: (c, a) => c.sinks.targets({ id: a.sink, query: "" }) },
  { proc: "sinks.activities", fields: ["id"], call: (c, a) => c.sinks.activities({ id: a.sink }) },
  { proc: "sinks.mappings", fields: ["id"], call: (c, a) => c.sinks.mappings({ id: a.sink }) },
  { proc: "sinks.map", fields: ["id"], call: (c, a) => c.sinks.map({ id: a.sink, containerId: null, target: { remoteId: "t", name: "t", path: [] }, activityId: null }) },
  { proc: "sinks.map", fields: ["containerId"], call: (c, a, b) => c.sinks.map({ id: b.sink, containerId: a.container, target: { remoteId: "t", name: "t", path: [] }, activityId: null }) },
  { proc: "sinks.unmap", fields: ["id"], call: (c, a) => c.sinks.unmap({ id: a.sink, containerId: a.container }) },
  { proc: "sinks.unmap", fields: ["containerId"], call: (c, a, b) => c.sinks.unmap({ id: b.sink, containerId: a.container }), expect: "noLeak", noOwner: "Bob's sink maps nothing to Ann's container: nothing to remove either way; her mapping, on her sink, stays (checked)" },
  { proc: "sinks.push", fields: ["id"], call: (c, a) => c.sinks.push({ id: a.sink }) },

  // Markdown notes
  { proc: "notes.get", fields: ["id"], call: (c, a) => c.notes.get({ id: a.note }) },
  { proc: "notes.forIssue", fields: ["connectionId", "issueKey"], call: (c, a) => c.notes.forIssue({ connectionId: a.conn, issueKey: a.key }) },
  { proc: "notes.forIssue", fields: ["issueKey"], call: (c, a) => c.notes.forIssue({ issueKey: a.key }), expect: "noLeak", name: "key alone", noOwner: "same as by connection" },
  { proc: "notes.search", fields: ["issue.connectionId", "issue.issueKey"], call: (c, a) => c.notes.search({ query: SECRET, filter: "all", limit: 30, issue: { connectionId: a.conn, issueKey: a.key } }) },
  { proc: "notes.create", fields: ["parentId"], call: (c, a) => c.notes.create({ title: "x", body: "", parentId: a.folder, issue: null }) },
  { proc: "notes.create", fields: ["issue.connectionId", "issue.issueKey"], call: (c, a) => c.notes.create({ title: "x", body: "", parentId: null, issue: { connectionId: a.conn, issueKey: a.key } }) },
  { proc: "notes.createFolder", fields: ["parentId"], call: (c, a) => c.notes.createFolder({ title: "x", parentId: a.folder }) },
  { proc: "notes.rename", fields: ["id"], call: (c, a) => c.notes.rename({ id: a.note, title: "mine", expectedRevision: 1 }) },
  { proc: "notes.setDate", fields: ["id"], call: (c, a) => c.notes.setDate({ id: a.note, notedOn: today }) },
  { proc: "notes.diaryPrompt", fields: ["folderId"], call: (c, a) => c.notes.diaryPrompt({ fromDay: today, toDay: today, from: "2026-10-23T00:00:00+02:00", to: "2026-10-24T00:00:00+02:00", mode: "summary", folderId: a.folder }), expect: "noLeak" },
  { proc: "notes.summarize", fields: ["folderId"], call: (c, a) => c.notes.summarize({ fromDay: today, toDay: today, from: "2026-10-23T00:00:00+02:00", to: "2026-10-24T00:00:00+02:00", mode: "summary", folderId: a.folder }), expect: "noLeak", noOwner: "needs the local model; reads the folder as diaryPrompt does" },
  { proc: "notes.tidy", fields: ["id"], call: (c, a) => c.notes.tidy({ id: a.note }) },
  { proc: "notes.setAi", fields: ["id"], call: (c, a) => c.notes.setAi({ id: a.note, markdown: "mine" }) },
  { proc: "notes.keepAi", fields: ["id"], call: (c, a) => c.notes.keepAi({ id: a.note, expectedRevision: 1 }) },
  { proc: "notes.discardAi", fields: ["id"], call: (c, a) => c.notes.discardAi({ id: a.note }) },
  { proc: "notes.convertToFolder", fields: ["id"], call: (c, a) => c.notes.convertToFolder({ id: a.note }) },
  { proc: "notes.updateContent", fields: ["id"], call: (c, a) => c.notes.updateContent({ id: a.note, title: "mine", body: "mine", expectedRevision: 1 }) },
  { proc: "notes.move", fields: ["id"], call: (c, a) => c.notes.move({ id: a.note, parentId: null, index: 0 }) },
  { proc: "notes.move", fields: ["parentId"], call: (c, a, b) => c.notes.move({ id: b.note, parentId: a.folder, index: 0 }) },
  { proc: "notes.setIssue", fields: ["id"], call: (c, a) => c.notes.setIssue({ id: a.note, issue: null }) },
  { proc: "notes.setIssue", fields: ["issue.connectionId", "issue.issueKey"], call: (c, a, b) => c.notes.setIssue({ id: b.note, issue: { connectionId: a.conn, issueKey: a.key } }) },
  { proc: "notes.remove", fields: ["id"], call: (c, a) => c.notes.remove({ id: a.note }) },
  { proc: "notes.restore", fields: ["batch"], call: (c, a) => c.notes.restore({ batch: a.batch, toRoot: false }) },
  { proc: "notes.versions", fields: ["id"], call: (c, a) => c.notes.versions({ id: a.note }) },
  { proc: "notes.saveVersion", fields: ["id"], call: (c, a) => c.notes.saveVersion({ id: a.note }) },
  { proc: "notes.deleteVersion", fields: ["id", "versionId"], call: (c, a) => c.notes.deleteVersion({ id: a.note, versionId: a.version }) },
  { proc: "notes.deleteVersion", fields: ["versionId"], call: (c, a, b) => c.notes.deleteVersion({ id: b.note, versionId: a.version }), noOwner: "a version is looked up under its note: the case by both is the control" },
  { proc: "notes.compactVersions", fields: ["id"], call: (c, a) => c.notes.compactVersions({ id: a.note }) },
  { proc: "notes.restoreVersion", fields: ["id", "versionId"], call: (c, a) => c.notes.restoreVersion({ id: a.note, versionId: a.version, expectedRevision: 1 }) },
  { proc: "notes.restoreVersion", fields: ["versionId"], call: (c, a, b) => c.notes.restoreVersion({ id: b.note, versionId: a.version, expectedRevision: 1 }), noOwner: "a version is looked up under its note: the case by both is the control" },

  // Mails
  { proc: "mails.copyInfo", fields: ["id"], call: (c, a) => c.mails.copyInfo({ id: a.mail }) },
  { proc: "mails.deleteCopy", fields: ["id"], call: (c, a) => c.mails.deleteCopy({ id: a.mail }) },
  { proc: "mails.retryCopy", fields: ["id"], call: (c, a) => c.mails.retryCopy({ id: a.mail }) },
  { proc: "mails.checkGone", fields: ["id"], call: (c, a) => c.mails.checkGone({ id: a.mail }) },
  { proc: "mails.update", fields: ["id"], call: (c, a) => c.mails.update({ id: a.mail, subject: "mine" }) },
  { proc: "mails.remove", fields: ["id"], call: (c, a) => c.mails.remove({ id: a.mail }) },
  {
    proc: "mails.save",
    fields: ["exchangeId"],
    name: "the same message as Ann's, saved by Bob",
    call: (c, a) => c.mails.save({ subject: "mine", internetMessageId: a.messageId, exchangeId: a.exchangeId, source: "addin" }),
    expect: "noLeak",
  },
  { proc: "mails.pinTo", fields: ["mail.id"], call: (c, a, b) => c.mails.pinTo({ mail: { id: a.mail }, to: { issueKey: b.key, connectionId: b.conn } }) },
  {
    proc: "mails.pinTo",
    fields: ["mail.internetMessageId", "mail.exchangeId"],
    call: (c, a, b) => c.mails.pinTo({ mail: { subject: "mine", internetMessageId: a.messageId, exchangeId: a.exchangeId, source: "addin" }, to: { issueKey: b.key, connectionId: b.conn } }),
    expect: "noLeak",
  },
  { proc: "mails.pinTo", fields: ["to.issueKey", "to.connectionId"], call: (c, a, b) => c.mails.pinTo({ mail: { id: b.mail }, to: { issueKey: a.key, connectionId: a.conn } }) },
  { proc: "mails.pinTo", fields: ["to.noteId"], call: (c, a, b) => c.mails.pinTo({ mail: { id: b.mail }, to: { noteId: a.note } }) },
  { proc: "mails.pinTo", fields: ["to.board.boardId"], call: (c, a, b) => c.mails.pinTo({ mail: { id: b.mail }, to: { board: { boardId: a.board } } }) },
  { proc: "mails.pin", fields: ["mailId"], call: (c, a, b) => c.mails.pin({ mailId: a.mail, to: { issueKey: b.key, connectionId: b.conn } }) },
  { proc: "mails.pin", fields: ["to.issueKey", "to.connectionId"], call: (c, a, b) => c.mails.pin({ mailId: b.mail, to: { issueKey: a.key, connectionId: a.conn } }) },
  { proc: "mails.pin", fields: ["to.noteId"], call: (c, a, b) => c.mails.pin({ mailId: b.mail, to: { noteId: a.note } }) },
  { proc: "mails.unpin", fields: ["mailId", "to.issueKey", "to.connectionId"], call: (c, a) => c.mails.unpin({ mailId: a.mail, to: { issueKey: a.key, connectionId: a.conn } }) },
  { proc: "mails.unpin", fields: ["to.noteId"], call: (c, a) => c.mails.unpin({ mailId: a.mail, to: { noteId: a.note } }) },
  { proc: "mails.unpin", fields: ["to.issueKey", "to.connectionId"], name: "Bob's mail", call: (c, a, b) => c.mails.unpin({ mailId: b.mail, to: { issueKey: a.key, connectionId: a.conn } }) },
  { proc: "mails.unpin", fields: ["to.noteId"], name: "Bob's mail", call: (c, a, b) => c.mails.unpin({ mailId: b.mail, to: { noteId: a.note } }), expect: "noLeak", noOwner: "Bob's mail is on no note: nothing to unpin either way; the case by Ann's mail is the control" },
  { proc: "mails.placesOf", fields: ["internetMessageId", "exchangeId"], call: (c, a) => c.mails.placesOf({ internetMessageId: a.messageId, exchangeId: a.exchangeId }), expect: "noLeak", sees: (v, a) => (json(v) ?? "").includes(a.key) },
  { proc: "mails.forNote", fields: ["noteId"], call: (c, a) => c.mails.forNote({ noteId: a.note }), expect: "noLeak" },

  // Planned entries
  { proc: "planned.create", fields: ["connectionId", "issueKey"], call: (c, a) => c.planned.create({ kind: "work", startsAt: "2026-10-22T09:00:00+02:00", endsAt: "2026-10-22T10:00:00+02:00", connectionId: a.conn, issueKey: a.key }) },
  { proc: "planned.update", fields: ["id"], call: (c, a) => c.planned.update({ id: a.planned, note: "mine" }) },
  { proc: "planned.update", fields: ["connectionId", "issueKey"], call: (c, a, b) => c.planned.update({ id: b.planned, kind: "work", connectionId: a.conn, issueKey: a.key }) },
  { proc: "planned.remove", fields: ["id"], call: (c, a) => c.planned.remove({ id: a.planned }) },
  { proc: "planned.convert", fields: ["id"], call: (c, a) => c.planned.convert({ id: a.planned }) },
];

// ---------------------------------------------------------------------------
// Checks around each call.

const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString("utf8") : x));

/** Every row of every table, as text. */
async function snapshot(): Promise<Map<string, string[]>> {
  const tables = await q<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1");
  const out = new Map<string, string[]>();
  for (const { t } of tables) out.set(t, (await q(`SELECT * FROM "${t}"`)).map(json));
  return out;
}

/** Tables a refused or empty answer may still write, with why. */
const MAY_CHANGE: Record<string, string> = {
  egress_hosts: "the outbound call log, not anyone's data",
  audit_events: "the audit log records every attempt, refused ones included (api/audit-coverage.test.ts)",
};

let bobConnections: number[] = [];

/** Ann's ids by the columns that point at them: none of Bob's rows may come to. */
const refsTo = (a: Ann): Record<string, unknown[]> => ({
  connection_id: [a.conn, a.sink, a.tempo],
  sink_connection_id: [a.sink],
  follow_connection_id: [a.conn],
  container_id: [a.container],
  item_id: [a.issue],
  bucket_id: [a.bucket],
  board_id: [a.board],
  todo_id: [a.todo],
  issue_note_id: [a.issueNote],
  mail_id: [a.mail],
  note_id: [a.note],
  parent_id: [a.folder, a.note],
  idea_id: [a.idea],
});

/** The rows that changed and aren't Bob's own, or are his but now point at Ann's. */
function changedNotBobs(before: Map<string, string[]>, after: Map<string, string[]>, refs: Record<string, unknown[]>): string[] {
  const out: string[] = [];
  for (const [t, rows] of after) {
    if (t in MAY_CHANGE) continue;
    const was = new Set(before.get(t) ?? []);
    const now = new Set(rows);
    const diff = [...rows.filter((r) => !was.has(r)), ...(before.get(t) ?? []).filter((r) => !now.has(r))];
    for (const r of diff) {
      const row = JSON.parse(r) as Row;
      const bobs = row.user_id === bobId || (!("user_id" in row) && [row.connection_id, row.sink_connection_id].some((c) => typeof c === "number" && bobConnections.includes(c)));
      const pointsAtAnn = Object.entries(refs).some(([col, ids]) => col in row && row[col] !== null && ids.includes(row[col]));
      if (bobs && !pointsAtAnn) continue;
      out.push(t + ": " + r);
    }
  }
  return out;
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
const run = (p: () => Promise<unknown>): Promise<Outcome> => p().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
const codeOf = (e: unknown) => (e && typeof e === "object" && "code" in e ? String(e.code) : String(e));
const isInputError = (e: unknown) => e instanceof Error && e.cause instanceof z.ZodError;

type Procedure = { _def: { inputs: unknown[]; middlewares: unknown[]; type?: string } };
const isProcedure = (p: unknown): p is Procedure =>
  typeof p === "function" && "_def" in p && typeof p._def === "object" && p._def !== null && "inputs" in p._def && Array.isArray(p._def.inputs) && "middlewares" in p._def && Array.isArray(p._def.middlewares);

/** A procedure by its path, as the router keeps it (its inputs and middlewares). */
async function procedureAt(at: string): Promise<Procedure> {
  const { appRouter } = await import("./router");
  const p: unknown = Reflect.get(appRouter._def.procedures, at);
  if (!isProcedure(p)) throw new Error("no procedure " + at);
  return p;
}

const label = (c: Case) => c.proc + " [" + (c.fields.join(", ") || "-") + "]" + (c.name ? " " + c.name : "");

// ---------------------------------------------------------------------------

beforeAll(async () => {
  await (await import("./queries/connection")).resetDbForTests();
  const grants = { permissions: JSON.stringify(["useModules"]), modules: JSON.stringify(["m1"]) };
  annId = (await one<{ id: number }>("INSERT INTO users (username, display_name, role, permissions, module_grants, created_at) VALUES ('ann', 'Ann', 'member', ?, ?, 1) RETURNING id", grants.permissions, grants.modules)).id;
  bobId = (await one<{ id: number }>("INSERT INTO users (username, display_name, role, permissions, module_grants, created_at) VALUES ('bob', 'Bob', 'member', ?, ?, 1) RETURNING id", grants.permissions, grants.modules)).id;
  const { appRouter } = await import("./router");
  const { getDb } = await import("./queries/connection");
  const { users } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  type User = typeof users.$inferSelect;
  callerOf = (user: Row) => appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: user as User, sessionId: null, deviceId: "dev-" + String(user.id) });
  const byId = async (id: number) => (await getDb().select().from(users).where(eq(users.id, id)))[0];
  bob = callerOf(await byId(bobId));
  b = await seedBob(bobId);
  bobConnections = [b.conn, b.sink, b.tempo];
});

describe("every id-taking procedure is classified", () => {
  it("each id field of each procedure is covered by a case, not a user's resource, or skipped with a reason", async () => {
    const unclassified: string[] = [];
    const known = new Set<string>();
    for (const proc of PROCEDURES) {
      const fields = new Set<string>();
      for (const input of (await procedureAt(proc))._def.inputs) fieldsOf(z.toJSONSchema(input as z.ZodType, { io: "input", unrepresentable: "any" }) as JsonSchema, "", fields);
      for (const f of fields) {
        if (!ID_FIELD.test(f)) continue;
        known.add(proc + " " + f);
        const leaf = f.slice(f.lastIndexOf(".") + 1);
        if (proc.split(".")[0] in SKIPPED_ROUTERS || proc in SKIPS || proc + " " + f in SKIPS || f in NOT_OWNED || leaf in NOT_OWNED) continue;
        if (CASES.some((c) => c.proc === proc && c.fields.includes(f))) continue;
        unclassified.push(proc + " " + f);
      }
    }
    expect(unclassified).toEqual([]);
    // Nothing listed that the inventory no longer has.
    const stale = [...CASES.flatMap((c) => c.fields.map((f) => c.proc + " " + f)), ...Object.keys(SKIPS).filter((k) => k.includes(" "))].filter((k) => !known.has(k));
    expect(stale).toEqual([]);
    expect([...CASES.map((c) => c.proc), ...Object.keys(SKIPS).map((k) => k.split(" ")[0])].filter((p) => !PROCEDURES.includes(p))).toEqual([]);
  });
});

describe("Bob never reaches Ann's things by id", () => {
  it.each(CASES.map((c) => [label(c), c] as const))("%s", async (_name, c) => {
    const a = await seedFor(annId, "ann");
    const before = await snapshot();
    fetched.length = 0;
    const out = await run(() => c.call(bob, a, b));
    if ((c.expect ?? "refused") === "refused") {
      expect.soft(out.ok ? "answered: " + json(out.value).slice(0, 300) : codeOf(out.error)).toBeOneOf(c.codes ?? ["NOT_FOUND", "FORBIDDEN"]);
    } else if (out.ok) {
      expect.soft(json(out.value) ?? "").not.toContain(SECRET);
      if (c.sees) expect.soft(c.sees(out.value, a), "answered: " + (json(out.value) ?? "").slice(0, 300)).toBe(false);
    } else {
      expect.soft(String((out.error as Error).message)).not.toContain(SECRET);
    }
    expect.soft(changedNotBobs(before, await snapshot(), refsTo(a))).toEqual([]);
    expect.soft(fetched.filter((u) => !u.includes(BOB_HOST))).toEqual([]);
  });
});

describe("the owner reaches his own (the refusals above are about the owner)", () => {
  // A fresh account calls the same cases on rows seeded for it: they get past
  // every check. Where Bob was only to find nothing of Ann's (noLeak), the
  // owner must find his own (in the answer, a changed row, or a call to his tracker).
  it.each(CASES.filter((c) => !c.noOwner).map((c) => [label(c), c] as const))("%s", async (_name, c) => {
    const owner = await account("member", ["useModules"], { modules: ["m1"] });
    const mine = await seedBob(owner.id, "owner" + owner.id);
    const own = await seedFor(owner.id, "bob");
    const before = await snapshot();
    fetched.length = 0;
    const out = await run(() => c.call(owner.caller, own, mine));
    if (!out.ok) {
      expect(codeOf(out.error), String((out.error as Error).message)).not.toMatch(/^(NOT_FOUND|FORBIDDEN|UNAUTHORIZED)$/);
      expect(isInputError(out.error), String((out.error as Error).message)).toBe(false);
    }
    if (c.expect === "noLeak") {
      const answered = out.ok && (c.sees ? c.sees(out.value, own) : (json(out.value) ?? "").includes(OWN));
      const changed = [...(await snapshot())].some(([t, rows]) => !(t in MAY_CHANGE) && json(rows) !== json(before.get(t)));
      expect(answered || changed || fetched.length > 0, out.ok ? "answered: " + (json(out.value) ?? "").slice(0, 300) : String((out.error as Error).message)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Server-wide powers (permProcedure): who may call what, by permission.

type Permission = import("@contracts/accounts").Permission;

/** Every procedure behind a permission, with it (contracts/accounts.ts: an admin has them all). */
const PERMISSION_OF: Record<string, Permission> = {
  "info.addHosts": "manageServer",
  "info.setAccess": "manageServer",
  "egress.list": "manageServer",
  "alerts.summary": "manageServer",
  "alerts.webhook": "manageServer",
  "alerts.setWebhook": "manageServer",
  "alerts.test": "manageServer",
  "backup.get": "runBackups",
  "backup.update": "runBackups",
  "backup.run": "runBackups",
  "backup.restore": "restoreBackups",
  "store.catalog": "manageStore",
  "store.requestLicense": "manageStore",
  "store.checkout": "manageStore",
  "store.claimPaid": "manageStore",
  "store.pending": "manageStore",
  "store.install": "manageStore",
  "store.restoreLicense": "manageStore",
  "store.dismiss": "manageStore",
  "modules.activation": "manageStore",
  "modules.activate": "manageStore",
  "modules.deactivate": "manageStore",
  "modules.offlineCode": "manageStore",
  "modules.acceptToken": "manageStore",
  "modules.exportLicense": "manageStore",
  "modules.removeLicense": "manageStore",
  "modules.uninstall": "manageStore",
  "modules.setEnabled": "useModules",
  "modules.exportProgress": "useModules",
  "modules.importProgress": "useModules",
  "modules.storageGet": "useModules",
  "modules.storageSet": "useModules",
  "modules.storageSetIf": "useModules",
  "modules.storageDelete": "useModules",
  "modules.fileGet": "useModules",
  "modules.filePut": "useModules",
  "modules.fileDelete": "useModules",
  "modules.weather": "useModules",
  "modules.geocode": "useModules",
  "modules.totals": "useModules",
  "modules.claimClosures": "useModules",
  "modules.historyDaily": "useModules",
  "users.list": "manageUsers",
  "users.invite": "manageUsers",
  "users.reinvite": "manageUsers",
  "users.setAccess": "manageUsers",
  "users.rename": "manageUsers",
  "users.resetPassword": "manageUsers",
  "users.setDisabled": "manageUsers",
  "users.setBreakGlass": "manageAuth",
  "sso.list": "manageAuth",
  "sso.testResult": "manageAuth",
  "sso.createProvider": "manageAuth",
  "sso.updateProvider": "manageAuth",
  "sso.removeProvider": "manageAuth",
  "sso.setEnforced": "manageAuth",
  "sso.createScimToken": "manageAuth",
  "sso.revokeScimToken": "manageAuth",
  "team.overview": "viewTeamTime",
  "team.person": "viewTeamTime",
  "team.day": "viewTeamTime",
  "audit.list": "viewAudit",
  "audit.verify": "viewAudit",
  "audit.settings": "viewAudit",
  "audit.setRetention": "manageRetention",
  "roles.list": "manageUsers",
  "roles.create": "manageUsers",
  "roles.update": "manageUsers",
  "roles.remove": "manageUsers",
  "teams.list": "manageTeams",
  "teams.create": "manageTeams",
  "teams.rename": "manageTeams",
  "teams.remove": "manageTeams",
  "teams.setMember": "manageTeams",
  "teams.removeMember": "manageTeams",
};
/** Open to anyone (signing in, the session itself). */
const PUBLIC = ["ping", "auth.login", "auth.activate", "auth.invite", "auth.acceptInvite", "auth.remembered", "auth.resume", "auth.forget", "auth.me", "auth.logout", "sso.loginOptions"];
/** Signed in, even before the password the account must change is changed. */
const SIGNED_IN = ["auth.changePassword"];

/** Fails every input schema: a call that gets past the gates stops at the parser, before the handler. */
const NOT_AN_INPUT = "not an input";

/** Calls a procedure by its path. */
async function callAt(c: Caller, at: string, input: unknown): Promise<unknown> {
  let fn: unknown = c;
  for (const k of at.split(".")) {
    if (typeof fn !== "function" && (typeof fn !== "object" || fn === null)) throw new Error("no procedure " + at);
    fn = Reflect.get(fn, k);
  }
  if (typeof fn !== "function") throw new Error("no procedure " + at);
  const out: unknown = await Reflect.apply(fn, undefined, [input]);
  return out;
}

/** How many middlewares a procedure builder runs before its own. */
function layers(builder: unknown): number {
  const def: unknown = builder && typeof builder === "object" ? Reflect.get(builder, "_def") : undefined;
  const mw: unknown = def && typeof def === "object" ? Reflect.get(def, "middlewares") : undefined;
  if (!Array.isArray(mw)) throw new Error("not a procedure builder");
  return mw.length;
}

let users = 0;
/** A member (or admin) with exactly these permissions. */
async function account(role: "admin" | "member", permissions: readonly Permission[], extra: { mustChangePassword?: boolean; modules?: string[] } = {}): Promise<{ id: number; caller: Caller }> {
  const row = await one<Row & { id: number }>(
    "INSERT INTO users (username, display_name, role, permissions, module_grants, must_change_password, created_at) VALUES (?, 'Someone', ?, ?, ?, ?, 1) RETURNING *",
    "user" + ++users,
    role,
    JSON.stringify(permissions),
    JSON.stringify(extra.modules ?? []),
    extra.mustChangePassword ? 1 : 0,
  );
  const { getDb } = await import("./queries/connection");
  const { users: table } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const [user] = await getDb().select().from(table).where(eq(table.id, row.id));
  return { id: row.id, caller: callerOf(user) };
}

const anonymous = async (): Promise<Caller> => {
  const { appRouter } = await import("./router");
  return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: null, sessionId: null, deviceId: "dev-anon" });
};

describe("server-wide powers need their permission", () => {
  const PERMS = [...new Set(Object.values(PERMISSION_OF))];

  it("the gates read from the code match the lists here: public, signed in, protected, by permission", async () => {
    const { publicQuery, signedInProcedure, protectedProcedure } = await import("./middleware");
    const [open, signedIn, protectedBase] = [layers(publicQuery), layers(signedInProcedure), layers(protectedProcedure)];
    // What a built procedure adds to its builder's middlewares, read off ping (publicQuery, no input).
    const built = (await procedureAt("ping"))._def.middlewares.length - open;
    const found = { public: [] as string[], signedIn: [] as string[], permission: [] as string[] };
    for (const proc of PROCEDURES) {
      const p = await procedureAt(proc);
      const own = p._def.middlewares.length - p._def.inputs.length - built;
      if (own === open) found.public.push(proc);
      else if (own === signedIn) found.signedIn.push(proc);
      else if (own > protectedBase) found.permission.push(proc);
    }
    expect(found.public.sort()).toEqual([...PUBLIC].sort());
    expect(found.signedIn).toEqual(SIGNED_IN);
    expect(found.permission.sort()).toEqual(Object.keys(PERMISSION_OF).sort());
  });

  it("nobody signed out reaches anything but signing in", async () => {
    const c = await anonymous();
    for (const proc of PROCEDURES.filter((p) => !PUBLIC.includes(p))) {
      const out = await run(() => callAt(c, proc, NOT_AN_INPUT));
      expect.soft(out.ok ? "answered" : codeOf(out.error), proc).toBe("UNAUTHORIZED");
    }
  });

  it("an account that must change its password reaches nothing else", async () => {
    const { PASSWORD_CHANGE_REQUIRED } = await import("./middleware");
    const { caller } = await account("admin", [], { mustChangePassword: true });
    for (const proc of PROCEDURES.filter((p) => !PUBLIC.includes(p) && !SIGNED_IN.includes(p))) {
      const out = await run(() => callAt(caller, proc, NOT_AN_INPUT));
      expect.soft(out.ok ? "answered" : codeOf(out.error) + " " + String((out.error as Error).message), proc).toBe("FORBIDDEN " + PASSWORD_CHANGE_REQUIRED);
    }
  });

  it("a member without the permission is refused, whatever else it holds", async () => {
    const none = await account("member", []);
    for (const proc of Object.keys(PERMISSION_OF)) {
      const out = await run(() => callAt(none.caller, proc, NOT_AN_INPUT));
      expect.soft(out.ok ? "answered" : codeOf(out.error), proc + " with no permission").toBe("FORBIDDEN");
    }
    for (const perm of PERMS) {
      const allBut = await account("member", PERMS.filter((p) => p !== perm));
      for (const proc of Object.keys(PERMISSION_OF).filter((p) => PERMISSION_OF[p] === perm)) {
        const out = await run(() => callAt(allBut.caller, proc, NOT_AN_INPUT));
        expect.soft(out.ok ? "answered" : codeOf(out.error), proc + " with all but " + perm).toBe("FORBIDDEN");
      }
    }
  });

  it("the permission alone opens its procedures (stopped at the input, never run)", async () => {
    for (const perm of PERMS) {
      const only = await account("member", [perm]);
      for (const proc of Object.keys(PERMISSION_OF).filter((p) => PERMISSION_OF[p] === perm)) {
        // Without an input there is nothing to stop the handler: never run with the power.
        if ((await procedureAt(proc))._def.inputs.length === 0) continue;
        const out = await run(() => callAt(only.caller, proc, NOT_AN_INPUT));
        expect.soft(out.ok ? "answered" : codeOf(out.error), proc + " with " + perm).toBe("BAD_REQUEST");
      }
    }
  });

  it("a module runs only for the accounts it is granted to", async () => {
    const { caller } = await account("member", ["useModules"]);
    await expect(caller.modules.storageGet({ moduleId: "m1", key: "k1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("restoring a backup takes an owner, not only restoreBackups", async () => {
    const { caller } = await account("member", ["restoreBackups"]);
    await expect(caller.backup.restore({ name: "backup.dump" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a member managing accounts never makes or touches an admin, nor hands out a power it lacks", async () => {
    const mia = await account("member", ["manageUsers"]);
    const root = await account("admin", []);
    const tom = await account("member", []);
    const before = await q("SELECT id, username, role, permissions, module_grants, disabled_at, password_hash, must_change_password FROM users ORDER BY id");
    for (const [what, call] of [
      ["invite an admin", () => mia.caller.users.invite({ role: "admin", permissions: [], modules: [], username: "boss", displayName: "Boss" })],
      ["invite with a power it lacks", () => mia.caller.users.invite({ role: "member", permissions: ["manageServer"], modules: [], username: "ops", displayName: "Ops" })],
      ["promote a member to admin", () => mia.caller.users.setAccess({ id: tom.id, role: "admin", permissions: [], modules: [] })],
      ["grant a power it lacks", () => mia.caller.users.setAccess({ id: tom.id, role: "member", permissions: ["runBackups"], modules: [] })],
      ["grant a module it doesn't run", () => mia.caller.users.setAccess({ id: tom.id, role: "member", permissions: [], modules: ["m1"] })],
      ["change an admin's access", () => mia.caller.users.setAccess({ id: root.id, role: "member", permissions: [], modules: [] })],
      ["rename an admin", () => mia.caller.users.rename({ id: root.id, displayName: "x", username: "x" })],
      ["reset an admin's password", () => mia.caller.users.resetPassword({ id: root.id })],
      ["re-invite an admin", () => mia.caller.users.reinvite({ id: root.id })],
      ["turn an admin off", () => mia.caller.users.setDisabled({ id: root.id, disabled: true })],
    ] as const) {
      await expect.soft(call(), what).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(mia.caller.users.setAccess({ id: mia.id, role: "admin", permissions: [], modules: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await q("SELECT id, username, role, permissions, module_grants, disabled_at, password_hash, must_change_password FROM users ORDER BY id")).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Roles × procedures: who may call what, by system role (E3). The table is a snapshot:
// a change of who may do what shows up in review as a change of it.

describe("each system role reaches what its permissions hold", () => {
  /** An account holding a system role: as its own role, or (team-lead) within a team it leads. */
  async function roled(key: string): Promise<{ id: number; caller: Caller }> {
    const [role] = await q<{ id: number; scope: string }>("SELECT id, scope FROM roles WHERE key = ?", key);
    const row = await one<{ id: number }>(
      "INSERT INTO users (username, display_name, role, role_id, permissions, created_at) VALUES (?, 'Someone', ?, ?, '[]', 1) RETURNING id",
      "role" + ++users,
      key === "owner" ? "admin" : "member",
      role.scope === "server" ? role.id : null,
    );
    if (role.scope === "team") {
      const team = await one<{ id: number }>("INSERT INTO teams (name, created_at) VALUES (?, 1) RETURNING id", "team" + users);
      await q("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'lead')", team.id, row.id);
      await q("INSERT INTO role_assignments (user_id, role_id, team_id) VALUES (?, ?, ?)", row.id, role.id, team.id);
    }
    const { getDb } = await import("./queries/connection");
    const { users: table } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(table).where(eq(table.id, row.id));
    return { id: row.id, caller: callerOf(user) };
  }

  it("matches the checked-in allow/deny table", async () => {
    const { SYSTEM_ROLES } = await import("@contracts/accounts");
    const { holds, withAccess, userById } = await import("./queries/accounts");
    const table: Record<string, Record<string, "allow" | "deny">> = {};
    for (const key of SYSTEM_ROLES) {
      const who = await roled(key);
      const found = await userById(who.id);
      if (!found) throw new Error("no account " + key);
      const account = await withAccess(found);
      for (const proc of Object.keys(PERMISSION_OF).sort()) {
        const p = await procedureAt(proc);
        let cell: "allow" | "deny";
        if (p._def.inputs.length === 0 && p._def.type === "mutation") {
          // Never run a mutation with no input to stop it: read off the resolver the gate uses.
          cell = holds(account, PERMISSION_OF[proc]) ? "allow" : "deny";
        } else {
          const out = await run(() => callAt(who.caller, proc, p._def.inputs.length === 0 ? undefined : NOT_AN_INPUT));
          cell = !out.ok && codeOf(out.error) === "FORBIDDEN" ? "deny" : "allow";
        }
        (table[proc] ??= {})[key] = cell;
      }
    }
    expect(table).toMatchSnapshot();
    // The ones the plan names, whatever the snapshot says.
    expect(table["team.overview"]["it-admin"]).toBe("deny");
    expect(table["backup.restore"]["it-admin"]).toBe("deny");
    expect(table["team.overview"]["team-lead"]).toBe("allow");
    expect(table["audit.list"].auditor).toBe("allow");
    expect(Object.values(table).every((r) => r.member === "deny")).toBe(true);
    expect(Object.values(table).every((r) => r.owner === "allow")).toBe(true);
  });

  it("an IT admin can't hand itself or anyone a role or power beyond its own", async () => {
    const it_ = await roled("it-admin");
    const tom = await account("member", []);
    const [owner] = await q<{ id: number }>("SELECT id FROM roles WHERE key = 'owner'");
    const [lead] = await q<{ id: number }>("SELECT id FROM roles WHERE key = 'team-lead'");
    const team = await one<{ id: number }>("INSERT INTO teams (name, created_at) VALUES ('escalation', 1) RETURNING id");
    const before = await q("SELECT id, role, role_id, permissions FROM users ORDER BY id");
    for (const [what, call] of [
      ["make someone owner", () => it_.caller.users.setAccess({ id: tom.id, roleId: owner.id, permissions: [], modules: [] })],
      ["give team time", () => it_.caller.users.setAccess({ id: tom.id, permissions: ["viewTeamTime"], modules: [] })],
      ["give a backup download", () => it_.caller.users.setAccess({ id: tom.id, permissions: ["downloadBackups"], modules: [] })],
      ["make someone a team's lead", () => it_.caller.users.setAccess({ id: tom.id, permissions: [], modules: [], teams: [{ teamId: team.id, lead: true }] })],
      ["make a lead through Teams", () => it_.caller.teams.setMember({ teamId: team.id, userId: tom.id, role: "lead" })],
      ["give another account manager", () => it_.caller.users.setAccess({ id: tom.id, permissions: ["manageUsers"], modules: [] })],
      ["a role with team time", () => it_.caller.roles.create({ key: "peeker", name: "Peeker", permissions: ["viewTeamTime"] })],
      ["a role managing users", () => it_.caller.roles.create({ key: "keeper", name: "Keeper", permissions: ["manageUsers"] })],
      ["the team-lead role as an account's own", () => it_.caller.users.setAccess({ id: tom.id, roleId: lead.id, permissions: [], modules: [] })],
    ] as const) {
      await expect.soft(call(), what).rejects.toMatchObject({ code: expect.stringMatching(/^(FORBIDDEN|BAD_REQUEST)$/) });
    }
    expect(await q("SELECT id, role, role_id, permissions FROM users ORDER BY id")).toEqual(before);
    expect(await q("SELECT * FROM role_assignments WHERE team_id = ?", team.id)).toEqual([]);
  });

  it("only an owner edits a role holding manageUsers or manageAuth; system roles stay as seeded", async () => {
    const root = await roled("owner");
    const it_ = await roled("it-admin");
    const made = await root.caller.roles.create({ key: "helpdesk", name: "Helpdesk", permissions: ["manageUsers"] });
    await expect(it_.caller.roles.update({ id: made.id, name: "Helpdesk", permissions: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(it_.caller.roles.remove({ id: made.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [system] = await q<{ id: number }>("SELECT id FROM roles WHERE key = 'auditor'");
    await expect(root.caller.roles.update({ id: system.id, name: "x", permissions: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Within its own powers, an IT admin makes and edits roles.
    const ops = await it_.caller.roles.create({ key: "ops", name: "Ops", permissions: ["manageServer"] });
    await expect(it_.caller.roles.update({ id: ops.id, name: "Ops", permissions: ["manageServer", "runBackups"] })).resolves.toMatchObject({ permissions: ["manageServer", "runBackups"] });
  });
});
