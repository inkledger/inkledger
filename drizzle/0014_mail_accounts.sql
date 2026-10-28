CREATE TABLE "mail_accounts" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"display_name" text,
	"secret" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_addin_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_addin_keys" ADD CONSTRAINT "mail_addin_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mail_addin_keys_hash" ON "mail_addin_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_mail_addin_keys_user" ON "mail_addin_keys" USING btree ("user_id");