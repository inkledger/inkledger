-- 0000_baseline
-- Substring search on titles and keys (contracts/query.ts); pg_trgm ships with Postgres.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "bucket_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"bucket_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"container_id" integer
);
--> statement-breakpoint
CREATE TABLE "buckets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_sync" (
	"connection_id" integer NOT NULL,
	"stream" text NOT NULL,
	"checkpoint" text,
	"lease_owner" text,
	"lease_until" bigint,
	"retry_after" bigint,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_ok_at" bigint,
	"last_full_at" bigint,
	"last_error" text,
	"last_error_at" bigint,
	CONSTRAINT "connection_sync_connection_id_stream_pk" PRIMARY KEY("connection_id","stream")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"base_url" text NOT NULL,
	"remote_account_id" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"avatar_url" text,
	"options" text DEFAULT '{}' NOT NULL,
	"encrypted_secret" text NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"probe" text,
	"probed_at" bigint,
	"legacy" integer DEFAULT 0 NOT NULL,
	"archived_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "containers" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" integer NOT NULL,
	"remote_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'project' NOT NULL,
	"parent_id" integer,
	"avatar_url" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_prefs" (
	"user_id" integer NOT NULL,
	"device_id" text NOT NULL,
	"bucket_id" integer,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "device_prefs_user_id_device_id_pk" PRIMARY KEY("user_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"created_by" integer,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"item_id" integer,
	"issue_key" text NOT NULL,
	"body" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"container_id" integer,
	"jira_id" text NOT NULL,
	"key" text NOT NULL,
	"summary" text NOT NULL,
	"status" text NOT NULL,
	"status_category" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'todo' NOT NULL,
	"priority_rank" integer,
	"project_key" text NOT NULL,
	"project_name" text NOT NULL,
	"issue_type" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT '' NOT NULL,
	"labels" text DEFAULT '[]' NOT NULL,
	"assignee_id" text DEFAULT '' NOT NULL,
	"assignee_name" text,
	"reporter_name" text,
	"favorite" integer DEFAULT 0 NOT NULL,
	"favorite_rank" integer DEFAULT 0 NOT NULL,
	"hidden" integer DEFAULT 0 NOT NULL,
	"watching" integer DEFAULT 0 NOT NULL,
	"time_estimate_seconds" integer,
	"time_spent_seconds" integer,
	"due_date" text,
	"jira_updated" text,
	"jira_updated_at" bigint,
	"jira_created_at" bigint,
	"status_changed_at" bigint,
	"last_comment_at" bigint,
	"activity_at" bigint,
	"others_activity_at" bigint,
	"seen_at" bigint,
	"project_avatar_url" text,
	"url" text NOT NULL,
	"gone_at" bigint,
	"gone_reason" text,
	"synced_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"key" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "module_files" (
	"user_id" integer NOT NULL,
	"module_id" text NOT NULL,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"updated_at" bigint NOT NULL,
	"used_at" bigint NOT NULL,
	CONSTRAINT "module_files_user_id_module_id_key_pk" PRIMARY KEY("user_id","module_id","key")
);
--> statement-breakpoint
CREATE TABLE "module_storage" (
	"user_id" integer NOT NULL,
	"module_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "module_storage_user_id_module_id_key_pk" PRIMARY KEY("user_id","module_id","key")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"item_id" integer,
	"kind" text NOT NULL,
	"issue_key" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"dedupe" text NOT NULL,
	"created_at" bigint NOT NULL,
	"dismissed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"item_id" integer,
	"kind" text NOT NULL,
	"issue_key" text NOT NULL,
	"jira_worklog_id" text DEFAULT '' NOT NULL,
	"worklog_id" integer,
	"time_spent_seconds" integer DEFAULT 0 NOT NULL,
	"started" bigint,
	"comment" text DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"claimed_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pinboard_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"board_id" integer,
	"connection_id" integer,
	"item_id" integer,
	"issue_key" text,
	"issue_note_id" integer,
	"note" text DEFAULT '' NOT NULL,
	"color" text DEFAULT 'yellow' NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"rotation" double precision DEFAULT 0 NOT NULL,
	"z" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pinboards" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remembered_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_used_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_hosts" (
	"host" text PRIMARY KEY NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"daily_target_seconds" integer DEFAULT 28800 NOT NULL,
	"weekly_target_seconds" integer DEFAULT 144000 NOT NULL,
	"timer_alert_minutes" integer DEFAULT 120 NOT NULL,
	"notify_enabled" integer DEFAULT 1 NOT NULL,
	"dashboard_layout" text DEFAULT '' NOT NULL,
	"theme_color" text DEFAULT '#B5562F' NOT NULL,
	"idle_minutes" integer DEFAULT 10 NOT NULL,
	"board_collapsed" text DEFAULT '[]' NOT NULL,
	"allowed_link_domains" text DEFAULT '[]' NOT NULL,
	"backdrop_visibility" text DEFAULT 'normal' NOT NULL,
	"overlap_policy" text DEFAULT 'warn' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"last_sync_at" bigint,
	"last_error" text,
	"last_error_at" bigint,
	"last_full_sync_at" bigint,
	"last_worklog_sync_at" bigint
);
--> statement-breakpoint
CREATE TABLE "timers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"item_id" integer,
	"issue_key" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"started_at" bigint NOT NULL,
	"accumulated_seconds" integer DEFAULT 0 NOT NULL,
	"paused_at" bigint,
	"note" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_url" text,
	"deployment" text DEFAULT 'cloud' NOT NULL,
	"auth_type" text DEFAULT 'basic' NOT NULL,
	"account_id" text,
	"email" text DEFAULT '' NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"encrypted_token" text,
	"username" text,
	"password_hash" text,
	"role" text DEFAULT 'member' NOT NULL,
	"permissions" text DEFAULT '[]' NOT NULL,
	"must_change_password" integer DEFAULT 0 NOT NULL,
	"disabled_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "week_locks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"week_start" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"closed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"valid_from" text NOT NULL,
	"schedule" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worklog_sinks" (
	"id" serial PRIMARY KEY NOT NULL,
	"worklog_id" integer NOT NULL,
	"sink_connection_id" integer NOT NULL,
	"remote_id" text,
	"state" text NOT NULL,
	"version" text,
	"last_error" text,
	"synced_at" bigint
);
--> statement-breakpoint
CREATE TABLE "worklog_trash" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" integer,
	"worklog_uuid" uuid NOT NULL,
	"issue_key" text NOT NULL,
	"started" bigint NOT NULL,
	"time_spent_seconds" integer NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"remote_id" text,
	"reason" text NOT NULL,
	"deleted_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worklogs" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"item_id" integer,
	"issue_key" text NOT NULL,
	"jira_worklog_id" text NOT NULL,
	"time_spent_seconds" integer NOT NULL,
	"started" bigint NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"author_account_id" text DEFAULT '' NOT NULL,
	"jira_created" text,
	"jira_updated" text,
	"synced_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bucket_sources" ADD CONSTRAINT "bucket_sources_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bucket_sources" ADD CONSTRAINT "bucket_sources_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bucket_sources" ADD CONSTRAINT "bucket_sources_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buckets" ADD CONSTRAINT "buckets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_sync" ADD CONSTRAINT "connection_sync_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "containers" ADD CONSTRAINT "containers_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_prefs" ADD CONSTRAINT "device_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_prefs" ADD CONSTRAINT "device_prefs_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_notes" ADD CONSTRAINT "issue_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_notes" ADD CONSTRAINT "issue_notes_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_notes" ADD CONSTRAINT "issue_notes_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_aliases" ADD CONSTRAINT "item_aliases_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_files" ADD CONSTRAINT "module_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_storage" ADD CONSTRAINT "module_storage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_worklog_id_worklogs_id_fk" FOREIGN KEY ("worklog_id") REFERENCES "public"."worklogs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD CONSTRAINT "pinboard_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD CONSTRAINT "pinboard_notes_board_id_pinboards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."pinboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD CONSTRAINT "pinboard_notes_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD CONSTRAINT "pinboard_notes_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD CONSTRAINT "pinboard_notes_issue_note_id_issue_notes_id_fk" FOREIGN KEY ("issue_note_id") REFERENCES "public"."issue_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinboards" ADD CONSTRAINT "pinboards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remembered_devices" ADD CONSTRAINT "remembered_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_locks" ADD CONSTRAINT "week_locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklog_sinks" ADD CONSTRAINT "worklog_sinks_worklog_id_worklogs_id_fk" FOREIGN KEY ("worklog_id") REFERENCES "public"."worklogs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklog_sinks" ADD CONSTRAINT "worklog_sinks_sink_connection_id_connections_id_fk" FOREIGN KEY ("sink_connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklog_trash" ADD CONSTRAINT "worklog_trash_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bucket_sources_bucket" ON "bucket_sources" USING btree ("bucket_id");--> statement-breakpoint
CREATE INDEX "idx_buckets_user" ON "buckets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_connections_user_account" ON "connections" USING btree ("user_id","type","base_url","remote_account_id");--> statement-breakpoint
CREATE INDEX "idx_connections_user" ON "connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_containers_connection_remote" ON "containers" USING btree ("connection_id","remote_id");--> statement-breakpoint
CREATE INDEX "idx_containers_connection_key" ON "containers" USING btree ("connection_id","key");--> statement-breakpoint
CREATE INDEX "idx_invites_user" ON "invites" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_issue_notes_user_issue" ON "issue_notes" USING btree ("user_id","issue_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_issues_connection_remote" ON "issues" USING btree ("user_id","connection_id","jira_id");--> statement-breakpoint
CREATE INDEX "idx_issues_user_status" ON "issues" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_issues_user_project" ON "issues" USING btree ("user_id","project_key");--> statement-breakpoint
CREATE INDEX "idx_issues_connection_container" ON "issues" USING btree ("connection_id","container_id");--> statement-breakpoint
CREATE INDEX "idx_issues_user_connection_category" ON "issues" USING btree ("user_id","connection_id","category");--> statement-breakpoint
CREATE INDEX "idx_issues_summary_trgm" ON "issues" USING gin ("summary" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_issues_key_trgm" ON "issues" USING gin ("key" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_item_aliases_item_key" ON "item_aliases" USING btree ("item_id","key");--> statement-breakpoint
CREATE INDEX "idx_item_aliases_key" ON "item_aliases" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idx_module_files_used" ON "module_files" USING btree ("used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_user_dedupe" ON "notifications" USING btree ("user_id","dedupe");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_dismissed" ON "notifications" USING btree ("user_id","dismissed_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_user" ON "outbox" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pinboard_user" ON "pinboard_notes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pinboard_board" ON "pinboard_notes" USING btree ("board_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pinboard_issue_note" ON "pinboard_notes" USING btree ("board_id","issue_note_id");--> statement-breakpoint
CREATE INDEX "idx_pinboards_user" ON "pinboards" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_remembered_devices_user" ON "remembered_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_timers_connection_issue" ON "timers" USING btree ("user_id","connection_id","issue_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_site_account" ON "users" USING btree ("site_url","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_username" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_week_locks_user_week" ON "week_locks" USING btree ("user_id","week_start");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_schedules_user_from" ON "work_schedules" USING btree ("user_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_worklog_sinks_worklog_sink" ON "worklog_sinks" USING btree ("worklog_id","sink_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_worklog_sinks_remote" ON "worklog_sinks" USING btree ("sink_connection_id","remote_id");--> statement-breakpoint
CREATE INDEX "idx_worklog_sinks_unsynced" ON "worklog_sinks" USING btree ("state") WHERE "worklog_sinks"."state" <> 'synced';--> statement-breakpoint
CREATE INDEX "idx_worklog_trash_user_deleted" ON "worklog_trash" USING btree ("user_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_worklogs_connection_issue_remote" ON "worklogs" USING btree ("user_id","connection_id","issue_key","jira_worklog_id");--> statement-breakpoint
CREATE INDEX "idx_worklogs_user_started" ON "worklogs" USING btree ("user_id","started");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_worklogs_uuid" ON "worklogs" USING btree ("uuid");--> statement-breakpoint
-- The rules every write follows, in the database so no path can skip them.
CREATE OR REPLACE FUNCTION public.inkledger_fill_connection()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  found integer[];
  owners integer[];
BEGIN
  IF NEW."connection_id" IS NOT NULL THEN RETURN NEW; END IF;
  -- A free note on a board (no issue) has no connection. Nested: plpgsql
  -- doesn't short-circuit AND, and other tables have no issue_key.
  IF TG_TABLE_NAME = 'pinboard_notes' THEN
    IF NEW."issue_key" IS NULL THEN RETURN NEW; END IF;
  END IF;
  SELECT array_agg("id") INTO found FROM "connections" WHERE "user_id" = NEW."user_id" AND "archived_at" IS NULL;
  IF coalesce(array_length(found, 1), 0) = 1 THEN
    NEW."connection_id" := found[1];
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME <> 'issues' THEN
    SELECT array_agg(DISTINCT i."connection_id") INTO owners
    FROM "issues" i JOIN "connections" c ON c."id" = i."connection_id"
    WHERE i."user_id" = NEW."user_id" AND i."key" = NEW."issue_key" AND c."archived_at" IS NULL;
    IF coalesce(array_length(owners, 1), 0) = 1 THEN
      NEW."connection_id" := owners[1];
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '%: connection_id is required (user % has % live connections)', TG_TABLE_NAME, NEW."user_id", coalesce(array_length(found, 1), 0);
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_issue_container()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  found integer;
BEGIN
  IF NEW."connection_id" IS NULL OR NEW."project_key" = '' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Set by the caller, or the project unchanged: nothing to do.
    IF NEW."container_id" IS DISTINCT FROM OLD."container_id" THEN RETURN NEW; END IF;
    IF NEW."project_key" = OLD."project_key" AND NEW."container_id" IS NOT NULL THEN RETURN NEW; END IF;
  ELSIF NEW."container_id" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT "id" INTO found FROM "containers"
  WHERE "connection_id" = NEW."connection_id" AND "key" = NEW."project_key"
  ORDER BY ("remote_id" LIKE 'key:%'), "id" LIMIT 1;
  IF found IS NULL THEN
    INSERT INTO "containers" ("connection_id", "remote_id", "key", "name", "avatar_url", "created_at")
    VALUES (NEW."connection_id", 'key:' || NEW."project_key", NEW."project_key", NEW."project_name", NEW."project_avatar_url", (extract(epoch from now()) * 1000)::bigint)
    ON CONFLICT ("connection_id", "remote_id") DO UPDATE SET "name" = EXCLUDED."name"
    RETURNING "id" INTO found;
  END IF;
  NEW."container_id" := found;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_issue_keyed()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."key" IS NOT DISTINCT FROM OLD."key" THEN RETURN NULL; END IF;
    INSERT INTO "item_aliases" ("item_id", "key", "created_at")
    VALUES (NEW."id", OLD."key", (extract(epoch from now()) * 1000)::bigint)
    ON CONFLICT DO NOTHING;
    -- Rows already under the new key but not linked yet would collide: the linked ones win.
    DELETE FROM "worklogs" o WHERE o."item_id" IS NULL AND o."user_id" = NEW."user_id" AND o."connection_id" = NEW."connection_id" AND o."issue_key" = NEW."key"
      AND EXISTS (SELECT 1 FROM "worklogs" w WHERE w."item_id" = NEW."id" AND w."jira_worklog_id" = o."jira_worklog_id");
    DELETE FROM "timers" o WHERE o."item_id" IS NULL AND o."user_id" = NEW."user_id" AND o."connection_id" = NEW."connection_id" AND o."issue_key" = NEW."key"
      AND EXISTS (SELECT 1 FROM "timers" t WHERE t."item_id" = NEW."id");
    UPDATE "worklogs" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
    UPDATE "timers" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
    UPDATE "outbox" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
    UPDATE "issue_notes" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
    UPDATE "notifications" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
    UPDATE "pinboard_notes" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
  END IF;
  UPDATE "worklogs" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "timers" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "outbox" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "issue_notes" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "notifications" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "pinboard_notes" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_link_item()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."issue_key" IS NULL THEN
    NEW."item_id" := NULL;
  ELSIF NEW."item_id" IS NULL OR (TG_OP = 'UPDATE' AND NEW."issue_key" IS DISTINCT FROM OLD."issue_key") THEN
    SELECT "id" INTO NEW."item_id" FROM "issues"
    WHERE "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "key" = NEW."issue_key";
  END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_mirror_user_connection()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."site_url" IS NULL OR NEW."account_id" IS NULL OR NEW."encrypted_token" IS NULL THEN RETURN NULL; END IF;
  UPDATE "connections" SET
    "base_url" = NEW."site_url",
    "remote_account_id" = NEW."account_id",
    "display_name" = NEW."display_name",
    "avatar_url" = NEW."avatar_url",
    "options" = json_build_object('deployment', NEW."deployment", 'authType', NEW."auth_type", 'username', NEW."email")::text,
    "encrypted_secret" = NEW."encrypted_token"
  WHERE "user_id" = NEW."id" AND "legacy" = 1;
  IF NOT FOUND THEN
    INSERT INTO "connections" ("user_id", "type", "base_url", "remote_account_id", "display_name", "avatar_url", "options", "encrypted_secret", "legacy", "created_at")
    VALUES (NEW."id", 'jira', NEW."site_url", NEW."account_id", NEW."display_name", NEW."avatar_url",
            json_build_object('deployment', NEW."deployment", 'authType', NEW."auth_type", 'username', NEW."email")::text,
            NEW."encrypted_token", 1, NEW."created_at");
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_outbox_worklog()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."worklog_id" IS NULL AND NEW."jira_worklog_id" <> '' THEN
    SELECT "id" INTO NEW."worklog_id" FROM "worklogs"
    WHERE "user_id" = NEW."user_id" AND "issue_key" = NEW."issue_key" AND "jira_worklog_id" = NEW."jira_worklog_id"
    LIMIT 1;
  END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_worklog_primary_sink()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  pending boolean := NEW."jira_worklog_id" LIKE 'pending-%';
BEGIN
  IF NEW."connection_id" IS NULL THEN RETURN NULL; END IF;
  BEGIN
    INSERT INTO "worklog_sinks" ("worklog_id", "sink_connection_id", "remote_id", "state", "synced_at")
    VALUES (NEW."id", NEW."connection_id",
            CASE WHEN pending THEN NULL ELSE NEW."jira_worklog_id" END,
            CASE WHEN pending THEN 'pending' ELSE 'synced' END,
            NEW."synced_at")
    ON CONFLICT ("worklog_id", "sink_connection_id") DO UPDATE SET
      "remote_id" = EXCLUDED."remote_id", "state" = EXCLUDED."state", "synced_at" = EXCLUDED."synced_at", "last_error" = NULL;
  EXCEPTION WHEN unique_violation THEN
    -- The same remote worklog under two local rows (an issue key changed
    -- between syncs): the registry keeps the first; the write still lands.
    NULL;
  END;
  -- A queued create's placeholder: its outbox entry points at it.
  IF pending THEN
    UPDATE "outbox" SET "worklog_id" = NEW."id"
    WHERE "id" = substring(NEW."jira_worklog_id" FROM 9)::integer AND "user_id" = NEW."user_id" AND "worklog_id" IS NULL;
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_worklog_to_trash()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  why text := coalesce(nullif(current_setting('inkledger.delete_reason', true), ''), 'remote');
BEGIN
  IF why = 'merged' THEN RETURN OLD; END IF;
  INSERT INTO "worklog_trash" ("user_id", "connection_id", "worklog_uuid", "issue_key", "started", "time_spent_seconds", "comment", "remote_id", "reason", "deleted_at")
  VALUES (OLD."user_id", OLD."connection_id", OLD."uuid", OLD."issue_key", OLD."started", OLD."time_spent_seconds", OLD."comment",
          CASE WHEN OLD."jira_worklog_id" LIKE 'pending-%' THEN NULL ELSE OLD."jira_worklog_id" END,
          why, (extract(epoch from now()) * 1000)::bigint);
  RETURN OLD;
END $function$;
--> statement-breakpoint
CREATE TRIGGER issue_notes_fill_connection BEFORE INSERT ON public.issue_notes FOR EACH ROW EXECUTE FUNCTION inkledger_fill_connection();
--> statement-breakpoint
CREATE TRIGGER issue_notes_link_item BEFORE INSERT OR UPDATE OF issue_key ON public.issue_notes FOR EACH ROW EXECUTE FUNCTION inkledger_link_item();
--> statement-breakpoint
CREATE TRIGGER issues_fill_connection BEFORE INSERT ON public.issues FOR EACH ROW EXECUTE FUNCTION inkledger_fill_connection();
--> statement-breakpoint
CREATE TRIGGER issues_keyed AFTER INSERT OR UPDATE OF key ON public.issues FOR EACH ROW EXECUTE FUNCTION inkledger_issue_keyed();
--> statement-breakpoint
CREATE TRIGGER issues_place_in_container BEFORE INSERT OR UPDATE OF project_key, connection_id, container_id ON public.issues FOR EACH ROW EXECUTE FUNCTION inkledger_issue_container();
--> statement-breakpoint
CREATE TRIGGER notifications_fill_connection BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION inkledger_fill_connection();
--> statement-breakpoint
CREATE TRIGGER notifications_link_item BEFORE INSERT OR UPDATE OF issue_key ON public.notifications FOR EACH ROW EXECUTE FUNCTION inkledger_link_item();
--> statement-breakpoint
CREATE TRIGGER outbox_fill_connection BEFORE INSERT ON public.outbox FOR EACH ROW EXECUTE FUNCTION inkledger_fill_connection();
--> statement-breakpoint
CREATE TRIGGER outbox_link_item BEFORE INSERT OR UPDATE OF issue_key ON public.outbox FOR EACH ROW EXECUTE FUNCTION inkledger_link_item();
--> statement-breakpoint
CREATE TRIGGER outbox_worklog BEFORE INSERT ON public.outbox FOR EACH ROW EXECUTE FUNCTION inkledger_outbox_worklog();
--> statement-breakpoint
CREATE TRIGGER pinboard_notes_fill_connection BEFORE INSERT OR UPDATE OF issue_key ON public.pinboard_notes FOR EACH ROW EXECUTE FUNCTION inkledger_fill_connection();
--> statement-breakpoint
CREATE TRIGGER pinboard_notes_link_item BEFORE INSERT OR UPDATE OF issue_key ON public.pinboard_notes FOR EACH ROW EXECUTE FUNCTION inkledger_link_item();
--> statement-breakpoint
CREATE TRIGGER timers_fill_connection BEFORE INSERT ON public.timers FOR EACH ROW EXECUTE FUNCTION inkledger_fill_connection();
--> statement-breakpoint
CREATE TRIGGER timers_link_item BEFORE INSERT OR UPDATE OF issue_key ON public.timers FOR EACH ROW EXECUTE FUNCTION inkledger_link_item();
--> statement-breakpoint
CREATE TRIGGER users_mirror_connection AFTER INSERT OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION inkledger_mirror_user_connection();
--> statement-breakpoint
CREATE TRIGGER worklogs_fill_connection BEFORE INSERT ON public.worklogs FOR EACH ROW EXECUTE FUNCTION inkledger_fill_connection();
--> statement-breakpoint
CREATE TRIGGER worklogs_link_item BEFORE INSERT OR UPDATE OF issue_key ON public.worklogs FOR EACH ROW EXECUTE FUNCTION inkledger_link_item();
--> statement-breakpoint
CREATE TRIGGER worklogs_primary_sink AFTER INSERT OR UPDATE OF jira_worklog_id, connection_id ON public.worklogs FOR EACH ROW EXECUTE FUNCTION inkledger_worklog_primary_sink();
--> statement-breakpoint
CREATE TRIGGER worklogs_to_trash BEFORE DELETE ON public.worklogs FOR EACH ROW EXECUTE FUNCTION inkledger_worklog_to_trash();
--> statement-breakpoint
-- 0001_connection_scoped_keys
-- An issue key is unique only per connection (two trackers can both have
-- APP-1): a queued worklog change finds its worklog on its own connection.
CREATE OR REPLACE FUNCTION public.inkledger_outbox_worklog()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."worklog_id" IS NULL AND NEW."jira_worklog_id" <> '' THEN
    SELECT "id" INTO NEW."worklog_id" FROM "worklogs"
    WHERE "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id"
      AND "issue_key" = NEW."issue_key" AND "jira_worklog_id" = NEW."jira_worklog_id"
    LIMIT 1;
  END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
-- Notifications are told apart per connection (c<id>:…, as new ones are
-- written): an old key already written the new way stays once.
DELETE FROM "notifications" o
WHERE o."dedupe" !~ '^c[0-9]+:'
  AND EXISTS (SELECT 1 FROM "notifications" n WHERE n."user_id" = o."user_id" AND n."dedupe" = 'c' || o."connection_id" || ':' || o."dedupe");
--> statement-breakpoint
UPDATE "notifications" SET "dedupe" = 'c' || "connection_id" || ':' || "dedupe" WHERE "dedupe" !~ '^c[0-9]+:';
--> statement-breakpoint
-- 0002_credentials_off_users
-- Credentials live only in connections now (sealed per connection, api/lib/crypto.ts):
-- the user row no longer mirrors a Jira login.
DROP TRIGGER IF EXISTS users_mirror_connection ON "users";--> statement-breakpoint
DROP FUNCTION IF EXISTS public.inkledger_mirror_user_connection();--> statement-breakpoint
DROP INDEX "uq_users_site_account";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "site_url";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "deployment";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "auth_type";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "account_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "encrypted_token";
--> statement-breakpoint
-- 0003_worklogs_by_item
CREATE INDEX "idx_worklogs_item" ON "worklogs" USING btree ("item_id");
--> statement-breakpoint
-- 0004_sink_states
-- The primary sink of a worklog, by its id's form: a tracker's id (synced),
-- "pending-N" (queued as outbox N), "new-…" (being written to its tracker
-- right now), "local-…" (its tracker keeps no time: no sink at all).
CREATE OR REPLACE FUNCTION public.inkledger_worklog_primary_sink()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  queued boolean := NEW."jira_worklog_id" ~ '^pending-[0-9]+$';
  waiting boolean := queued OR NEW."jira_worklog_id" LIKE 'new-%';
BEGIN
  IF NEW."connection_id" IS NULL OR NEW."jira_worklog_id" LIKE 'local-%' THEN RETURN NULL; END IF;
  BEGIN
    INSERT INTO "worklog_sinks" ("worklog_id", "sink_connection_id", "remote_id", "state", "synced_at")
    VALUES (NEW."id", NEW."connection_id",
            CASE WHEN waiting THEN NULL ELSE NEW."jira_worklog_id" END,
            CASE WHEN waiting THEN 'pending' ELSE 'synced' END,
            NEW."synced_at")
    ON CONFLICT ("worklog_id", "sink_connection_id") DO UPDATE SET
      "remote_id" = EXCLUDED."remote_id", "state" = EXCLUDED."state", "synced_at" = EXCLUDED."synced_at", "last_error" = NULL;
  EXCEPTION WHEN unique_violation THEN
    -- The same remote worklog under two local rows (an issue key changed
    -- between syncs): the registry keeps the first; the write still lands.
    NULL;
  END;
  -- A queued create's placeholder: its outbox entry points at it.
  IF queued THEN
    UPDATE "outbox" SET "worklog_id" = NEW."id"
    WHERE "id" = substring(NEW."jira_worklog_id" FROM 9)::integer AND "user_id" = NEW."user_id" AND "worklog_id" IS NULL;
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
-- Time kept in inkledger only has no sink to be in step with.
DELETE FROM "worklog_sinks" s USING "worklogs" w WHERE s."worklog_id" = w."id" AND w."jira_worklog_id" LIKE 'local-%';
--> statement-breakpoint
-- 0005_activity
CREATE TABLE "activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"at" bigint NOT NULL,
	"actor" text,
	"field" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"origin" text DEFAULT 'diff' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_activity_item_at" ON "activity" USING btree ("item_id","at");
--> statement-breakpoint
-- 0006_issue_raw
ALTER TABLE "issues" ADD COLUMN "raw" text;
--> statement-breakpoint
-- 0007_clients
CREATE TABLE "client_containers" (
	"client_id" integer NOT NULL,
	"container_id" integer NOT NULL,
	CONSTRAINT "client_containers_client_id_container_id_pk" PRIMARY KEY("client_id","container_id")
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"aliases" text DEFAULT '[]' NOT NULL,
	"color" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "containers" ADD COLUMN "group_name" text;--> statement-breakpoint
ALTER TABLE "client_containers" ADD CONSTRAINT "client_containers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_containers" ADD CONSTRAINT "client_containers_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_client_containers_container" ON "client_containers" USING btree ("container_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_clients_user_name" ON "clients" USING btree ("user_id",lower("name"));
--> statement-breakpoint
-- 0008_kept_queries
CREATE TABLE "recent_queries" (
	"user_id" integer NOT NULL,
	"query" text NOT NULL,
	"used_at" bigint NOT NULL,
	CONSTRAINT "recent_queries_user_id_query_pk" PRIMARY KEY("user_id","query")
);
--> statement-breakpoint
CREATE TABLE "saved_queries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recent_queries" ADD CONSTRAINT "recent_queries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_recent_queries_user" ON "recent_queries" USING btree ("user_id","used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_saved_queries_user_name" ON "saved_queries" USING btree ("user_id",lower("name"));
--> statement-breakpoint
-- 0009_bucket_boards
CREATE TABLE "bucket_columns" (
	"id" serial PRIMARY KEY NOT NULL,
	"bucket_id" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"statuses" text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buckets" ADD COLUMN "query" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "buckets" ADD COLUMN "board_mode" text DEFAULT 'lanes' NOT NULL;--> statement-breakpoint
ALTER TABLE "bucket_columns" ADD CONSTRAINT "bucket_columns_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bucket_columns_bucket" ON "bucket_columns" USING btree ("bucket_id","position");
--> statement-breakpoint
-- 0010_sink_states_goals
ALTER TABLE "settings" ADD COLUMN "goal_basis" text DEFAULT 'logged' NOT NULL;--> statement-breakpoint
ALTER TABLE "worklog_sinks" ADD COLUMN "locked" text;--> statement-breakpoint
ALTER TABLE "worklog_sinks" ADD COLUMN "remote_snapshot" text;
--> statement-breakpoint
-- 0011_webhooks
CREATE TABLE "webhook_deliveries" (
	"connection_id" integer NOT NULL,
	"delivery_id" text NOT NULL,
	"received_at" bigint NOT NULL,
	CONSTRAINT "webhook_deliveries_connection_id_delivery_id_pk" PRIMARY KEY("connection_id","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_at" ON "webhook_deliveries" USING btree ("received_at");
--> statement-breakpoint
-- 0012_writes_allowed
ALTER TABLE "connections" ADD COLUMN "writes_allowed" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 0013_sink_mappings
CREATE TABLE "sink_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"sink_connection_id" integer NOT NULL,
	"container_id" integer,
	"target_remote_id" text NOT NULL,
	"target_name" text DEFAULT '' NOT NULL,
	"target_path" text DEFAULT '[]' NOT NULL,
	"activity_id" text
);
--> statement-breakpoint
ALTER TABLE "sink_mappings" ADD CONSTRAINT "sink_mappings_sink_connection_id_connections_id_fk" FOREIGN KEY ("sink_connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sink_mappings" ADD CONSTRAINT "sink_mappings_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sink_mappings" ON "sink_mappings" USING btree ("sink_connection_id",coalesce("container_id", 0));
--> statement-breakpoint
-- 0014_dashboard_night
ALTER TABLE "settings" ADD COLUMN "dashboard_night" integer DEFAULT 1 NOT NULL;
