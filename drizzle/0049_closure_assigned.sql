ALTER TABLE "issue_closures" ADD COLUMN "assigned" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Recorded with whether the issue was the user's (assigned to their account on the connection) when it closed.
CREATE OR REPLACE FUNCTION public.inkledger_issue_closed()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "issue_closures" ("user_id", "item_id", "closed_at", "assigned")
  VALUES (NEW."user_id", NEW."id", CASE
    WHEN NEW."status_changed_at" IS NOT NULL AND NEW."status_changed_at" IS DISTINCT FROM OLD."status_changed_at" THEN NEW."status_changed_at"
    ELSE (extract(epoch from now()) * 1000)::bigint
  END, CASE WHEN NEW."assignee_id" <> '' AND EXISTS (
    SELECT 1 FROM "connections" c WHERE c."id" = NEW."connection_id" AND c."remote_account_id" = NEW."assignee_id"
  ) THEN 1 ELSE 0 END)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
-- The ones recorded before: by their assignee now (all the catalogue knows).
UPDATE "issue_closures" ic SET "assigned" = 1
FROM "issues" i JOIN "connections" c ON c."id" = i."connection_id"
WHERE i."id" = ic."item_id" AND i."assignee_id" <> '' AND i."assignee_id" = c."remote_account_id";
