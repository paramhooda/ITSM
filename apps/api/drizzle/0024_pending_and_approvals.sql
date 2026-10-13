ALTER TABLE "approvals" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pending_reason" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pending_waiting_on" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pending_expected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pending_reference" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pending_reason_visible" boolean;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pending_set_by" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "pending_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_pending_set_by_users_id_fk" FOREIGN KEY ("pending_set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_pending_due_idx" ON "approvals" USING btree ("due_at") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "tickets_waiting_on_idx" ON "tickets" USING btree ("pending_waiting_on") WHERE "tickets"."pending_waiting_on" IS NOT NULL;