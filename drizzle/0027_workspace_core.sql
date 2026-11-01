CREATE TABLE IF NOT EXISTS "workspace_descriptors" (
	"effective_revision" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"surface_id" text NOT NULL,
	"device_class" text NOT NULL,
	"source_active_revision" text NOT NULL,
	"workspace_fingerprint" text NOT NULL,
	"descriptor" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "workspace_descriptor_device" CHECK ("workspace_descriptors"."device_class" IN ('desktop','mobile'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"surface_id" text NOT NULL,
	"device_class" text NOT NULL,
	"base_revision" text NOT NULL,
	"draft_revision" integer NOT NULL,
	"status" text NOT NULL,
	"patches" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workspace_draft_status" CHECK ("workspace_drafts"."status" IN ('editing','ready','conflict','stale','applying','applied','aborted','discarded')),
	CONSTRAINT "workspace_draft_device" CHECK ("workspace_drafts"."device_class" IN ('desktop','mobile'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"surface_id" text NOT NULL,
	"device_class" text NOT NULL,
	"kind" text NOT NULL,
	"response" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "workspace_operation_device" CHECK ("workspace_operations"."device_class" IN ('desktop','mobile'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_prepared" (
	"prepare_id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"surface_id" text NOT NULL,
	"device_class" text NOT NULL,
	"base_revision" text NOT NULL,
	"draft_revision" integer NOT NULL,
	"client_instance_id" text NOT NULL,
	"interaction_epoch" integer NOT NULL,
	"descriptor" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "workspace_prepared_device" CHECK ("workspace_prepared"."device_class" IN ('desktop','mobile'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_presentations" (
	"user_id" integer NOT NULL,
	"client_instance_id" text NOT NULL,
	"surface_id" text NOT NULL,
	"device_class" text NOT NULL,
	"status" text NOT NULL,
	"last_issued_epoch" integer NOT NULL,
	"presented_descriptor" text,
	"presented_epoch" integer,
	"pending" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workspace_presentations_user_id_client_instance_id_pk" PRIMARY KEY("user_id","client_instance_id"),
	CONSTRAINT "workspace_presentation_status" CHECK ("workspace_presentations"."status" IN ('stable','pendingActivation','activationUncertain','unknown')),
	CONSTRAINT "workspace_presentation_device" CHECK ("workspace_presentations"."device_class" IN ('desktop','mobile'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"surface_id" text NOT NULL,
	"device_class" text NOT NULL,
	"revision_number" integer NOT NULL,
	"catalog_version" text NOT NULL,
	"product_default_version" text NOT NULL,
	"committed_at" bigint NOT NULL,
	"operations" text NOT NULL,
	"constraints" text NOT NULL,
	"caused_by_revision" text,
	"status" text DEFAULT 'committed' NOT NULL,
	CONSTRAINT "workspace_revision_status" CHECK ("workspace_revisions"."status" IN ('committed','superseded')),
	CONSTRAINT "workspace_revision_device" CHECK ("workspace_revisions"."device_class" IN ('desktop','mobile'))
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_descriptors_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_descriptors" ADD CONSTRAINT "workspace_descriptors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_drafts_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_drafts" ADD CONSTRAINT "workspace_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_operations_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_prepared_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_prepared" ADD CONSTRAINT "workspace_prepared_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_presentations_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_presentations" ADD CONSTRAINT "workspace_presentations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_revisions_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_revisions" ADD CONSTRAINT "workspace_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_descriptor_source" ON "workspace_descriptors" USING btree ("user_id","surface_id","device_class","source_active_revision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_draft_scope" ON "workspace_drafts" USING btree ("user_id","surface_id","device_class","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_operation_scope" ON "workspace_operations" USING btree ("user_id","surface_id","device_class","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_prepared_client" ON "workspace_prepared" USING btree ("user_id","client_instance_id","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_presentation_scope" ON "workspace_presentations" USING btree ("user_id","surface_id","device_class","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_revision_scope" ON "workspace_revisions" USING btree ("user_id","surface_id","device_class","revision_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_revision_current" ON "workspace_revisions" USING btree ("user_id","surface_id","device_class","status","revision_number");