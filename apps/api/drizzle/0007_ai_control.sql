ALTER TABLE "ai_messages" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "feedback" text;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD COLUMN "feedback_note" text;--> statement-breakpoint
CREATE INDEX "ai_conversations_updated_idx" ON "ai_conversations" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "ai_messages_created_idx" ON "ai_messages" USING btree ("created_at");--> statement-breakpoint
-- The feature switches moved to ai.disabled_features; the old allow-list is retired.
DELETE FROM "system_settings" WHERE "key" = 'ai.enabled_features';
