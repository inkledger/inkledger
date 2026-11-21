ALTER TABLE "worklog_sinks" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "worklog_sinks" ADD COLUMN IF NOT EXISTS "pushed_day" text;