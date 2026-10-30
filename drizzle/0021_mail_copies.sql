CREATE TABLE "mail_copies" (
	"mail_id" integer PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"mode" text NOT NULL,
	"sealed" "bytea" NOT NULL,
	"plain_sha256" text NOT NULL,
	"plain_bytes" integer NOT NULL,
	"attachments" text DEFAULT '[]' NOT NULL,
	"source" text NOT NULL,
	"captured_at" bigint NOT NULL,
	CONSTRAINT "mail_copies_mode" CHECK ("mail_copies"."mode" IN ('body', 'full')),
	CONSTRAINT "mail_copies_source" CHECK ("mail_copies"."source" IN ('addin', 'graph', 'eml'))
);
--> statement-breakpoint
CREATE TABLE "mail_copy_reads" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"mail_id" integer NOT NULL,
	"via" text NOT NULL,
	"at" bigint NOT NULL,
	CONSTRAINT "mail_copy_reads_via" CHECK ("mail_copy_reads"."via" IN ('view', 'eml', 'attachment'))
);
--> statement-breakpoint
ALTER TABLE "mails" ADD COLUMN "gone_at" bigint;--> statement-breakpoint
ALTER TABLE "mails" ADD COLUMN "checked_at" bigint;--> statement-breakpoint
ALTER TABLE "mails" ADD COLUMN "copy_error" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "mail_copies" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "mail_copies_consent_at" bigint;--> statement-breakpoint
ALTER TABLE "mail_copies" ADD CONSTRAINT "mail_copies_mail_id_mails_id_fk" FOREIGN KEY ("mail_id") REFERENCES "public"."mails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_copies" ADD CONSTRAINT "mail_copies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_copy_reads" ADD CONSTRAINT "mail_copy_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_copy_reads" ADD CONSTRAINT "mail_copy_reads_mail_id_mails_id_fk" FOREIGN KEY ("mail_id") REFERENCES "public"."mails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mail_copies_user" ON "mail_copies" USING btree ("user_id","captured_at");--> statement-breakpoint
CREATE INDEX "idx_mail_copy_reads_at" ON "mail_copy_reads" USING btree ("at");--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_mail_copies" CHECK ("settings"."mail_copies" IN ('off', 'body', 'full'));