CREATE TABLE "cab_meeting_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"notes" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cab_meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"chair_user_id" uuid,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"minutes" text,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_blackout_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"name" text NOT NULL,
	"reason" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"allow_emergency" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_risk_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"question" text NOT NULL,
	"hint" text,
	"weight" integer DEFAULT 1 NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"change_type" text DEFAULT 'standard' NOT NULL,
	"category_id" uuid,
	"service_id" uuid,
	"risk_id" uuid,
	"title_template" text,
	"description_template" text,
	"justification" text,
	"implementation_plan" text,
	"test_plan" text,
	"backout_plan" text,
	"communication_plan" text,
	"downtime_expected_minutes" integer,
	"skip_approval" boolean DEFAULT true NOT NULL,
	"customer_ids" uuid[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_details" ADD COLUMN "risk_answers" jsonb;--> statement-breakpoint
ALTER TABLE "change_details" ADD COLUMN "risk_score" integer;--> statement-breakpoint
ALTER TABLE "change_details" ADD COLUMN "risk_level" text;--> statement-breakpoint
ALTER TABLE "change_details" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "change_details" ADD COLUMN "cab_meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "change_details" ADD COLUMN "window_reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cab_meeting_items" ADD CONSTRAINT "cab_meeting_items_meeting_id_cab_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."cab_meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cab_meeting_items" ADD CONSTRAINT "cab_meeting_items_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cab_meeting_items" ADD CONSTRAINT "cab_meeting_items_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cab_meetings" ADD CONSTRAINT "cab_meetings_chair_user_id_users_id_fk" FOREIGN KEY ("chair_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cab_meetings" ADD CONSTRAINT "cab_meetings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_blackout_windows" ADD CONSTRAINT "change_blackout_windows_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_blackout_windows" ADD CONSTRAINT "change_blackout_windows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_templates" ADD CONSTRAINT "change_templates_category_id_config_options_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_templates" ADD CONSTRAINT "change_templates_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_templates" ADD CONSTRAINT "change_templates_risk_id_config_options_id_fk" FOREIGN KEY ("risk_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cab_meeting_items_uniq" ON "cab_meeting_items" USING btree ("meeting_id","ticket_id");--> statement-breakpoint
CREATE INDEX "cab_meeting_items_ticket_idx" ON "cab_meeting_items" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "cab_meetings_scheduled_idx" ON "cab_meetings" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "change_blackouts_window_idx" ON "change_blackout_windows" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "change_blackouts_customer_idx" ON "change_blackout_windows" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "change_risk_questions_key_uniq" ON "change_risk_questions" USING btree ("key");--> statement-breakpoint
CREATE INDEX "change_risk_questions_order_idx" ON "change_risk_questions" USING btree ("sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "change_templates_key_uniq" ON "change_templates" USING btree ("key");