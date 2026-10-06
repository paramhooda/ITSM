CREATE TABLE "whatsapp_inbound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_message_id" text NOT NULL,
	"phone" text NOT NULL,
	"display_name" text,
	"user_id" uuid,
	"kind" text DEFAULT 'text' NOT NULL,
	"text" text,
	"context_message_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"outcome" text,
	"conversation_id" uuid,
	"reply_outbox_id" uuid,
	"error" text,
	"received_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_inbound" ADD CONSTRAINT "whatsapp_inbound_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_inbound" ADD CONSTRAINT "whatsapp_inbound_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_inbound" ADD CONSTRAINT "whatsapp_inbound_reply_outbox_id_notification_outbox_id_fk" FOREIGN KEY ("reply_outbox_id") REFERENCES "public"."notification_outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_inbound_provider_idx" ON "whatsapp_inbound" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "whatsapp_inbound_phone_idx" ON "whatsapp_inbound" USING btree ("phone","received_at");--> statement-breakpoint
CREATE INDEX "whatsapp_inbound_user_idx" ON "whatsapp_inbound" USING btree ("user_id","received_at");--> statement-breakpoint
CREATE INDEX "whatsapp_inbound_status_idx" ON "whatsapp_inbound" USING btree ("status","created_at");