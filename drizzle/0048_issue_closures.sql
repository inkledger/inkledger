CREATE TABLE "issue_closures" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"closed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "module_closure_claims" (
	"user_id" integer NOT NULL,
	"module_id" text NOT NULL,
	"closure_id" integer NOT NULL,
	CONSTRAINT "module_closure_claims_user_id_module_id_closure_id_pk" PRIMARY KEY("user_id","module_id","closure_id")
);
--> statement-breakpoint
ALTER TABLE "issue_closures" ADD CONSTRAINT "issue_closures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_closures" ADD CONSTRAINT "issue_closures_item_id_issues_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_closure_claims" ADD CONSTRAINT "module_closure_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_closure_claims" ADD CONSTRAINT "module_closure_claims_closure_id_issue_closures_id_fk" FOREIGN KEY ("closure_id") REFERENCES "public"."issue_closures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_issue_closures_item_at" ON "issue_closures" USING btree ("item_id","closed_at");--> statement-breakpoint
CREATE INDEX "idx_issue_closures_user_at" ON "issue_closures" USING btree ("user_id","closed_at");--> statement-breakpoint
-- A move into done, from any writer of issues; an issue first seen done is no closure now.
CREATE OR REPLACE FUNCTION public.inkledger_issue_closed()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "issue_closures" ("user_id", "item_id", "closed_at")
  VALUES (NEW."user_id", NEW."id", CASE
    WHEN NEW."status_changed_at" IS NOT NULL AND NEW."status_changed_at" IS DISTINCT FROM OLD."status_changed_at" THEN NEW."status_changed_at"
    ELSE (extract(epoch from now()) * 1000)::bigint
  END)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER issues_closed AFTER UPDATE OF category ON public.issues FOR EACH ROW WHEN (NEW."category" = 'done' AND OLD."category" IS DISTINCT FROM 'done') EXECUTE FUNCTION inkledger_issue_closed();--> statement-breakpoint
-- The closures before this, as far as the catalogue knows them (the last move into done of each issue).
INSERT INTO "issue_closures" ("user_id", "item_id", "closed_at")
SELECT "user_id", "id", "status_changed_at" FROM "issues" WHERE "category" = 'done' AND "status_changed_at" IS NOT NULL
ON CONFLICT DO NOTHING;
