CREATE TABLE "planned_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"kind" text NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"note" text,
	"connection_id" integer,
	"item_id" integer,
	"issue_key" text,
	"converted_worklog_id" integer,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "planned_entries_kind" CHECK ("planned_entries"."kind" IN ('work', 'travel', 'vacation')),
	CONSTRAINT "planned_entries_interval" CHECK ("planned_entries"."ends_at" > "planned_entries"."starts_at"),
	CONSTRAINT "planned_entries_issue_has_connection" CHECK ("planned_entries"."issue_key" IS NULL OR "planned_entries"."connection_id" IS NOT NULL),
	CONSTRAINT "planned_entries_work_has_issue" CHECK ("planned_entries"."kind" <> 'work' OR ("planned_entries"."connection_id" IS NOT NULL AND "planned_entries"."issue_key" IS NOT NULL)),
	CONSTRAINT "planned_entries_vacation_user_level" CHECK ("planned_entries"."kind" <> 'vacation' OR ("planned_entries"."connection_id" IS NULL AND "planned_entries"."item_id" IS NULL AND "planned_entries"."issue_key" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "planned_entries" ADD CONSTRAINT "planned_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_entries" ADD CONSTRAINT "planned_entries_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_entries" ADD CONSTRAINT "planned_entries_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_entries" ADD CONSTRAINT "planned_entries_converted_worklog_id_worklogs_id_fk" FOREIGN KEY ("converted_worklog_id") REFERENCES "public"."worklogs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_planned_entries_user_interval" ON "planned_entries" USING btree ("user_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "idx_planned_entries_issue" ON "planned_entries" USING btree ("user_id","connection_id","issue_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_planned_entries_converted_worklog" ON "planned_entries" USING btree ("converted_worklog_id");--> statement-breakpoint
CREATE TRIGGER planned_entries_link_item BEFORE INSERT OR UPDATE OF issue_key, connection_id ON public.planned_entries FOR EACH ROW EXECUTE FUNCTION inkledger_link_item();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_planned_entries_issue_key()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "planned_entries" SET "issue_key" = NEW."key" WHERE "item_id" = NEW."id";
  RETURN NULL;
END $function$;--> statement-breakpoint
CREATE TRIGGER planned_entries_follow_issue_key AFTER UPDATE OF key ON public.issues FOR EACH ROW WHEN (OLD.key IS DISTINCT FROM NEW.key) EXECUTE FUNCTION inkledger_planned_entries_issue_key();