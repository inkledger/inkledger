ALTER TABLE "settings" ADD COLUMN "theme_variant" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "theme_contrast" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_theme_variant" CHECK ("settings"."theme_variant" IN ('standard', 'soft'));--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_theme_contrast" CHECK ("settings"."theme_contrast" IN ('normal', 'high', 'system'));