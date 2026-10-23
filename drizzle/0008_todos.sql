CREATE TABLE "todos" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"text" text NOT NULL,
	"due_on" text,
	"done_at" bigint,
	"position" integer DEFAULT 0 NOT NULL,
	"connection_id" integer,
	"item_id" integer,
	"issue_key" text,
	"comment_id" text,
	"comment_excerpt" text,
	"issue_note_id" integer,
	"reminder_seen_on" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "todos_issue_has_connection" CHECK ("todos"."issue_key" IS NULL OR "todos"."connection_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "todos_in_menu" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "todos_widget" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "todos_hot_corner" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_issue_note_id_issue_notes_id_fk" FOREIGN KEY ("issue_note_id") REFERENCES "public"."issue_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_todos_user_open" ON "todos" USING btree ("user_id","done_at","due_on");--> statement-breakpoint
CREATE INDEX "idx_todos_user_issue" ON "todos" USING btree ("user_id","issue_key");--> statement-breakpoint
-- A TODO tied to an issue follows it like the rest: linked to its row, renamed with its key.
-- (No fill_connection trigger: a TODO of its own has no issue, and the server sets the connection.)
CREATE TRIGGER todos_link_item BEFORE INSERT OR UPDATE OF issue_key ON public.todos FOR EACH ROW EXECUTE FUNCTION inkledger_link_item();--> statement-breakpoint
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
  END IF;
  UPDATE "worklogs" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "timers" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "outbox" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "issue_notes" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "notifications" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "pinboard_notes" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "todos" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  RETURN NULL;
END $function$;
