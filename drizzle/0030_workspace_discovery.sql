CREATE TABLE IF NOT EXISTS "workspace_discovery" (
	"user_id" integer NOT NULL,
	"surface_id" text NOT NULL,
	"device_class" text NOT NULL,
	"seen_anchor_ids" text DEFAULT '[]' NOT NULL,
	"placed_anchor_ids" text DEFAULT '[]' NOT NULL,
	"dismissed_anchor_ids" text DEFAULT '[]' NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workspace_discovery_user_id_surface_id_device_class_pk" PRIMARY KEY("user_id","surface_id","device_class"),
	CONSTRAINT "workspace_discovery_device" CHECK ("workspace_discovery"."device_class" IN ('desktop','mobile'))
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_discovery_user_id_users_id_fk') THEN
    ALTER TABLE "workspace_discovery" ADD CONSTRAINT "workspace_discovery_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;