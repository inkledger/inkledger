ALTER TABLE "settings" ADD COLUMN "pinboard_on_board" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "pinboard_in_menu" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "pinboard_widget" integer DEFAULT 1 NOT NULL;