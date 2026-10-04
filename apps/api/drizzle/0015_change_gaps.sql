ALTER TABLE "cab_meetings" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "cab_meetings" ADD COLUMN "attendee_user_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX "cab_meetings_status_idx" ON "cab_meetings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "change_details_window_idx" ON "change_details" USING btree ("scheduled_start");--> statement-breakpoint
CREATE INDEX "change_details_template_idx" ON "change_details" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "change_details_cab_idx" ON "change_details" USING btree ("cab_meeting_id");