ALTER TABLE "contacts" ADD COLUMN "whatsapp_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "whatsapp_opted_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "whatsapp_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "whatsapp_opted_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "delivery_status" text;--> statement-breakpoint
CREATE INDEX "notification_outbox_channel_idx" ON "notification_outbox" USING btree ("channel","status");--> statement-breakpoint
CREATE INDEX "notification_outbox_provider_idx" ON "notification_outbox" USING btree ("provider_message_id");