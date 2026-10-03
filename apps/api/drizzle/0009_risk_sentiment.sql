ALTER TABLE "ticket_comments" ADD COLUMN "sentiment" text;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD COLUMN "sentiment_score" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "breach_risk" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "breach_risk_score" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "breach_risk_reason" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "breach_risk_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "last_sentiment" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "last_sentiment_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tickets_breach_risk_idx" ON "tickets" USING btree ("breach_risk") WHERE "tickets"."breach_risk" IS NOT NULL;