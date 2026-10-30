ALTER TABLE "markdown_note_versions" DROP CONSTRAINT "markdown_note_versions_origin";--> statement-breakpoint
ALTER TABLE "markdown_notes" ADD COLUMN "noted_on" text;--> statement-breakpoint
ALTER TABLE "markdown_notes" ADD COLUMN "ai_body" text;--> statement-breakpoint
ALTER TABLE "markdown_notes" ADD COLUMN "ai_source_revision" integer;--> statement-breakpoint
ALTER TABLE "markdown_notes" ADD COLUMN "ai_created_at" bigint;--> statement-breakpoint
CREATE INDEX "idx_markdown_notes_noted_on" ON "markdown_notes" USING btree ("user_id","noted_on") WHERE "markdown_notes"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "markdown_note_versions" ADD CONSTRAINT "markdown_note_versions_origin" CHECK ("markdown_note_versions"."origin" IN ('auto', 'manual', 'conflict', 'delete', 'restore', 'ai'));