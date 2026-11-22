ALTER TABLE "outbox" ADD COLUMN IF NOT EXISTS "landed_after" bigint;--> statement-breakpoint
ALTER TABLE "worklog_sinks" ADD COLUMN IF NOT EXISTS "sent_seconds" integer;--> statement-breakpoint
ALTER TABLE "worklog_sinks" ADD COLUMN IF NOT EXISTS "sent_started" bigint;--> statement-breakpoint
ALTER TABLE "worklog_sinks" ADD COLUMN IF NOT EXISTS "sent_comment" text;