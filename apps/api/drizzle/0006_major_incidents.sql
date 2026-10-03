CREATE TABLE "major_incident_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"author_id" uuid,
	"author_name" text NOT NULL,
	"kind" text DEFAULT 'stakeholder' NOT NULL,
	"body" text NOT NULL,
	"audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"portal_banner" boolean DEFAULT true NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "major_incidents" (
	"ticket_id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"declared_by" uuid,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"demoted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"bridge_url" text,
	"bridge_notes" text,
	"commander_user_id" uuid,
	"comms_lead_user_id" uuid,
	"portal_banner" boolean DEFAULT true NOT NULL,
	"update_interval_minutes" integer DEFAULT 30 NOT NULL,
	"next_update_due_at" timestamp with time zone,
	"last_update_at" timestamp with time zone,
	"last_reminder_at" timestamp with time zone,
	"pir_what_happened" text,
	"pir_impact" text,
	"pir_root_cause" text,
	"pir_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pir_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "major_incident_updates" ADD CONSTRAINT "major_incident_updates_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "major_incidents" ADD CONSTRAINT "major_incidents_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "major_incident_updates_ticket_idx" ON "major_incident_updates" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "major_incidents_status_idx" ON "major_incidents" USING btree ("status","declared_at");--> statement-breakpoint
INSERT INTO "major_incidents" ("ticket_id", "customer_id", "status", "declared_by", "declared_at", "resolved_at", "commander_user_id", "portal_banner", "next_update_due_at", "created_at", "updated_at")
SELECT t.id, t.customer_id,
  CASE WHEN st.status_category IN ('resolved', 'closed', 'cancelled') THEN 'resolved' ELSE 'active' END,
  t.created_by, t.created_at, t.resolved_at, t.assignee_id, false, NULL, t.created_at, now()
FROM tickets t JOIN config_options st ON st.id = t.status_id
WHERE t.is_major AND NOT EXISTS (SELECT 1 FROM major_incidents m WHERE m.ticket_id = t.id);
--> statement-breakpoint
UPDATE "roles" SET "nav_areas" = array_append("nav_areas", 'operations')
WHERE "is_system" AND "nav_areas" IS NOT NULL AND NOT ('operations' = ANY("nav_areas"))
  AND "key" IN ('admin', 'service_manager', 'engineer', 'service_desk', 'noc_engineer', 'noc_manager', 'soc_analyst', 'soc_manager');
