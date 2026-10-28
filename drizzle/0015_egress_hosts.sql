CREATE TABLE "egress_hosts" (
	"host" text PRIMARY KEY NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_status" text,
	"first_at" bigint NOT NULL,
	"last_at" bigint NOT NULL
);
