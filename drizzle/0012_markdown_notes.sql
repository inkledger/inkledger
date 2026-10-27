CREATE TABLE "markdown_note_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"user_id" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"content_revision" integer NOT NULL,
	"origin" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "markdown_note_versions_origin" CHECK ("markdown_note_versions"."origin" IN ('auto', 'manual', 'conflict', 'delete', 'restore'))
);
--> statement-breakpoint
CREATE TABLE "markdown_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"parent_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"content_revision" integer DEFAULT 1 NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"search_title" text DEFAULT '' NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"connection_id" integer,
	"item_id" integer,
	"issue_key" text,
	"deleted_at" bigint,
	"delete_batch" uuid,
	"delete_root_id" uuid,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "markdown_notes_issue_has_connection" CHECK ("markdown_notes"."issue_key" IS NULL OR "markdown_notes"."connection_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_markdown_notes_id_user" ON "markdown_notes" USING btree ("id","user_id");--> statement-breakpoint
ALTER TABLE "markdown_note_versions" ADD CONSTRAINT "markdown_note_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markdown_note_versions" ADD CONSTRAINT "markdown_note_versions_note_user_fk" FOREIGN KEY ("note_id","user_id") REFERENCES "public"."markdown_notes"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markdown_notes" ADD CONSTRAINT "markdown_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markdown_notes" ADD CONSTRAINT "markdown_notes_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markdown_notes" ADD CONSTRAINT "markdown_notes_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markdown_notes" ADD CONSTRAINT "markdown_notes_parent_user_fk" FOREIGN KEY ("parent_id","user_id") REFERENCES "public"."markdown_notes"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_markdown_note_versions_note_created" ON "markdown_note_versions" USING btree ("note_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_markdown_note_versions_created" ON "markdown_note_versions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_markdown_notes_active_tree" ON "markdown_notes" USING btree ("user_id","parent_id","position","id") WHERE "markdown_notes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_markdown_notes_user_issue" ON "markdown_notes" USING btree ("user_id","connection_id","issue_key");--> statement-breakpoint
CREATE INDEX "idx_markdown_notes_trash" ON "markdown_notes" USING btree ("user_id","delete_batch","deleted_at") WHERE "markdown_notes"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_markdown_notes_search" ON "markdown_notes" USING gin ((setweight(to_tsvector('simple', "search_title"), 'A') || setweight(to_tsvector('simple', "search_text"), 'B'))) WHERE "markdown_notes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TRIGGER markdown_notes_link_item BEFORE INSERT OR UPDATE OF issue_key, connection_id ON public.markdown_notes FOR EACH ROW EXECUTE FUNCTION inkledger_link_item();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_issue_keyed()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."key" IS NOT DISTINCT FROM OLD."key" THEN RETURN NULL; END IF;
    INSERT INTO "item_aliases" ("item_id", "key", "created_at")
    VALUES (NEW."id", OLD."key", (extract(epoch from now()) * 1000)::bigint)
    ON CONFLICT DO NOTHING;
    -- Rows already under the new key but not linked yet would collide: the linked ones win.
    DELETE FROM "worklogs" o WHERE o."item_id" IS NULL AND o."user_id" = NEW."user_id" AND o."connection_id" = NEW."connection_id" AND o."issue_key" = NEW."key"
      AND EXISTS (SELECT 1 FROM "worklogs" w WHERE w."item_id" = NEW."id" AND w."jira_worklog_id" = o."jira_worklog_id");
    DELETE FROM "timers" o WHERE o."item_id" IS NULL AND o."user_id" = NEW."user_id" AND o."connection_id" = NEW."connection_id" AND o."issue_key" = NEW."key"
      AND EXISTS (SELECT 1 FROM "timers" t WHERE t."item_id" = NEW."id");
    UPDATE "worklogs" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
    UPDATE "timers" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
    UPDATE "outbox" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
    UPDATE "issue_notes" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
    UPDATE "notifications" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
    UPDATE "pinboard_notes" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
    UPDATE "todos" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
    UPDATE "markdown_notes" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
  END IF;
  UPDATE "worklogs" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "timers" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "outbox" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "issue_notes" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "notifications" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "pinboard_notes" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "todos" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "markdown_notes" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  RETURN NULL;
END $function$;