CREATE TABLE "idea_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"idea_id" integer NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "idea_files_name" CHECK (length("idea_files"."name") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "idea_files" ADD CONSTRAINT "idea_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_files" ADD CONSTRAINT "idea_files_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_idea_files_idea" ON "idea_files" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "idx_idea_files_user" ON "idea_files" USING btree ("user_id");