DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT table_name, constraint_name
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name IN ('workspace_descriptors', 'workspace_drafts', 'workspace_operations', 'workspace_prepared', 'workspace_revisions')
      AND constraint_type = 'PRIMARY KEY'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', constraint_row.table_name, constraint_row.constraint_name);
  END LOOP;
END $$;--> statement-breakpoint

ALTER TABLE "workspace_descriptors" ALTER COLUMN "effective_revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_drafts" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_operations" ALTER COLUMN "operation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_prepared" ALTER COLUMN "prepare_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_revisions" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "workspace_descriptors" ADD CONSTRAINT "workspace_descriptors_user_id_effective_revision_pk" PRIMARY KEY("user_id","effective_revision");--> statement-breakpoint
ALTER TABLE "workspace_drafts" ADD CONSTRAINT "workspace_drafts_user_id_id_pk" PRIMARY KEY("user_id","id");--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_user_id_operation_id_pk" PRIMARY KEY("user_id","operation_id");--> statement-breakpoint
ALTER TABLE "workspace_prepared" ADD CONSTRAINT "workspace_prepared_user_id_prepare_id_pk" PRIMARY KEY("user_id","prepare_id");--> statement-breakpoint
ALTER TABLE "workspace_revisions" ADD CONSTRAINT "workspace_revisions_user_id_id_pk" PRIMARY KEY("user_id","id");
