CREATE TABLE "write_leases" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worklog_sinks" ADD COLUMN "claimed_at" bigint;--> statement-breakpoint
ALTER TABLE "write_leases" ADD CONSTRAINT "write_leases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;