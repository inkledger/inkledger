ALTER TABLE "settings" ADD COLUMN "share_link_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "share_link_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_share_link_minutes" CHECK ("settings"."share_link_minutes" BETWEEN 5 AND 1440);