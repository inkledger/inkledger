CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"premise" text DEFAULT '{}' NOT NULL,
	"draft" text DEFAULT '{}' NOT NULL,
	"draft_by" text DEFAULT '{}' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"busy_by" text,
	"busy_label" text DEFAULT '' NOT NULL,
	"busy_until" bigint,
	"resolution" text DEFAULT '{}' NOT NULL,
	"created_label" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "decisions_state" CHECK ("decisions"."state" IN ('open','resolving','resolved','dismissed','superseded','obsolete','expired'))
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_decisions_open" ON "decisions" USING btree ("user_id","dedupe_key") WHERE "decisions"."state" IN ('open','resolving');--> statement-breakpoint
CREATE INDEX "idx_decisions_user_state" ON "decisions" USING btree ("user_id","state","updated_at");