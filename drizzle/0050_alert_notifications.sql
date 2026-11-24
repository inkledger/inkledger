-- Server alerts (a failed backup, a licence renewal, the HTTPS certificate) reach admins as notifications about no tracker.
ALTER TABLE "notifications" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.inkledger_fill_connection()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  found integer[];
  owners integer[];
BEGIN
  IF NEW."connection_id" IS NOT NULL THEN RETURN NEW; END IF;
  -- A free note on a board (no issue) has no connection. Nested: plpgsql
  -- doesn't short-circuit AND, and other tables have no issue_key.
  IF TG_TABLE_NAME = 'pinboard_notes' THEN
    IF NEW."issue_key" IS NULL THEN RETURN NEW; END IF;
  END IF;
  -- A server alert (a backup, a licence, the certificate) is about no tracker.
  IF TG_TABLE_NAME = 'notifications' THEN
    IF NEW."kind" = 'alert' THEN RETURN NEW; END IF;
  END IF;
  SELECT array_agg("id") INTO found FROM "connections" WHERE "user_id" = NEW."user_id" AND "archived_at" IS NULL;
  IF coalesce(array_length(found, 1), 0) = 1 THEN
    NEW."connection_id" := found[1];
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME <> 'issues' THEN
    SELECT array_agg(DISTINCT i."connection_id") INTO owners
    FROM "issues" i JOIN "connections" c ON c."id" = i."connection_id"
    WHERE i."user_id" = NEW."user_id" AND i."key" = NEW."issue_key" AND c."archived_at" IS NULL;
    IF coalesce(array_length(owners, 1), 0) = 1 THEN
      NEW."connection_id" := owners[1];
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '%: connection_id is required (user % has % live connections)', TG_TABLE_NAME, NEW."user_id", coalesce(array_length(found, 1), 0);
END $function$;
