-- Idempotent: a draft of this migration (only the column) ran on some dev databases.
CREATE TABLE IF NOT EXISTS "write_leases" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worklog_sinks" ADD COLUMN IF NOT EXISTS "claimed_at" bigint;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'write_leases_user_id_users_id_fk') THEN
		ALTER TABLE "write_leases" ADD CONSTRAINT "write_leases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
