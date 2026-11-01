ALTER TABLE "workspace_drafts" DROP CONSTRAINT "workspace_drafts_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "workspace_operations" DROP CONSTRAINT "workspace_operations_user_id_operation_id_pk";--> statement-breakpoint
ALTER TABLE "workspace_prepared" DROP CONSTRAINT "workspace_prepared_user_id_prepare_id_pk";--> statement-breakpoint
ALTER TABLE "workspace_drafts" ADD CONSTRAINT "workspace_drafts_user_id_surface_id_device_class_id_pk" PRIMARY KEY("user_id","surface_id","device_class","id");--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_user_id_surface_id_device_class_operation_id_pk" PRIMARY KEY("user_id","surface_id","device_class","operation_id");--> statement-breakpoint
ALTER TABLE "workspace_prepared" ADD CONSTRAINT "workspace_prepared_user_id_surface_id_device_class_prepare_id_pk" PRIMARY KEY("user_id","surface_id","device_class","prepare_id");--> statement-breakpoint
ALTER TABLE "workspace_revisions" ADD COLUMN "opaque" text DEFAULT '[]' NOT NULL;