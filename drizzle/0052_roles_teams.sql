-- Finer access: named roles (system ones seeded), teams with leads, roles held within a team.
CREATE TABLE "role_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"role_id" integer NOT NULL,
	"team_id" integer
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"permissions" text DEFAULT '[]' NOT NULL,
	"scope" text DEFAULT 'server' NOT NULL,
	"system" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "roles_scope" CHECK ("roles"."scope" IN ('server','team'))
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id"),
	CONSTRAINT "team_members_role" CHECK ("team_members"."role" IN ('member','lead'))
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role_id" integer;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_role_assignments" ON "role_assignments" USING btree ("user_id","role_id",coalesce("team_id", 0));--> statement-breakpoint
CREATE INDEX "idx_role_assignments_team" ON "role_assignments" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_roles_key" ON "roles" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idx_team_members_user" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_teams_name" ON "teams" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_teams_external" ON "teams" USING btree ("external_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The system roles. The owner holds every permission whatever is stored (api/queries/accounts.ts).
INSERT INTO "roles" ("key", "name", "permissions", "scope", "system", "created_at") VALUES
  ('owner', 'Owner', '["manageUsers","manageAuth","manageTeams","manageStore","manageServer","runBackups","restoreBackups","downloadBackups","manageRetention","viewTeamTime","useModules","viewAudit","exportAudit","exportUserData","eraseUserData"]', 'server', 1, (extract(epoch from now()) * 1000)::bigint),
  ('it-admin', 'IT admin', '["manageUsers","manageAuth","manageTeams","manageStore","manageServer","runBackups","viewAudit","exportAudit"]', 'server', 1, (extract(epoch from now()) * 1000)::bigint),
  ('team-lead', 'Team lead', '["viewTeamTime"]', 'team', 1, (extract(epoch from now()) * 1000)::bigint),
  ('auditor', 'Auditor', '["viewAudit","exportAudit"]', 'server', 1, (extract(epoch from now()) * 1000)::bigint),
  ('member', 'Member', '[]', 'server', 1, (extract(epoch from now()) * 1000)::bigint);--> statement-breakpoint
-- Today's admins are owners (users.role stays 'admin' for older builds).
UPDATE "users" SET "role_id" = (SELECT "id" FROM "roles" WHERE "key" = 'owner') WHERE "role" = 'admin';--> statement-breakpoint
-- manageBackups splits: it maps to running them only, so nobody gains a dump or a restore.
UPDATE "users" SET "permissions" = replace("permissions", '"manageBackups"', '"runBackups"') WHERE "permissions" LIKE '%"manageBackups"%';--> statement-breakpoint
-- The audit log's retention was manageServer's: whoever held it keeps it.
UPDATE "users" SET "permissions" = regexp_replace("permissions", '\]\s*$', ',"manageRetention"]') WHERE "permissions" LIKE '%"manageServer"%' AND "permissions" NOT LIKE '%"manageRetention"%';
