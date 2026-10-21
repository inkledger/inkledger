-- The schema of the last release before the platform (tag checkpoint/pre-platform),
-- as its migrations made it: the database pg-import moves from (e2e/pg-import.test.mjs).
-- 0000_chilly_vertigo
CREATE TABLE "issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"jira_id" text NOT NULL,
	"key" text NOT NULL,
	"summary" text NOT NULL,
	"status" text NOT NULL,
	"status_category" text DEFAULT '' NOT NULL,
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
	"synced_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
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
	"kind" text NOT NULL,
	"issue_key" text NOT NULL,
	"jira_worklog_id" text DEFAULT '' NOT NULL,
	"time_spent_seconds" integer DEFAULT 0 NOT NULL,
	"started" bigint,
	"comment" text DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pinboard_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"board_id" integer,
	"issue_key" text,
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
	"allowed_link_domains" text DEFAULT '[]' NOT NULL
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
	"site_url" text NOT NULL,
	"deployment" text DEFAULT 'cloud' NOT NULL,
	"auth_type" text DEFAULT 'basic' NOT NULL,
	"account_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"encrypted_token" text NOT NULL,
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
CREATE TABLE "worklogs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
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
ALTER TABLE "issues" ADD CONSTRAINT "issues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD CONSTRAINT "pinboard_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD CONSTRAINT "pinboard_notes_board_id_pinboards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."pinboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pinboards" ADD CONSTRAINT "pinboards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timers" ADD CONSTRAINT "timers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_locks" ADD CONSTRAINT "week_locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklogs" ADD CONSTRAINT "worklogs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_issues_user_key" ON "issues" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "idx_issues_user_status" ON "issues" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_issues_user_project" ON "issues" USING btree ("user_id","project_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_user_dedupe" ON "notifications" USING btree ("user_id","dedupe");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_dismissed" ON "notifications" USING btree ("user_id","dismissed_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_user" ON "outbox" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pinboard_user" ON "pinboard_notes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pinboard_board" ON "pinboard_notes" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "idx_pinboards_user" ON "pinboards" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_timers_user_issue" ON "timers" USING btree ("user_id","issue_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_site_account" ON "users" USING btree ("site_url","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_week_locks_user_week" ON "week_locks" USING btree ("user_id","week_start");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_schedules_user_from" ON "work_schedules" USING btree ("user_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_worklogs_user_issue_jira" ON "worklogs" USING btree ("user_id","issue_key","jira_worklog_id");--> statement-breakpoint
CREATE INDEX "idx_worklogs_user_started" ON "worklogs" USING btree ("user_id","started");
--> statement-breakpoint
-- 0001_narrow_doctor_faustus
ALTER TABLE "outbox" ADD COLUMN "claimed_at" bigint;
--> statement-breakpoint
-- 0002_volatile_the_leader
CREATE TABLE "remembered_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" bigint NOT NULL,
	"last_used_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "remembered_devices" ADD CONSTRAINT "remembered_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_remembered_devices_user" ON "remembered_devices" USING btree ("user_id");
--> statement-breakpoint
-- 0003_medical_manta
CREATE TABLE "module_storage" (
	"user_id" integer NOT NULL,
	"module_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "module_storage_user_id_module_id_key_pk" PRIMARY KEY("user_id","module_id","key")
);
--> statement-breakpoint
ALTER TABLE "module_storage" ADD CONSTRAINT "module_storage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- 0004_module_since
-- Modules count progress from "__since" (see api/routers/modules.ts). Data
-- saved before this existed keeps its whole history: since = 0.
INSERT INTO "module_storage" ("user_id", "module_id", "key", "value", "updated_at")
SELECT DISTINCT "user_id", "module_id", '__since', '0', (extract(epoch from now()) * 1000)::bigint
FROM "module_storage"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 0005_narrow_patriot
ALTER TABLE "settings" ADD COLUMN "backdrop_visibility" text DEFAULT 'normal' NOT NULL;
--> statement-breakpoint
-- 0006_aspiring_tempest
CREATE TABLE "issue_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"issue_key" text NOT NULL,
	"body" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD COLUMN "issue_note_id" integer;--> statement-breakpoint
ALTER TABLE "issue_notes" ADD CONSTRAINT "issue_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_issue_notes_user_issue" ON "issue_notes" USING btree ("user_id","issue_key");--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD CONSTRAINT "pinboard_notes_issue_note_id_issue_notes_id_fk" FOREIGN KEY ("issue_note_id") REFERENCES "public"."issue_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pinboard_issue_note" ON "pinboard_notes" USING btree ("board_id","issue_note_id");
--> statement-breakpoint
-- 0007_large_hercules
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
ALTER TABLE "module_files" ADD CONSTRAINT "module_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_module_files_used" ON "module_files" USING btree ("used_at");
