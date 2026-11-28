-- Chats about an issue between teammates (contracts/chat.ts): threads anchored to the issue's
-- identity on its tracker, their members, messages, files (sealed) and reactions.
CREATE TABLE "chat_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"message_id" integer,
	"uploader_id" integer,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"data" "bytea" NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "chat_files_name" CHECK (length("chat_files"."name") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "chat_members" (
	"thread_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" bigint NOT NULL,
	"left_at" bigint,
	"last_read_id" integer DEFAULT 0 NOT NULL,
	"muted" integer DEFAULT 0 NOT NULL,
	"pinned" integer DEFAULT 0 NOT NULL,
	"archived_at" bigint,
	CONSTRAINT "chat_members_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id"),
	CONSTRAINT "chat_members_role" CHECK ("chat_members"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"author_id" integer,
	"kind" text DEFAULT 'text' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"system" text,
	"refs" text DEFAULT '[]' NOT NULL,
	"reply_to_id" integer,
	"client_nonce" text,
	"jira_comment_id" text,
	"edited_at" bigint,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "chat_messages_kind" CHECK ("chat_messages"."kind" IN ('text', 'system')),
	CONSTRAINT "chat_messages_body" CHECK (length("chat_messages"."body") <= 10000)
);
--> statement-breakpoint
CREATE TABLE "chat_reactions" (
	"message_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"emoji" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "chat_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"uid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" integer,
	"tracker_type" text NOT NULL,
	"tracker_base" text NOT NULL,
	"issue_remote_id" text NOT NULL,
	"issue_key" text NOT NULL,
	"issue_title" text DEFAULT '' NOT NULL,
	"issue_status" text DEFAULT '' NOT NULL,
	"issue_category" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"resolved_by" integer,
	"resolved_at" bigint,
	"created_at" bigint NOT NULL,
	"last_message_at" bigint NOT NULL,
	CONSTRAINT "chat_threads_state" CHECK ("chat_threads"."state" IN ('open', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "chat_files" ADD CONSTRAINT "chat_files_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_files" ADD CONSTRAINT "chat_files_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_files" ADD CONSTRAINT "chat_files_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_reply_to_id_chat_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reactions" ADD CONSTRAINT "chat_reactions_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reactions" ADD CONSTRAINT "chat_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_files_thread" ON "chat_files" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_chat_files_message" ON "chat_files" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_chat_members_user" ON "chat_members" USING btree ("user_id","left_at");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_thread" ON "chat_messages" USING btree ("thread_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chat_messages_nonce" ON "chat_messages" USING btree ("author_id","client_nonce");--> statement-breakpoint
CREATE INDEX "idx_chat_reactions_user" ON "chat_reactions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chat_threads_uid" ON "chat_threads" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "idx_chat_threads_issue" ON "chat_threads" USING btree ("tracker_type","tracker_base","issue_remote_id");