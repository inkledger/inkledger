-- Per-person modules: offers (to a person or a team, who buys for themselves) and the ledger of licences (one holder each, who paid).
CREATE TABLE "module_licences" (
	"licence_id" text PRIMARY KEY NOT NULL,
	"product" text NOT NULL,
	"holder_user_id" integer,
	"payer_kind" text NOT NULL,
	"payer_id" integer,
	"bought_by" integer,
	"created_at" bigint NOT NULL,
	CONSTRAINT "module_licences_payer" CHECK ("module_licences"."payer_kind" IN ('user','team'))
);
--> statement-breakpoint
CREATE TABLE "module_offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"product" text NOT NULL,
	"user_id" integer,
	"team_id" integer,
	"offered_by" integer,
	"created_at" bigint NOT NULL,
	CONSTRAINT "module_offers_one" CHECK (("module_offers"."user_id" IS NULL) <> ("module_offers"."team_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "module_licences" ADD CONSTRAINT "module_licences_holder_user_id_users_id_fk" FOREIGN KEY ("holder_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_licences" ADD CONSTRAINT "module_licences_bought_by_users_id_fk" FOREIGN KEY ("bought_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_offers" ADD CONSTRAINT "module_offers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_offers" ADD CONSTRAINT "module_offers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_offers" ADD CONSTRAINT "module_offers_offered_by_users_id_fk" FOREIGN KEY ("offered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_module_licences_holder" ON "module_licences" USING btree ("product","holder_user_id");--> statement-breakpoint
CREATE INDEX "idx_module_licences_product" ON "module_licences" USING btree ("product");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_module_offers" ON "module_offers" USING btree ("product",coalesce("user_id", 0),coalesce("team_id", 0));