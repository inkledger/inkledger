ALTER TABLE "outbox" ADD COLUMN "next_attempt_at" bigint;--> statement-breakpoint
CREATE INDEX "idx_outbox_connection_kind" ON "outbox" USING btree ("connection_id","kind");