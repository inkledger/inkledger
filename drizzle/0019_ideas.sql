CREATE TABLE "ideas" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'raw' NOT NULL,
	"route" text,
	"container_id" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"acceptance" text DEFAULT '[]' NOT NULL,
	"questions" text DEFAULT '[]' NOT NULL,
	"labels" text DEFAULT '[]' NOT NULL,
	"estimate_seconds" integer,
	"source_connection_id" integer,
	"source_item_id" integer,
	"source_issue_key" text,
	"mail_id" integer,
	"promoted_connection_id" integer,
	"promoted_item_id" integer,
	"promoted_issue_key" text,
	"promoted_at" bigint,
	"discarded_reason" text,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "ideas_state" CHECK ("ideas"."state" IN ('raw','refining','ready','promoted','discarded')),
	CONSTRAINT "ideas_route" CHECK ("ideas"."route" IS NULL OR "ideas"."route" IN ('me','agent','ask')),
	CONSTRAINT "ideas_source_has_connection" CHECK ("ideas"."source_issue_key" IS NULL OR "ideas"."source_connection_id" IS NOT NULL),
	CONSTRAINT "ideas_promoted_has_connection" CHECK ("ideas"."promoted_issue_key" IS NULL OR "ideas"."promoted_connection_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_source_connection_id_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_source_item_id_issues_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_mail_id_mails_id_fk" FOREIGN KEY ("mail_id") REFERENCES "public"."mails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_promoted_connection_id_connections_id_fk" FOREIGN KEY ("promoted_connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_promoted_item_id_issues_id_fk" FOREIGN KEY ("promoted_item_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ideas_user_state" ON "ideas" USING btree ("user_id","state","position");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ideas_open_source" ON "ideas" USING btree ("user_id","source_connection_id","source_issue_key") WHERE "ideas"."source_issue_key" IS NOT NULL AND "ideas"."state" NOT IN ('promoted','discarded') AND "ideas"."deleted_at" IS NULL;