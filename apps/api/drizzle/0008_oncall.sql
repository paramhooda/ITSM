CREATE TABLE "oncall_escalation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repeat_count" integer DEFAULT 0 NOT NULL,
	"assign_on_ack" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oncall_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rota_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oncall_rota_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rota_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oncall_rotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"rotation" text DEFAULT 'weekly' NOT NULL,
	"rotation_days" integer DEFAULT 7 NOT NULL,
	"handoff_time" text DEFAULT '09:00' NOT NULL,
	"shift_start" text,
	"shift_end" text,
	"start_date" date NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"policy_id" uuid,
	"root_page_id" uuid,
	"step" integer DEFAULT 0 NOT NULL,
	"cycle" integer DEFAULT 0 NOT NULL,
	"target_kind" text DEFAULT 'oncall' NOT NULL,
	"target_user_id" uuid,
	"target_team_id" uuid,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"reason" text,
	"ack_token_hash" text,
	"expires_at" timestamp with time zone,
	"acked_by" uuid,
	"acked_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "escalation_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "oncall_overrides" ADD CONSTRAINT "oncall_overrides_rota_id_oncall_rotas_id_fk" FOREIGN KEY ("rota_id") REFERENCES "public"."oncall_rotas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_overrides" ADD CONSTRAINT "oncall_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_rota_participants" ADD CONSTRAINT "oncall_rota_participants_rota_id_oncall_rotas_id_fk" FOREIGN KEY ("rota_id") REFERENCES "public"."oncall_rotas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_rota_participants" ADD CONSTRAINT "oncall_rota_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oncall_rotas" ADD CONSTRAINT "oncall_rotas_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_policy_id_oncall_escalation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."oncall_escalation_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_root_page_id_pages_id_fk" FOREIGN KEY ("root_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_target_team_id_teams_id_fk" FOREIGN KEY ("target_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oncall_overrides_rota_idx" ON "oncall_overrides" USING btree ("rota_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oncall_rota_participants_uniq" ON "oncall_rota_participants" USING btree ("rota_id","user_id");--> statement-breakpoint
CREATE INDEX "oncall_rota_participants_rota_idx" ON "oncall_rota_participants" USING btree ("rota_id","position");--> statement-breakpoint
CREATE INDEX "oncall_rotas_team_idx" ON "oncall_rotas" USING btree ("team_id","sort_order");--> statement-breakpoint
CREATE INDEX "pages_ticket_idx" ON "pages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "pages_status_idx" ON "pages" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_ack_token_idx" ON "pages" USING btree ("ack_token_hash");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_escalation_policy_id_oncall_escalation_policies_id_fk" FOREIGN KEY ("escalation_policy_id") REFERENCES "public"."oncall_escalation_policies"("id") ON DELETE set null ON UPDATE no action;