CREATE TABLE IF NOT EXISTS "workspace_imports" (
	"id" text NOT NULL,
	"user_id" integer NOT NULL,
	"surface_id" text NOT NULL,
	"device_class" text NOT NULL,
	"draft_id" text NOT NULL,
	"document" text NOT NULL,
	"has_unknown_content" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "workspace_imports_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "workspace_import_device" CHECK ("workspace_imports"."device_class" IN ('desktop','mobile'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_planner_feedback" (
	"user_id" integer NOT NULL,
	"signature" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workspace_planner_feedback_user_id_signature_pk" PRIMARY KEY("user_id","signature")
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_imports_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_imports" ADD CONSTRAINT "workspace_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_planner_feedback_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_planner_feedback" ADD CONSTRAINT "workspace_planner_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_import_draft" ON "workspace_imports" USING btree ("user_id","draft_id");