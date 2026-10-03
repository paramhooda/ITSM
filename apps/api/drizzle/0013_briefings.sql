CREATE TABLE "briefings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"day" date NOT NULL,
	"facts" jsonb,
	"text" text DEFAULT '' NOT NULL,
	"html" text DEFAULT '' NOT NULL,
	"ai" boolean DEFAULT false NOT NULL,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "briefings_user_day_idx" ON "briefings" USING btree ("user_id","day");