ALTER TABLE "audit_events" ADD COLUMN "pseudonymised_at" bigint;--> statement-breakpoint
-- Still append-only, with one more way through besides the retention purge: an erasure
-- (api/gdpr), inside its own transaction with inkledger.audit_pseudonymise set to 'on', may
-- replace who a row names (label, address, names in before/after) and mark it pseudonymised.
-- What happened, when, to what, and the chain itself never change.
CREATE OR REPLACE FUNCTION public.inkledger_audit_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('inkledger.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND current_setting('inkledger.audit_pseudonymise', true) = 'on'
    AND NEW.pseudonymised_at IS NOT NULL
    AND NEW.id = OLD.id AND NEW.at = OLD.at
    AND NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
    AND NEW.actor_kind = OLD.actor_kind AND NEW.action = OLD.action AND NEW.outcome = OLD.outcome
    AND NEW.target_type IS NOT DISTINCT FROM OLD.target_type
    AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
    AND NEW.target_owner_user_id IS NOT DISTINCT FROM OLD.target_owner_user_id
    AND NEW.request_id IS NOT DISTINCT FROM OLD.request_id
    AND NEW.prev_hash = OLD.prev_hash AND NEW.hash = OLD.hash THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only (%)', TG_OP;
END;
$function$;
