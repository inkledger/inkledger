CREATE TABLE "timer_ops" (
	"user_id" integer NOT NULL,
	"op_id" text NOT NULL,
	"result" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "timer_ops_user_id_op_id_pk" PRIMARY KEY("user_id","op_id")
);
--> statement-breakpoint
ALTER TABLE "timers" ADD COLUMN "owner_device" text;--> statement-breakpoint
ALTER TABLE "timers" ADD COLUMN "owner_label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "timers" ADD COLUMN "lease_until" bigint;--> statement-breakpoint
ALTER TABLE "timers" ADD COLUMN "epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "timer_ops" ADD CONSTRAINT "timer_ops_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_timer_ops_created" ON "timer_ops" USING btree ("created_at");