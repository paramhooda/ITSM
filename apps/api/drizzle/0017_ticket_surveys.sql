CREATE TABLE "survey_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"contract_id" uuid,
	"enabled" boolean,
	"send_on" text,
	"resend_on_close" boolean,
	"sampling_pct" integer,
	"question" text,
	"comment_prompt" text,
	"reminder_days" integer,
	"expiry_days" integer,
	"fatigue_days" integer,
	"low_rating_threshold" integer,
	"ticket_types" text[],
	"notes" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey_configs_scope_uniq" UNIQUE NULLS NOT DISTINCT("customer_id","contract_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_surveys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"assignee_id" uuid,
	"assigned_team_id" uuid,
	"service_id" uuid,
	"priority_id" uuid,
	"ticket_type" "ticket_type" NOT NULL,
	"trigger" text NOT NULL,
	"question" text NOT NULL,
	"comment_prompt" text,
	"recipient_user_id" uuid,
	"recipient_contact_id" uuid,
	"recipient_email" text,
	"recipient_name" text,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_enc" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reminded_at" timestamp with time zone,
	"resent_at" timestamp with time zone,
	"send_count" integer DEFAULT 1 NOT NULL,
	"rating" integer,
	"comment" text,
	"answered_at" timestamp with time zone,
	"answered_by_user_id" uuid,
	"channel" text,
	"low_rating_alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "csat_rating" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "csat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "survey_configs" ADD CONSTRAINT "survey_configs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_configs" ADD CONSTRAINT "survey_configs_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_configs" ADD CONSTRAINT "survey_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_configs" ADD CONSTRAINT "survey_configs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_surveys" ADD CONSTRAINT "ticket_surveys_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_surveys" ADD CONSTRAINT "ticket_surveys_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_surveys" ADD CONSTRAINT "ticket_surveys_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_surveys" ADD CONSTRAINT "ticket_surveys_assigned_team_id_teams_id_fk" FOREIGN KEY ("assigned_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_surveys" ADD CONSTRAINT "ticket_surveys_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_surveys" ADD CONSTRAINT "ticket_surveys_recipient_contact_id_contacts_id_fk" FOREIGN KEY ("recipient_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_surveys" ADD CONSTRAINT "ticket_surveys_answered_by_user_id_users_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "survey_configs_customer_idx" ON "survey_configs" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_surveys_ticket_uniq" ON "ticket_surveys" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_surveys_token_uniq" ON "ticket_surveys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ticket_surveys_customer_answered_idx" ON "ticket_surveys" USING btree ("customer_id","answered_at");--> statement-breakpoint
CREATE INDEX "ticket_surveys_customer_requested_idx" ON "ticket_surveys" USING btree ("customer_id","requested_at");--> statement-breakpoint
CREATE INDEX "ticket_surveys_status_idx" ON "ticket_surveys" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "ticket_surveys_assignee_idx" ON "ticket_surveys" USING btree ("assignee_id","answered_at");--> statement-breakpoint
CREATE INDEX "ticket_surveys_recipient_idx" ON "ticket_surveys" USING btree ("recipient_user_id","requested_at");--> statement-breakpoint
CREATE INDEX "tickets_csat_idx" ON "tickets" USING btree ("csat_rating") WHERE "tickets"."csat_rating" IS NOT NULL;