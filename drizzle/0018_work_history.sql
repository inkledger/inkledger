CREATE TABLE "estimate_revisions" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_history_reads" (
	"item_id" integer PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"state" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"read_at" bigint,
	"source_updated_at" bigint,
	"status_id_at_read" text,
	"changes" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint,
	"reason" text,
	CONSTRAINT "issue_history_reads_state" CHECK ("issue_history_reads"."state" IN ('available','pending','unsupported','stale','retry','invalid'))
);
--> statement-breakpoint
CREATE TABLE "issue_status_changes" (
	"item_id" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"at" bigint NOT NULL,
	"from_status_id" text,
	"to_status_id" text NOT NULL,
	CONSTRAINT "issue_status_changes_item_id_ordinal_pk" PRIMARY KEY("item_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "status_snapshots" (
	"connection_id" integer NOT NULL,
	"status_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"seen_at" bigint NOT NULL,
	CONSTRAINT "status_snapshots_connection_id_status_id_pk" PRIMARY KEY("connection_id","status_id")
);
--> statement-breakpoint
CREATE TABLE "work_statuses" (
	"user_id" integer NOT NULL,
	"connection_id" integer NOT NULL,
	"status_id" text NOT NULL,
	"counts" integer NOT NULL,
	CONSTRAINT "work_statuses_user_id_connection_id_status_id_pk" PRIMARY KEY("user_id","connection_id","status_id")
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "status_id" text;--> statement-breakpoint
ALTER TABLE "estimate_revisions" ADD CONSTRAINT "estimate_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_history_reads" ADD CONSTRAINT "issue_history_reads_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_history_reads" ADD CONSTRAINT "issue_history_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_status_changes" ADD CONSTRAINT "issue_status_changes_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_snapshots" ADD CONSTRAINT "status_snapshots_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_statuses" ADD CONSTRAINT "work_statuses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_statuses" ADD CONSTRAINT "work_statuses_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_issue_history_reads_due" ON "issue_history_reads" USING btree ("user_id","state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_issue_status_changes_order" ON "issue_status_changes" USING btree ("item_id","at","ordinal");--> statement-breakpoint
-- Estimates (docs/work/ideas/estimates.md R-3.12, R-3.15): every write that changes an estimate raises the
-- user's revision in its own transaction, whichever code path made it; one atomic statement, never read-then-write.
CREATE OR REPLACE FUNCTION public.inkledger_raise_estimate_revision(uid integer)
 RETURNS void
 LANGUAGE sql
AS $function$
  INSERT INTO "estimate_revisions" ("user_id", "revision") VALUES (uid, 1)
  ON CONFLICT ("user_id") DO UPDATE SET "revision" = "estimate_revisions"."revision" + 1;
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_issue_estimates()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  staled integer := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM inkledger_raise_estimate_revision(OLD."user_id");
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- A read the issue has moved past is stale: a later update on the tracker, or another status (a reopening too).
    UPDATE "issue_history_reads" r SET "state" = 'stale', "generation" = r."generation" + 1
     WHERE r."item_id" = NEW."id" AND r."state" IN ('available', 'invalid')
       AND (NEW."jira_updated_at" > r."source_updated_at" OR NEW."status_id" IS DISTINCT FROM r."status_id_at_read");
    GET DIAGNOSTICS staled = ROW_COUNT;
    IF staled = 0
       AND NEW."user_id" = OLD."user_id"
       AND NEW."category" IS NOT DISTINCT FROM OLD."category"
       AND NEW."status_id" IS NOT DISTINCT FROM OLD."status_id"
       AND NEW."issue_type" IS NOT DISTINCT FROM OLD."issue_type"
       AND NEW."components" IS NOT DISTINCT FROM OLD."components"
       AND NEW."container_id" IS NOT DISTINCT FROM OLD."container_id"
       AND NEW."time_estimate_seconds" IS NOT DISTINCT FROM OLD."time_estimate_seconds"
       AND NEW."summary" IS NOT DISTINCT FROM OLD."summary"
       AND NEW."gone_at" IS NOT DISTINCT FROM OLD."gone_at" THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM inkledger_raise_estimate_revision(NEW."user_id");
  RETURN NULL;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER issues_estimates AFTER INSERT OR UPDATE OR DELETE ON public.issues FOR EACH ROW EXECUTE FUNCTION inkledger_issue_estimates();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_worklog_estimates()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."user_id" = OLD."user_id"
     AND NEW."time_spent_seconds" IS NOT DISTINCT FROM OLD."time_spent_seconds"
     AND NEW."started" IS NOT DISTINCT FROM OLD."started"
     AND NEW."item_id" IS NOT DISTINCT FROM OLD."item_id"
     AND NEW."connection_id" IS NOT DISTINCT FROM OLD."connection_id"
     AND NEW."issue_key" IS NOT DISTINCT FROM OLD."issue_key" THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN PERFORM inkledger_raise_estimate_revision(OLD."user_id"); END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW."user_id" <> OLD."user_id") THEN PERFORM inkledger_raise_estimate_revision(NEW."user_id"); END IF;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER worklogs_estimates AFTER INSERT OR UPDATE OR DELETE ON public.worklogs FOR EACH ROW EXECUTE FUNCTION inkledger_worklog_estimates();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_todo_estimates()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND NEW."estimate_seconds" IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' AND OLD."estimate_seconds" IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW."estimate_seconds" IS NOT DISTINCT FROM OLD."estimate_seconds" THEN RETURN NULL; END IF;
  PERFORM inkledger_raise_estimate_revision(CASE WHEN TG_OP = 'DELETE' THEN OLD."user_id" ELSE NEW."user_id" END);
  RETURN NULL;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER todos_estimates AFTER INSERT OR UPDATE OR DELETE ON public.todos FOR EACH ROW EXECUTE FUNCTION inkledger_todo_estimates();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_user_estimates()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM inkledger_raise_estimate_revision(CASE WHEN TG_OP = 'DELETE' THEN OLD."user_id" ELSE NEW."user_id" END);
  RETURN NULL;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER todo_sessions_estimates AFTER INSERT OR UPDATE OR DELETE ON public.todo_sessions FOR EACH ROW EXECUTE FUNCTION inkledger_user_estimates();--> statement-breakpoint
CREATE TRIGGER work_statuses_estimates AFTER INSERT OR UPDATE OR DELETE ON public.work_statuses FOR EACH ROW EXECUTE FUNCTION inkledger_user_estimates();
