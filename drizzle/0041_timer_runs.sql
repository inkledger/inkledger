CREATE TABLE "timer_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"issue_key" text NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"logged_at" bigint
);
--> statement-breakpoint
CREATE TABLE "timer_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"issue_key" text NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint NOT NULL,
	"share_bp" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timer_runs" ADD CONSTRAINT "timer_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timer_runs" ADD CONSTRAINT "timer_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timer_shares" ADD CONSTRAINT "timer_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timer_shares" ADD CONSTRAINT "timer_shares_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_timer_runs_user_start" ON "timer_runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_timer_runs_open" ON "timer_runs" USING btree ("user_id","connection_id","issue_key") WHERE "timer_runs"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_timer_shares_user_start" ON "timer_shares" USING btree ("user_id","started_at");--> statement-breakpoint
-- Timers already running when this lands: their current run starts where they did.
INSERT INTO "timer_runs" ("user_id", "connection_id", "issue_key", "started_at") SELECT "user_id", "connection_id", "issue_key", "started_at" FROM "timers" WHERE "state" = 'running';
