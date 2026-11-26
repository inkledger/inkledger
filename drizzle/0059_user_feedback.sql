-- User feedback (Info > Feedback): each person's own, and its thread. readFeedback and
-- manageFeedback go to owners and IT admins; members keep only their own feedback.
CREATE TABLE "feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"uid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"page" text DEFAULT '' NOT NULL,
	"app_version" text DEFAULT '' NOT NULL,
	"look" text DEFAULT '' NOT NULL,
	"density" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"status_reason" text,
	"screenshot" "bytea",
	"screenshot_type" text,
	"share_consent" integer DEFAULT 0 NOT NULL,
	"share_screenshot" integer DEFAULT 0 NOT NULL,
	"share_state" text,
	"shared_at" bigint,
	"upstream_status" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "feedback_type" CHECK ("feedback"."type" IN ('problem', 'idea', 'improvement')),
	CONSTRAINT "feedback_status" CHECK ("feedback"."status" IN ('new', 'discussion', 'accepted', 'in_progress', 'implemented', 'rejected')),
	CONSTRAINT "feedback_share_state" CHECK ("feedback"."share_state" IS NULL OR "feedback"."share_state" IN ('queued', 'sent', 'refused')),
	CONSTRAINT "feedback_title" CHECK (length("feedback"."title") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "feedback_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"feedback_id" integer NOT NULL,
	"author_id" integer,
	"origin" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status_from" text,
	"status_to" text,
	"upstream_id" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "feedback_comments_origin" CHECK ("feedback_comments"."origin" IN ('user', 'admin', 'upstream', 'status'))
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_comments" ADD CONSTRAINT "feedback_comments_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_comments" ADD CONSTRAINT "feedback_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feedback_uid" ON "feedback" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "idx_feedback_user" ON "feedback" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_feedback_share" ON "feedback" USING btree ("share_state");--> statement-breakpoint
CREATE INDEX "idx_feedback_comments_feedback" ON "feedback_comments" USING btree ("feedback_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feedback_comments_upstream" ON "feedback_comments" USING btree ("feedback_id","upstream_id");--> statement-breakpoint
UPDATE "roles" SET "permissions" = ("permissions"::jsonb || '["readFeedback","manageFeedback"]'::jsonb)::text
  WHERE "system" = 1 AND "key" IN ('owner', 'it-admin') AND NOT ("permissions"::jsonb ? 'manageFeedback');
