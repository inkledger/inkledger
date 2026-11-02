CREATE TABLE "desks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text,
	"layout" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "desks" ADD CONSTRAINT "desks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_desks_user_current" ON "desks" USING btree ("user_id") WHERE "desks"."name" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_desks_user_name" ON "desks" USING btree ("user_id",lower("name")) WHERE "desks"."name" IS NOT NULL;