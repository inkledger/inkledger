CREATE TABLE IF NOT EXISTS "workspace_flow_aggregates" (
	"user_id" integer NOT NULL,
	"id" text NOT NULL,
	"surface_id" text NOT NULL,
	"device_class" text NOT NULL,
	"effective_revision" text NOT NULL,
	"origin" text DEFAULT 'local' NOT NULL,
	"payload" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "workspace_flow_aggregates_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "flow_aggregates_origin" CHECK ("workspace_flow_aggregates"."origin" IN ('local','import')),
	CONSTRAINT "flow_aggregates_device" CHECK ("workspace_flow_aggregates"."device_class" IN ('desktop','mobile'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_flow_events" (
	"user_id" integer NOT NULL,
	"id" text NOT NULL,
	"surface_id" text NOT NULL,
	"device_class" text NOT NULL,
	"effective_revision" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	"payload" text NOT NULL,
	"received_at" bigint NOT NULL,
	CONSTRAINT "workspace_flow_events_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "flow_events_device" CHECK ("workspace_flow_events"."device_class" IN ('desktop','mobile'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_flow_feedback" (
	"user_id" integer NOT NULL,
	"id" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workspace_flow_feedback_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "flow_feedback_status" CHECK ("workspace_flow_feedback"."status" IN ('unconfirmed','confirmed','rejected'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_flow_imports" (
	"user_id" integer NOT NULL,
	"id" text NOT NULL,
	"surface_id" text NOT NULL,
	"device_class" text NOT NULL,
	"document" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "workspace_flow_imports_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "flow_imports_device" CHECK ("workspace_flow_imports"."device_class" IN ('desktop','mobile'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_flow_settings" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"raw_retention_days" integer DEFAULT 30 NOT NULL,
	"aggregate_retention_days" integer DEFAULT 365 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_flow_aggregates_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_flow_aggregates" ADD CONSTRAINT "workspace_flow_aggregates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_flow_events_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_flow_events" ADD CONSTRAINT "workspace_flow_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_flow_feedback_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_flow_feedback" ADD CONSTRAINT "workspace_flow_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_flow_imports_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_flow_imports" ADD CONSTRAINT "workspace_flow_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_flow_settings_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_flow_settings" ADD CONSTRAINT "workspace_flow_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flow_aggregates_scope" ON "workspace_flow_aggregates" USING btree ("user_id","surface_id","device_class","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flow_events_scope_revision" ON "workspace_flow_events" USING btree ("user_id","surface_id","device_class","effective_revision","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_flow_imports_scope" ON "workspace_flow_imports" USING btree ("user_id","surface_id","device_class","created_at");