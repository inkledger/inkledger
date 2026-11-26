-- Feedback accepted by inkledger's developers and made public: the public issue and the draft
-- proposal pull request the feedback inbox opened, and their states (read back with the daily sync).
ALTER TABLE "feedback" ADD COLUMN "public_issue_url" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "public_issue_state" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "public_pr_url" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "public_pr_state" text;