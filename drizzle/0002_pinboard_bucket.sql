ALTER TABLE "pinboards" ADD COLUMN "bucket_id" integer;--> statement-breakpoint
ALTER TABLE "pinboards" ADD CONSTRAINT "pinboards_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pinboards_bucket" ON "pinboards" USING btree ("bucket_id");