CREATE TABLE "todo_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"todo_id" integer,
	"label" text NOT NULL,
	"linked" integer DEFAULT 0 NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint
);
--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD COLUMN "todo_id" integer;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "estimate_seconds" integer;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "steps" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "repeat" text;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "repeat_of" integer;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "todo_sessions" ADD CONSTRAINT "todo_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todo_sessions" ADD CONSTRAINT "todo_sessions_todo_id_todos_id_fk" FOREIGN KEY ("todo_id") REFERENCES "public"."todos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_todo_sessions_user_start" ON "todo_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_todo_sessions_todo" ON "todo_sessions" USING btree ("todo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_todo_sessions_open" ON "todo_sessions" USING btree ("user_id") WHERE "todo_sessions"."ended_at" IS NULL;--> statement-breakpoint
ALTER TABLE "pinboard_notes" ADD CONSTRAINT "pinboard_notes_todo_id_todos_id_fk" FOREIGN KEY ("todo_id") REFERENCES "public"."todos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_repeat_of_todos_id_fk" FOREIGN KEY ("repeat_of") REFERENCES "public"."todos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pinboard_todo" ON "pinboard_notes" USING btree ("board_id","todo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_todos_user_source" ON "todos" USING btree ("user_id","source") WHERE "todos"."source" IS NOT NULL;