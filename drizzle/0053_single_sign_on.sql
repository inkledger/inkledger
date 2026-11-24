CREATE TABLE "identity_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"issuer" text DEFAULT '' NOT NULL,
	"client_id" text DEFAULT '' NOT NULL,
	"client_secret_sealed" text,
	"discovery_url" text,
	"tenant_id" text,
	"saml_entry_point" text,
	"saml_idp_cert" text,
	"scopes" text DEFAULT 'openid email profile' NOT NULL,
	"claim_map" text DEFAULT '{}' NOT NULL,
	"group_map" text DEFAULT '[]' NOT NULL,
	"jit_enabled" integer DEFAULT 0 NOT NULL,
	"default_access" text DEFAULT '{}' NOT NULL,
	"enforced" integer DEFAULT 0 NOT NULL,
	"disabled_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "identity_providers_kind" CHECK ("identity_providers"."kind" IN ('oidc','saml'))
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_by" integer,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "sso_states" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" integer NOT NULL,
	"nonce" text DEFAULT '' NOT NULL,
	"pkce_verifier" text DEFAULT '' NOT NULL,
	"relay" text DEFAULT '/' NOT NULL,
	"mode" text DEFAULT 'login' NOT NULL,
	"user_id" integer,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider_id" integer NOT NULL,
	"subject" text NOT NULL,
	"email_at_link" text DEFAULT '' NOT NULL,
	"last_login_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_source" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "break_glass" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "scim_managed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "scim_user_name" text;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_states" ADD CONSTRAINT "sso_states_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_states" ADD CONSTRAINT "sso_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_scim_tokens_hash" ON "scim_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_scim_tokens_provider" ON "scim_tokens" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_sso_states_expires" ON "sso_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_identities_subject" ON "user_identities" USING btree ("provider_id","subject");--> statement-breakpoint
CREATE INDEX "idx_user_identities_user" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_scim_user_name" ON "users" USING btree (lower("scim_user_name"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_auth_source" CHECK ("users"."auth_source" IN ('local','sso','scim'));