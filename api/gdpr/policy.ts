// What a person's data is, table by table: which rows are theirs (their user_id, or a parent
// row that is), what an export (users.exportData) takes of them, and how an erasure
// (users.erase) removes them. Every table in db/schema.ts is listed: api/gdpr/gdpr.test.ts
// fails on a new table, or a new user or connection reference, until it is placed here.
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable, type PgColumn } from "drizzle-orm/pg-core";
import * as schema from "@db/schema";

/** Exported, but never these columns (secrets, sealed bytes, hashes); csv: also as a CSV file. */
export type Exported = { omit?: readonly string[]; csv?: boolean };
/** Not exported, with why. */
export type Skipped = { skip: string };

export type TablePolicy =
  /** Rows keyed by user_id: exported as the person's, deleted by an erasure (before connections). */
  | { kind: "user"; export: Exported | Skipped }
  /** Rows of a parent row the person owns (`via` points at `parent`.id): they go with it (cascade). */
  | { kind: "child"; parent: string; via: string; export: Exported | Skipped }
  /** users, connections, audit_events: the export and the erasure handle them on their own. */
  | { kind: "special"; reason: string }
  /** The server's, nobody's own. */
  | { kind: "global"; reason: string };

const all: Exported = {};
const csv: Exported = { csv: true };
const skip = (reason: string): Skipped => ({ skip: reason });

export const USER_DATA: Record<string, TablePolicy> = {
  // Handled on their own
  users: { kind: "special", reason: "the account: account.json (no password hash); deleted last" },
  connections: { kind: "special", reason: "connections.json without secrets; archived first, deleted after their rows" },
  audit_events: { kind: "special", reason: "events by or about the person (audit_events.json); pseudonymised, never deleted" },

  // The server's own
  roles: { kind: "global", reason: "the server's roles (the person's are in role_assignments)" },
  teams: { kind: "global", reason: "the server's teams (the person's places are in team_members)" },
  server_settings: { kind: "global", reason: "server configuration" },
  server_hosts: { kind: "global", reason: "the server's own host names" },
  egress_hosts: { kind: "global", reason: "outbound call counts per host, no person" },

  // Access
  team_members: { kind: "user", export: all },
  role_assignments: { kind: "user", export: all },
  invites: { kind: "user", export: skip("one-time invite links (hashed)") },
  sessions: { kind: "user", export: skip("sign-in sessions (hashed ids)") },
  remembered_devices: { kind: "user", export: skip("remembered-device tokens (hashed)") },
  settings: { kind: "user", export: all },
  device_prefs: { kind: "user", export: all },
  estimate_revisions: { kind: "user", export: all },

  // Trackers and their items
  containers: { kind: "child", parent: "connections", via: "connection_id", export: all },
  container_paths: { kind: "user", export: all },
  connection_sync: { kind: "child", parent: "connections", via: "connection_id", export: skip("sync checkpoints and leases, no content") },
  webhook_deliveries: { kind: "child", parent: "connections", via: "connection_id", export: skip("webhook intake ids, kept two days") },
  status_snapshots: { kind: "child", parent: "connections", via: "connection_id", export: skip("the tracker's status list") },
  sink_mappings: { kind: "child", parent: "connections", via: "sink_connection_id", export: all },
  activity: { kind: "child", parent: "connections", via: "connection_id", export: skip("the tracker's own issue history, synced from it") },
  issues: { kind: "user", export: all },
  item_aliases: { kind: "child", parent: "issues", via: "item_id", export: skip("the tracker's former issue keys") },
  issue_status_changes: { kind: "child", parent: "issues", via: "item_id", export: skip("the tracker's status history, synced from it") },
  issue_history_reads: { kind: "user", export: all },
  issue_closures: { kind: "user", export: all },
  work_statuses: { kind: "user", export: all },
  sync_state: { kind: "user", export: all },

  // Time
  worklogs: { kind: "user", export: csv },
  worklog_trash: { kind: "user", export: csv },
  worklog_sinks: { kind: "child", parent: "worklogs", via: "worklog_id", export: all },
  outbox: { kind: "user", export: all },
  timers: { kind: "user", export: csv },
  timer_runs: { kind: "user", export: csv },
  timer_shares: { kind: "user", export: all },
  timer_ops: { kind: "user", export: skip("idempotency keys of timer actions, kept briefly") },
  planned_entries: { kind: "user", export: csv },
  week_locks: { kind: "user", export: all },
  work_schedules: { kind: "user", export: all },
  work_day_overrides: { kind: "user", export: all },
  write_leases: { kind: "user", export: skip("a short lease on writing time, no content") },
  clients: { kind: "user", export: all },
  client_containers: { kind: "child", parent: "clients", via: "client_id", export: all },

  // Notes, to-dos, ideas, mail
  issue_notes: { kind: "user", export: all },
  markdown_notes: { kind: "user", export: all },
  markdown_note_versions: { kind: "user", export: all },
  todos: { kind: "user", export: csv },
  todo_sessions: { kind: "user", export: all },
  ideas: { kind: "user", export: all },
  idea_files: { kind: "user", export: { omit: ["data"] } },
  pinboards: { kind: "user", export: all },
  pinboard_notes: { kind: "user", export: all },
  mails: { kind: "user", export: all },
  mail_copies: { kind: "user", export: { omit: ["sealed", "plain_sha256"] } },
  mail_copy_reads: { kind: "user", export: all },
  mail_links: { kind: "user", export: all },
  mail_accounts: { kind: "user", export: { omit: ["secret"] } },
  mail_addin_keys: { kind: "user", export: skip("Outlook add-in keys (hashed)") },
  notifications: { kind: "user", export: all },
  decisions: { kind: "user", export: all },

  // Views and layout
  buckets: { kind: "user", export: all },
  bucket_columns: { kind: "child", parent: "buckets", via: "bucket_id", export: all },
  bucket_sources: { kind: "child", parent: "buckets", via: "bucket_id", export: all },
  saved_queries: { kind: "user", export: all },
  recent_queries: { kind: "user", export: all },
  desks: { kind: "user", export: all },

  // Modules
  module_storage: { kind: "user", export: all },
  module_files: { kind: "user", export: { omit: ["data"] } },
  module_closure_claims: { kind: "user", export: all },

  // Workspace (layout editor and flow analysis)
  workspace_revisions: { kind: "user", export: all },
  workspace_drafts: { kind: "user", export: all },
  workspace_descriptors: { kind: "user", export: all },
  workspace_prepared: { kind: "user", export: all },
  workspace_presentations: { kind: "user", export: all },
  workspace_operations: { kind: "user", export: all },
  workspace_discovery: { kind: "user", export: all },
  workspace_flow_settings: { kind: "user", export: all },
  workspace_flow_events: { kind: "user", export: all },
  workspace_flow_aggregates: { kind: "user", export: all },
  workspace_flow_imports: { kind: "user", export: all },
  workspace_flow_feedback: { kind: "user", export: all },
  workspace_planner_feedback: { kind: "user", export: all },
  workspace_imports: { kind: "user", export: all },
};

/** Columns whose name says they may hold a secret: an exported table must omit each one. */
export const SECRET_LIKE = /secret|token|password|sealed|cipher|credential|(^|_)hash$|^data$|sha256/;

/** Every table of db/schema.ts by its SQL name. */
export const TABLES: ReadonlyMap<string, PgTable> = new Map(
  (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable)).map((t) => [getTableName(t), t]),
);

export function tableOf(name: string): PgTable {
  const t = TABLES.get(name);
  if (!t) throw new Error(`gdpr: no table ${name}`);
  return t;
}

/** A table's column by its SQL name, with the key its rows come back under. */
export function columnOf(table: PgTable, name: string): { key: string; column: PgColumn } {
  const found = Object.entries(getTableColumns(table)).find(([, c]) => c.name === name);
  if (!found) throw new Error(`gdpr: no column ${getTableName(table)}.${name}`);
  return { key: found[0], column: found[1] };
}

export const isSkipped = (e: Exported | Skipped): e is Skipped => "skip" in e;
