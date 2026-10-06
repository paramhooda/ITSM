CREATE TABLE "notification_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"email_default" boolean DEFAULT true NOT NULL,
	"email_locked" boolean DEFAULT false NOT NULL,
	"whatsapp_default" boolean DEFAULT true NOT NULL,
	"whatsapp_locked" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"method" text DEFAULT 'sent' NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "whatsapp_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_categories_key_idx" ON "notification_categories" USING btree ("key");--> statement-breakpoint
CREATE INDEX "phone_verifications_user_idx" ON "phone_verifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "phone_verifications_phone_idx" ON "phone_verifications" USING btree ("phone","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_whatsapp_verified_phone_idx" ON "users" USING btree ("phone") WHERE whatsapp_verified_at IS NOT NULL;