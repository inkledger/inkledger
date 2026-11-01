ALTER TABLE "workspace_presentations" DROP CONSTRAINT IF EXISTS "workspace_presentations_user_id_client_instance_id_pk";--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_presentations_user_id_client_instance_id_surface_id_device_class_pk') THEN
    ALTER TABLE "workspace_presentations" ADD CONSTRAINT "workspace_presentations_user_id_client_instance_id_surface_id_device_class_pk" PRIMARY KEY("user_id","client_instance_id","surface_id","device_class");
  END IF;
END $$;