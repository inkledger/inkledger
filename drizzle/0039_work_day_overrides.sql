CREATE TABLE "work_day_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"day" text NOT NULL,
	"work_day" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_day_overrides" ADD CONSTRAINT "work_day_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_day_overrides_user_day" ON "work_day_overrides" USING btree ("user_id","day");