ALTER TABLE "workspace_discovery" ADD COLUMN "seen_area_ids" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_discovery" ADD COLUMN "placed_area_ids" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_discovery" ADD COLUMN "dismissed_area_ids" text DEFAULT '[]' NOT NULL;