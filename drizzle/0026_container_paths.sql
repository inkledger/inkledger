CREATE TABLE "container_paths" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"container_id" integer NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"path" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "container_paths_path" CHECK (length("container_paths"."path") BETWEEN 1 AND 1000),
	CONSTRAINT "container_paths_label" CHECK (length("container_paths"."label") <= 60)
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "agent_command" text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE "container_paths" ADD CONSTRAINT "container_paths_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_paths" ADD CONSTRAINT "container_paths_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_container_paths" ON "container_paths" USING btree ("user_id","container_id","path");--> statement-breakpoint
CREATE INDEX "idx_container_paths_user" ON "container_paths" USING btree ("user_id","container_id","position");--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_agent_command" CHECK (length("settings"."agent_command") BETWEEN 1 AND 200);