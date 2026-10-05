ALTER TABLE "problem_details" ADD COLUMN "ke_status" text;--> statement-breakpoint
ALTER TABLE "problem_details" ADD COLUMN "ke_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "problem_details" ADD COLUMN "ke_identified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "problem_details" ADD COLUMN "fix_change_id" uuid;--> statement-breakpoint
ALTER TABLE "problem_details" ADD COLUMN "portal_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "problem_details" ADD COLUMN "customer_summary" text;--> statement-breakpoint
ALTER TABLE "problem_details" ADD COLUMN "customer_workaround" text;--> statement-breakpoint
ALTER TABLE "problem_details" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "problem_details" ADD COLUMN "published_by" uuid;--> statement-breakpoint
ALTER TABLE "problem_details" ADD COLUMN "ke_search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(symptoms, '') || ' ' || coalesce(root_cause, '') || ' ' || coalesce(workaround, '') || ' ' || coalesce(permanent_fix, '') || ' ' || coalesce(customer_summary, '') || ' ' || coalesce(customer_workaround, ''))) STORED;--> statement-breakpoint
ALTER TABLE "problem_details" ADD CONSTRAINT "problem_details_fix_change_id_tickets_id_fk" FOREIGN KEY ("fix_change_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_details" ADD CONSTRAINT "problem_details_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "problem_details_ke_idx" ON "problem_details" USING btree ("customer_id","is_known_error");--> statement-breakpoint
CREATE INDEX "problem_details_fix_change_idx" ON "problem_details" USING btree ("fix_change_id");--> statement-breakpoint
CREATE INDEX "problem_details_ke_search_idx" ON "problem_details" USING gin ("ke_search_vector");