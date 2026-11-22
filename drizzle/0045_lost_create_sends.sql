ALTER TABLE "outbox" ADD COLUMN IF NOT EXISTS "landed_before" bigint;--> statement-breakpoint
ALTER TABLE "worklog_sinks" ADD COLUMN IF NOT EXISTS "last_sent_at" bigint;
