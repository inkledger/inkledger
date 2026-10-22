ALTER TABLE "issues" ADD COLUMN "components" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "pinboards" ADD COLUMN "follow_field" text;--> statement-breakpoint
ALTER TABLE "pinboards" ADD COLUMN "follow_value" text;--> statement-breakpoint
ALTER TABLE "pinboards" ADD COLUMN "follow_connection_id" integer;--> statement-breakpoint
ALTER TABLE "pinboards" ADD CONSTRAINT "pinboards_follow_connection_id_connections_id_fk" FOREIGN KEY ("follow_connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;