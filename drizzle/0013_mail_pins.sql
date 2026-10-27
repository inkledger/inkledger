CREATE TABLE "mail_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"mail_id" integer NOT NULL,
	"connection_id" integer,
	"item_id" integer,
	"issue_key" text,
	"note_id" uuid,
	"created_at" bigint NOT NULL,
	CONSTRAINT "mail_links_issue_has_connection" CHECK ("mail_links"."issue_key" IS NULL OR "mail_links"."connection_id" IS NOT NULL),
	CONSTRAINT "mail_links_one_target" CHECK (("mail_links"."issue_key" IS NOT NULL) <> ("mail_links"."note_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "mails" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"from_name" text,
	"from_address" text,
	"received_at" bigint,
	"web_link" text,
	"internet_message_id" text,
	"exchange_id" text,
	"source" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "mails_source" CHECK ("mails"."source" IN ('link', 'eml', 'addin', 'graph'))
);
--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD COLUMN "mail_id" integer;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "mail_id" integer;--> statement-breakpoint
ALTER TABLE "mail_links" ADD CONSTRAINT "mail_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_links" ADD CONSTRAINT "mail_links_mail_id_mails_id_fk" FOREIGN KEY ("mail_id") REFERENCES "public"."mails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_links" ADD CONSTRAINT "mail_links_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_links" ADD CONSTRAINT "mail_links_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_links" ADD CONSTRAINT "mail_links_note_user_fk" FOREIGN KEY ("note_id","user_id") REFERENCES "public"."markdown_notes"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mails" ADD CONSTRAINT "mails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mail_links_issue" ON "mail_links" USING btree ("mail_id","connection_id","issue_key") WHERE "mail_links"."issue_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mail_links_note" ON "mail_links" USING btree ("mail_id","note_id") WHERE "mail_links"."note_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_mail_links_user_issue" ON "mail_links" USING btree ("user_id","connection_id","issue_key");--> statement-breakpoint
CREATE INDEX "idx_mail_links_note" ON "mail_links" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "idx_mails_user_recent" ON "mails" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mails_user_message" ON "mails" USING btree ("user_id","internet_message_id") WHERE "mails"."internet_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mails_user_exchange" ON "mails" USING btree ("user_id","exchange_id") WHERE "mails"."exchange_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD CONSTRAINT "pinboard_notes_mail_id_mails_id_fk" FOREIGN KEY ("mail_id") REFERENCES "public"."mails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_mail_id_mails_id_fk" FOREIGN KEY ("mail_id") REFERENCES "public"."mails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pinboard_mail" ON "pinboard_notes" USING btree ("board_id","mail_id");--> statement-breakpoint
-- A mail pinned to an issue follows it like the rest: linked to its row, renamed with its key.
CREATE TRIGGER mail_links_link_item BEFORE INSERT OR UPDATE OF issue_key, connection_id ON public.mail_links FOR EACH ROW EXECUTE FUNCTION inkledger_link_item();--> statement-breakpoint
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
    UPDATE "mail_links" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
  END IF;
  UPDATE "worklogs" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "timers" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "outbox" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "issue_notes" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "notifications" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "pinboard_notes" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "todos" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "markdown_notes" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  UPDATE "mail_links" SET "item_id" = NEW."id" WHERE "item_id" IS NULL AND "user_id" = NEW."user_id" AND "connection_id" = NEW."connection_id" AND "issue_key" = NEW."key";
  RETURN NULL;
END $function$;
