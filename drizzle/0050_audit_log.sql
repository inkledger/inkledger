CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"actor_user_id" integer,
	"actor_label" text DEFAULT '' NOT NULL,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"outcome" text DEFAULT 'ok' NOT NULL,
	"target_type" text,
	"target_id" text,
	"target_owner_user_id" integer,
	"ip" text,
	"user_agent_hash" text,
	"request_id" text,
	"before" text,
	"after" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "audit_events_actor_kind" CHECK ("audit_events"."actor_kind" IN ('user','system','sync','scim','cli')),
	CONSTRAINT "audit_events_outcome" CHECK ("audit_events"."outcome" IN ('ok','denied','failed'))
);
--> statement-breakpoint
CREATE INDEX "idx_audit_events_at" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "idx_audit_events_actor_at" ON "audit_events" USING btree ("actor_user_id","at");--> statement-breakpoint
CREATE INDEX "idx_audit_events_target" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
-- Append-only: no row is changed, none removed, the table never emptied. Only the retention
-- purge deletes, inside its own transaction with inkledger.audit_purge set to 'on'.
CREATE OR REPLACE FUNCTION public.inkledger_audit_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('inkledger.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only (%)', TG_OP;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION inkledger_audit_append_only();--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON public.audit_events FOR EACH STATEMENT EXECUTE FUNCTION inkledger_audit_append_only();
