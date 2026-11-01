ALTER TABLE "workspace_descriptors" ALTER COLUMN "effective_revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_drafts" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_operations" ALTER COLUMN "operation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_prepared" ALTER COLUMN "prepare_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_revisions" ALTER COLUMN "id" SET NOT NULL;