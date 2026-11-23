-- Jira connections from before connections were separate (legacy) kept where their syncs stand on
-- the user's sync_state: their own streams take it over, then they are connections like any other.
-- Worklogs: the user's checkpoint, unless the stream already stands later.
INSERT INTO "connection_sync" ("connection_id", "stream", "checkpoint", "last_ok_at")
SELECT c."id", 'worklogs', s."last_worklog_sync_at"::text, s."last_worklog_sync_at"
FROM "connections" c JOIN "sync_state" s ON s."user_id" = c."user_id"
WHERE c."legacy" = 1 AND s."last_worklog_sync_at" IS NOT NULL
ON CONFLICT ("connection_id", "stream") DO UPDATE SET
  "checkpoint" = CASE
    WHEN "connection_sync"."checkpoint" ~ '^[0-9]+$' AND "connection_sync"."checkpoint"::bigint >= EXCLUDED."last_ok_at" THEN "connection_sync"."checkpoint"
    ELSE EXCLUDED."checkpoint"
  END,
  "last_ok_at" = GREATEST("connection_sync"."last_ok_at", EXCLUDED."last_ok_at");--> statement-breakpoint
-- Issues: a pass already recorded (never a first sync again, which would raise no notifications).
INSERT INTO "connection_sync" ("connection_id", "stream", "last_ok_at", "last_full_at")
SELECT c."id", 'issues', s."last_sync_at", s."last_full_sync_at"
FROM "connections" c JOIN "sync_state" s ON s."user_id" = c."user_id"
WHERE c."legacy" = 1 AND (s."last_sync_at" IS NOT NULL OR s."last_full_sync_at" IS NOT NULL)
ON CONFLICT ("connection_id", "stream") DO UPDATE SET
  "last_ok_at" = COALESCE("connection_sync"."last_ok_at", EXCLUDED."last_ok_at"),
  "last_full_at" = COALESCE("connection_sync"."last_full_at", EXCLUDED."last_full_at");--> statement-breakpoint
UPDATE "connections" SET "legacy" = 0 WHERE "legacy" = 1;
