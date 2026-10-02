CREATE TYPE "public"."domain" AS ENUM('general', 'noc', 'soc', 'amc', 'service_desk');--> statement-breakpoint
CREATE TYPE "public"."scope_status" AS ENUM('in_scope', 'out_of_scope', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."sla_metric" AS ENUM('acknowledgement', 'response', 'restoration', 'resolution');--> statement-breakpoint
CREATE TYPE "public"."sla_state" AS ENUM('running', 'paused', 'met', 'breached', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."status_category" AS ENUM('new', 'open', 'pending', 'resolved', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ticket_type" AS ENUM('incident', 'request', 'problem', 'change');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'invited', 'disabled', 'locked');--> statement-breakpoint
CREATE TYPE "public"."user_type" AS ENUM('msp', 'customer');--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"customer_id" uuid,
	"title" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"customer_id" uuid,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" text,
	"confidence" integer,
	"status" text DEFAULT 'proposed' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid,
	"tag" text NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid,
	"status_id" uuid,
	"lifecycle_stage" text DEFAULT 'deployed' NOT NULL,
	"manufacturer" text,
	"model" text,
	"serial_number" text,
	"part_number" text,
	"description" text,
	"location" text,
	"rack_position" text,
	"vendor" text,
	"purchase_date" date,
	"purchase_cost" numeric(14, 2),
	"currency" text DEFAULT 'INR',
	"po_number" text,
	"invoice_number" text,
	"warranty_start" date,
	"warranty_end" date,
	"warranty_provider" text,
	"amc_contract_id" uuid,
	"amc_start" date,
	"amc_end" date,
	"eol_date" date,
	"eos_date" date,
	"owner_contact_id" uuid,
	"assigned_contact_id" uuid,
	"ci_id" uuid,
	"notes" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(tag, '') || ' ' || coalesce(name, '') || ' ' || coalesce(serial_number, '') || ' ' || coalesce(model, '') || ' ' || coalesce(manufacturer, '') || ' ' || coalesce(location, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text,
	"doc_type" text DEFAULT 'other' NOT NULL,
	"title" text,
	"customer_visible" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_interfaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ci_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"if_index" integer,
	"description" text,
	"mac_address" text,
	"ip_address" text,
	"speed_mbps" integer,
	"admin_status" text,
	"oper_status" text,
	"vlan" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_relationship_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"inverse_name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_relationship_types_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "ci_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"source_ci_id" uuid NOT NULL,
	"target_ci_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"description" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_services" (
	"ci_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	CONSTRAINT "ci_services_ci_id_service_id_pk" PRIMARY KEY("ci_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "ci_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_key" text,
	"icon" text,
	"color" text,
	"attribute_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_types_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "cis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid,
	"type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hostname" text,
	"fqdn" text,
	"ip_address" text,
	"mac_address" text,
	"serial_number" text,
	"manufacturer" text,
	"model" text,
	"os_name" text,
	"os_version" text,
	"firmware_version" text,
	"environment" text DEFAULT 'production' NOT NULL,
	"criticality" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text,
	"owner_team_id" uuid,
	"asset_id" uuid,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discovery_source" text,
	"discovered_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"monitoring_ref" text,
	"siem_ref" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(hostname, '') || ' ' || coalesce(fqdn, '') || ' ' || coalesce(ip_address, '') || ' ' || coalesce(serial_number, '') || ' ' || coalesce(model, '') || ' ' || coalesce(manufacturer, '') || ' ' || coalesce(mac_address, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid,
	"ip_address" text NOT NULL,
	"hostname" text,
	"fqdn" text,
	"mac_address" text,
	"manufacturer" text,
	"model" text,
	"serial_number" text,
	"sys_descr" text,
	"sys_object_id" text,
	"suggested_type_key" text,
	"open_ports" integer[] DEFAULT '{}' NOT NULL,
	"interfaces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"neighbors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"matched_ci_id" uuid,
	"diff_status" text DEFAULT 'new' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"log" text,
	"error" text,
	"triggered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid,
	"name" text NOT NULL,
	"source_type" text DEFAULT 'network_scan' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule_cron" text,
	"auto_apply" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"team_id" uuid,
	"user_id" uuid,
	"strategy" text DEFAULT 'team' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"is_24x7" boolean DEFAULT false NOT NULL,
	"hours" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"holiday_calendar_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"domain" "domain" DEFAULT 'general' NOT NULL,
	"status_category" "status_category",
	"pauses_sla" boolean DEFAULT false NOT NULL,
	"level" integer,
	"color" text,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"applies_to" text[] DEFAULT '{}' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text DEFAULT 'text' NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"customer_visible" boolean DEFAULT false NOT NULL,
	"help_text" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holiday_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"country" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_id" uuid NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" text NOT NULL,
	"name" text NOT NULL,
	"recipients" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channels" text[] DEFAULT '{"email","in_app"}' NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"name" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "priority_matrix" (
	"impact_id" uuid NOT NULL,
	"urgency_id" uuid NOT NULL,
	"priority_id" uuid NOT NULL,
	CONSTRAINT "priority_matrix_impact_id_urgency_id_pk" PRIMARY KEY("impact_id","urgency_id")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"type_id" uuid,
	"name" text NOT NULL,
	"service_id" uuid,
	"quantity" numeric(12, 2) NOT NULL,
	"unit" text DEFAULT 'count' NOT NULL,
	"period" text DEFAULT 'contract' NOT NULL,
	"warn_threshold_pct" integer DEFAULT 80 NOT NULL,
	"overage_allowed" boolean DEFAULT true NOT NULL,
	"overage_rate" numeric(12, 2),
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"milestone" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_services" (
	"contract_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"sla_policy_id" uuid,
	"team_id" uuid,
	"support_hours_calendar_id" uuid,
	"notes" text,
	CONSTRAINT "contract_services_contract_id_service_id_pk" PRIMARY KEY("contract_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "contract_sites" (
	"contract_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	CONSTRAINT "contract_sites_contract_id_site_id_pk" PRIMARY KEY("contract_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"type_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"renewal_date" date,
	"notice_period_days" integer,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"support_hours_calendar_id" uuid,
	"holiday_calendar_id" uuid,
	"sla_policy_id" uuid,
	"escalation_matrix" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response_commitment" text,
	"resolution_commitment" text,
	"exclusions" text,
	"description" text,
	"value" numeric(14, 2),
	"currency" text DEFAULT 'INR',
	"billing_cycle" text,
	"commercial" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"po_number" text,
	"signed_at" date,
	"parent_contract_id" uuid,
	"owner_user_id" uuid,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement_consumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entitlement_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_id" uuid,
	"ticket_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scope_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid,
	"header_id" uuid,
	"category_id" uuid,
	"type_id" uuid,
	"status_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"classification" "scope_status" DEFAULT 'in_scope' NOT NULL,
	"site_id" uuid,
	"ci_type_key" text,
	"asset_category_id" uuid,
	"ticket_category_id" uuid,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid,
	"user_id" uuid,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"mobile" text,
	"title" text,
	"department" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_escalation" boolean DEFAULT false NOT NULL,
	"escalation_level" integer,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_teams" (
	"customer_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_teams_customer_id_team_id_pk" PRIMARY KEY("customer_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"industry_id" uuid,
	"type_id" uuid,
	"status_id" uuid,
	"account_manager_id" uuid,
	"website" text,
	"phone" text,
	"email" text,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"commercial" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(code, '') || ' ' || coalesce(name, '') || ' ' || coalesce(legal_name, '') || ' ' || coalesce(email, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type_id" uuid,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timezone" text,
	"phone" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"business_hours_calendar_id" uuid,
	"notes" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_visit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"author_id" uuid,
	"author_name" text,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_visit_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"part_number" text,
	"serial_number" text,
	"quantity" numeric(10, 2) DEFAULT '1' NOT NULL,
	"unit_cost" numeric(12, 2),
	"asset_id" uuid,
	"billable" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid,
	"ticket_id" uuid,
	"contract_id" uuid,
	"service_id" uuid,
	"type_id" uuid,
	"pm_occurrence_id" uuid,
	"title" text NOT NULL,
	"purpose" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"engineer_id" uuid,
	"team_id" uuid,
	"additional_engineer_ids" uuid[] DEFAULT '{}' NOT NULL,
	"requested_by" uuid,
	"scheduled_start" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"actual_start" timestamp with time zone,
	"actual_end" timestamp with time zone,
	"travel_minutes" integer,
	"work_minutes" integer,
	"work_summary" text,
	"findings" text,
	"recommendations" text,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"customer_ack_name" text,
	"customer_ack_title" text,
	"customer_ack_at" timestamp with time zone,
	"customer_ack_notes" text,
	"customer_rating" integer,
	"entitlement_id" uuid,
	"consumption_id" uuid,
	"billable" boolean DEFAULT false NOT NULL,
	"report_generated_at" timestamp with time zone,
	"cancel_reason" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_visits_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "pm_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"planned_date" date NOT NULL,
	"scheduled_date" date,
	"status" text DEFAULT 'planned' NOT NULL,
	"field_visit_id" uuid,
	"ticket_id" uuid,
	"engineer_id" uuid,
	"completed_at" timestamp with time zone,
	"checklist_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"reschedule_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pm_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid,
	"contract_id" uuid,
	"service_id" uuid,
	"entitlement_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"frequency" text DEFAULT 'quarterly' NOT NULL,
	"interval_days" integer,
	"start_date" date NOT NULL,
	"end_date" date,
	"lead_days" integer DEFAULT 14 NOT NULL,
	"grace_days" integer DEFAULT 7 NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assigned_team_id" uuid,
	"assigned_engineer_id" uuid,
	"ci_ids" uuid[] DEFAULT '{}' NOT NULL,
	"asset_ids" uuid[] DEFAULT '{}' NOT NULL,
	"requires_site_visit" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"customer_id" uuid,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_pk" PRIMARY KEY("role_id","permission")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"user_type" "user_type" DEFAULT 'msp' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_lead" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"team_type" text DEFAULT 'general' NOT NULL,
	"email" text,
	"manager_user_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "user_customer_access" (
	"user_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_customer_access_user_id_customer_id_pk" PRIMARY KEY("user_id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"customer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"name" text NOT NULL,
	"phone" text,
	"title" text,
	"user_type" "user_type" DEFAULT 'msp' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"customer_id" uuid,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"avatar_url" text,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auth_provider" text DEFAULT 'local' NOT NULL,
	"external_id" text,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_type" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"customer_id" uuid,
	"api_key_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auto_create_tickets" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_article_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"customer_id" uuid,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"summary" text,
	"changed_by" uuid,
	"change_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text DEFAULT '' NOT NULL,
	"category_id" uuid,
	"article_type" text DEFAULT 'procedure' NOT NULL,
	"domain" "domain" DEFAULT 'general' NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"customer_id" uuid,
	"service_id" uuid,
	"ci_type_key" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"author_id" uuid,
	"reviewer_id" uuid,
	"reviewed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"related_ticket_ids" uuid[] DEFAULT '{}' NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"not_helpful_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(number, '') || ' ' || coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(body, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_articles_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "kb_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"domain" "domain" DEFAULT 'general' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_categories_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"event" text,
	"customer_id" uuid,
	"recipient" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"body_text" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"entity_type" text,
	"entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"customer_id" uuid,
	"event" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"entity_type" text,
	"entity_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_rollups_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"customer_id" uuid,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid,
	"report_key" text NOT NULL,
	"customer_id" uuid,
	"name" text NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"format" text DEFAULT 'html' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attachment_id" uuid,
	"row_count" integer,
	"error" text,
	"delivered_to" text[] DEFAULT '{}' NOT NULL,
	"portal_visible" boolean DEFAULT false NOT NULL,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"report_key" text NOT NULL,
	"customer_id" uuid,
	"recipients" text[] DEFAULT '{}' NOT NULL,
	"recipient_user_ids" uuid[] DEFAULT '{}' NOT NULL,
	"frequency" text DEFAULT 'weekly' NOT NULL,
	"cron_expression" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"date_range" text DEFAULT 'last_7_days' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"format" text DEFAULT 'html' NOT NULL,
	"delivery" text DEFAULT 'email' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" uuid,
	"status_id" uuid,
	"domain" "domain" DEFAULT 'general' NOT NULL,
	"default_team_id" uuid,
	"default_sla_policy_id" uuid,
	"default_ticket_category_id" uuid,
	"ci_type_keys" text[] DEFAULT '{}' NOT NULL,
	"owner_user_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalation_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"rule_id" uuid,
	"level" integer DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"actions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"triggered_by" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_pause_statuses" (
	"policy_id" uuid NOT NULL,
	"status_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"calendar_id" uuid,
	"holiday_calendar_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"ticket_type" "ticket_type" DEFAULT 'incident' NOT NULL,
	"priority_id" uuid,
	"metric" "sla_metric" NOT NULL,
	"minutes" integer NOT NULL,
	"warn_pct" integer DEFAULT 75 NOT NULL,
	"calendar_time" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_sla_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_sla_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_slas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"policy_id" uuid,
	"metric" "sla_metric" NOT NULL,
	"target_minutes" integer NOT NULL,
	"warn_pct" integer DEFAULT 75 NOT NULL,
	"calendar_time" boolean DEFAULT false NOT NULL,
	"calendar_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "sla_state" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_minutes" integer DEFAULT 0 NOT NULL,
	"warned_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"breached_at" timestamp with time zone,
	"elapsed_minutes_at_completion" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"step" integer DEFAULT 1 NOT NULL,
	"step_name" text,
	"approver_user_id" uuid,
	"approver_role_key" text,
	"approver_team_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" uuid,
	"icon" text,
	"form_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sla_policy_id" uuid,
	"team_id" uuid,
	"approval_workflow_id" uuid,
	"ticket_category_id" uuid,
	"default_priority_id" uuid,
	"service_id" uuid,
	"fulfilment_instructions" text,
	"customer_ids" uuid[] DEFAULT '{}' NOT NULL,
	"portal_visible" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_items_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "change_details" (
	"ticket_id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"change_type" text DEFAULT 'normal' NOT NULL,
	"risk_id" uuid,
	"risk_assessment" text,
	"impact_assessment" text,
	"justification" text,
	"implementation_plan" text,
	"test_plan" text,
	"backout_plan" text,
	"communication_plan" text,
	"scheduled_start" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"actual_start" timestamp with time zone,
	"actual_end" timestamp with time zone,
	"downtime_expected_minutes" integer,
	"cab_notes" text,
	"implementation_notes" text,
	"pir_notes" text,
	"pir_outcome" text,
	"reviewed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problem_details" (
	"ticket_id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"symptoms" text,
	"investigation" text,
	"root_cause" text,
	"workaround" text,
	"is_known_error" boolean DEFAULT false NOT NULL,
	"permanent_fix" text,
	"kb_article_id" uuid,
	"impact_summary" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"entity" text DEFAULT 'ticket' NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"columns" text[] DEFAULT '{}' NOT NULL,
	"sort" text,
	"is_shared" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_name" text,
	"activity_type" text NOT NULL,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"customer_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_assets" (
	"ticket_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	CONSTRAINT "ticket_assets_ticket_id_asset_id_pk" PRIMARY KEY("ticket_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_cis" (
	"ticket_id" uuid NOT NULL,
	"ci_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"role" text DEFAULT 'affected' NOT NULL,
	CONSTRAINT "ticket_cis_ticket_id_ci_id_pk" PRIMARY KEY("ticket_id","ci_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"author_id" uuid,
	"author_name" text,
	"kind" text DEFAULT 'comment' NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"body" text NOT NULL,
	"source" text DEFAULT 'ui' NOT NULL,
	"minutes_spent" integer,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_ticket_id" uuid NOT NULL,
	"target_ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"link_type" text DEFAULT 'related' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_id" uuid,
	"team_id" uuid,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_watchers" (
	"ticket_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	CONSTRAINT "ticket_watchers_ticket_id_user_id_pk" PRIMARY KEY("ticket_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"type" "ticket_type" NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid,
	"contract_id" uuid,
	"service_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"category_id" uuid,
	"subcategory_id" uuid,
	"priority_id" uuid,
	"impact_id" uuid,
	"urgency_id" uuid,
	"status_id" uuid NOT NULL,
	"source_id" uuid,
	"domain" text DEFAULT 'general' NOT NULL,
	"assigned_team_id" uuid,
	"assignee_id" uuid,
	"requester_user_id" uuid,
	"requester_contact_id" uuid,
	"primary_ci_id" uuid,
	"primary_asset_id" uuid,
	"scope_status" "scope_status" DEFAULT 'unknown' NOT NULL,
	"scope_contract_id" uuid,
	"scope_item_id" uuid,
	"scope_note" text,
	"scope_classified_by" uuid,
	"scope_classified_at" timestamp with time zone,
	"sla_policy_id" uuid,
	"catalog_item_id" uuid,
	"form_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_ticket_id" uuid,
	"security_severity_id" uuid,
	"resolution_code_id" uuid,
	"closure_code_id" uuid,
	"resolution_notes" text,
	"approval_status" text,
	"first_response_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"restored_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"is_major" boolean DEFAULT false NOT NULL,
	"integration_event_id" uuid,
	"external_ref" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(number, '') || ' ' || coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(external_ref, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid,
	"field_visit_id" uuid,
	"customer_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"minutes" integer NOT NULL,
	"started_at" timestamp with time zone,
	"description" text,
	"work_type" text DEFAULT 'remote' NOT NULL,
	"billable" boolean DEFAULT false NOT NULL,
	"entitlement_id" uuid,
	"consumption_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_category_id_config_options_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_status_id_config_options_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_amc_contract_id_contracts_id_fk" FOREIGN KEY ("amc_contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_contact_id_contacts_id_fk" FOREIGN KEY ("owner_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_assigned_contact_id_contacts_id_fk" FOREIGN KEY ("assigned_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_interfaces" ADD CONSTRAINT "ci_interfaces_ci_id_cis_id_fk" FOREIGN KEY ("ci_id") REFERENCES "public"."cis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_relationships" ADD CONSTRAINT "ci_relationships_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_relationships" ADD CONSTRAINT "ci_relationships_source_ci_id_cis_id_fk" FOREIGN KEY ("source_ci_id") REFERENCES "public"."cis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_relationships" ADD CONSTRAINT "ci_relationships_target_ci_id_cis_id_fk" FOREIGN KEY ("target_ci_id") REFERENCES "public"."cis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_relationships" ADD CONSTRAINT "ci_relationships_type_id_ci_relationship_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."ci_relationship_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_services" ADD CONSTRAINT "ci_services_ci_id_cis_id_fk" FOREIGN KEY ("ci_id") REFERENCES "public"."cis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_services" ADD CONSTRAINT "ci_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis" ADD CONSTRAINT "cis_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis" ADD CONSTRAINT "cis_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis" ADD CONSTRAINT "cis_type_id_ci_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."ci_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis" ADD CONSTRAINT "cis_owner_team_id_teams_id_fk" FOREIGN KEY ("owner_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cis" ADD CONSTRAINT "cis_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_findings" ADD CONSTRAINT "discovery_findings_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_source_id_discovery_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."discovery_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_calendar_id_holiday_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."holiday_calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_matrix" ADD CONSTRAINT "priority_matrix_impact_id_config_options_id_fk" FOREIGN KEY ("impact_id") REFERENCES "public"."config_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_matrix" ADD CONSTRAINT "priority_matrix_urgency_id_config_options_id_fk" FOREIGN KEY ("urgency_id") REFERENCES "public"."config_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_matrix" ADD CONSTRAINT "priority_matrix_priority_id_config_options_id_fk" FOREIGN KEY ("priority_id") REFERENCES "public"."config_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_entitlements" ADD CONSTRAINT "contract_entitlements_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_entitlements" ADD CONSTRAINT "contract_entitlements_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_entitlements" ADD CONSTRAINT "contract_entitlements_type_id_config_options_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_entitlements" ADD CONSTRAINT "contract_entitlements_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_notifications" ADD CONSTRAINT "contract_notifications_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_notifications" ADD CONSTRAINT "contract_notifications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_services" ADD CONSTRAINT "contract_services_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_services" ADD CONSTRAINT "contract_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_services" ADD CONSTRAINT "contract_services_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_sites" ADD CONSTRAINT "contract_sites_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_sites" ADD CONSTRAINT "contract_sites_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_type_id_config_options_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_consumptions" ADD CONSTRAINT "entitlement_consumptions_entitlement_id_contract_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."contract_entitlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_consumptions" ADD CONSTRAINT "entitlement_consumptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_items" ADD CONSTRAINT "scope_items_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_items" ADD CONSTRAINT "scope_items_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_items" ADD CONSTRAINT "scope_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_items" ADD CONSTRAINT "scope_items_header_id_config_options_id_fk" FOREIGN KEY ("header_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_items" ADD CONSTRAINT "scope_items_category_id_config_options_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_items" ADD CONSTRAINT "scope_items_type_id_config_options_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_items" ADD CONSTRAINT "scope_items_status_id_config_options_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_items" ADD CONSTRAINT "scope_items_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_items" ADD CONSTRAINT "scope_items_asset_category_id_config_options_id_fk" FOREIGN KEY ("asset_category_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_items" ADD CONSTRAINT "scope_items_ticket_category_id_config_options_id_fk" FOREIGN KEY ("ticket_category_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_teams" ADD CONSTRAINT "customer_teams_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_teams" ADD CONSTRAINT "customer_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_industry_id_config_options_id_fk" FOREIGN KEY ("industry_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_type_id_config_options_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_status_id_config_options_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_account_manager_id_users_id_fk" FOREIGN KEY ("account_manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_type_id_config_options_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_visit_notes" ADD CONSTRAINT "field_visit_notes_visit_id_field_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."field_visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_visit_parts" ADD CONSTRAINT "field_visit_parts_visit_id_field_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."field_visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_type_id_config_options_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_engineer_id_users_id_fk" FOREIGN KEY ("engineer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_entitlement_id_contract_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."contract_entitlements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_occurrences" ADD CONSTRAINT "pm_occurrences_program_id_pm_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."pm_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_occurrences" ADD CONSTRAINT "pm_occurrences_field_visit_id_field_visits_id_fk" FOREIGN KEY ("field_visit_id") REFERENCES "public"."field_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_programs" ADD CONSTRAINT "pm_programs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_programs" ADD CONSTRAINT "pm_programs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_programs" ADD CONSTRAINT "pm_programs_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_programs" ADD CONSTRAINT "pm_programs_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_programs" ADD CONSTRAINT "pm_programs_entitlement_id_contract_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."contract_entitlements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_programs" ADD CONSTRAINT "pm_programs_assigned_team_id_teams_id_fk" FOREIGN KEY ("assigned_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pm_programs" ADD CONSTRAINT "pm_programs_assigned_engineer_id_users_id_fk" FOREIGN KEY ("assigned_engineer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_customer_access" ADD CONSTRAINT "user_customer_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_customer_access" ADD CONSTRAINT "user_customer_access_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_category_id_kb_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."kb_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_rollups_daily" ADD CONSTRAINT "metric_rollups_daily_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_schedule_id_report_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."report_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_config_options_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_status_id_config_options_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_default_team_id_teams_id_fk" FOREIGN KEY ("default_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_default_ticket_category_id_config_options_id_fk" FOREIGN KEY ("default_ticket_category_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_pause_statuses" ADD CONSTRAINT "sla_pause_statuses_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_pause_statuses" ADD CONSTRAINT "sla_pause_statuses_status_id_config_options_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."config_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_calendar_id_business_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."business_calendars"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_holiday_calendar_id_holiday_calendars_id_fk" FOREIGN KEY ("holiday_calendar_id") REFERENCES "public"."holiday_calendars"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_targets" ADD CONSTRAINT "sla_targets_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_targets" ADD CONSTRAINT "sla_targets_priority_id_config_options_id_fk" FOREIGN KEY ("priority_id") REFERENCES "public"."config_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_sla_events" ADD CONSTRAINT "ticket_sla_events_ticket_sla_id_ticket_slas_id_fk" FOREIGN KEY ("ticket_sla_id") REFERENCES "public"."ticket_slas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_slas" ADD CONSTRAINT "ticket_slas_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_slas" ADD CONSTRAINT "ticket_slas_policy_id_sla_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_category_id_config_options_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_sla_policy_id_sla_policies_id_fk" FOREIGN KEY ("sla_policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_approval_workflow_id_approval_workflows_id_fk" FOREIGN KEY ("approval_workflow_id") REFERENCES "public"."approval_workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_ticket_category_id_config_options_id_fk" FOREIGN KEY ("ticket_category_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_default_priority_id_config_options_id_fk" FOREIGN KEY ("default_priority_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_details" ADD CONSTRAINT "change_details_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_details" ADD CONSTRAINT "change_details_risk_id_config_options_id_fk" FOREIGN KEY ("risk_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_details" ADD CONSTRAINT "problem_details_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_activities" ADD CONSTRAINT "ticket_activities_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assets" ADD CONSTRAINT "ticket_assets_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_cis" ADD CONSTRAINT "ticket_cis_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_source_ticket_id_tickets_id_fk" FOREIGN KEY ("source_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_target_ticket_id_tickets_id_fk" FOREIGN KEY ("target_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_tasks" ADD CONSTRAINT "ticket_tasks_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_tasks" ADD CONSTRAINT "ticket_tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_tasks" ADD CONSTRAINT "ticket_tasks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_watchers" ADD CONSTRAINT "ticket_watchers_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_watchers" ADD CONSTRAINT "ticket_watchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_id_config_options_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_subcategory_id_config_options_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_priority_id_config_options_id_fk" FOREIGN KEY ("priority_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_impact_id_config_options_id_fk" FOREIGN KEY ("impact_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_urgency_id_config_options_id_fk" FOREIGN KEY ("urgency_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_status_id_config_options_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."config_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_source_id_config_options_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assigned_team_id_teams_id_fk" FOREIGN KEY ("assigned_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requester_contact_id_contacts_id_fk" FOREIGN KEY ("requester_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sla_policy_id_sla_policies_id_fk" FOREIGN KEY ("sla_policy_id") REFERENCES "public"."sla_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_security_severity_id_config_options_id_fk" FOREIGN KEY ("security_severity_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_resolution_code_id_config_options_id_fk" FOREIGN KEY ("resolution_code_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_closure_code_id_config_options_id_fk" FOREIGN KEY ("closure_code_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_conversations_user_idx" ON "ai_conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_idx" ON "ai_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_suggestions_entity_idx" ON "ai_suggestions" USING btree ("entity_type","entity_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_customer_tag_idx" ON "assets" USING btree ("customer_id","tag");--> statement-breakpoint
CREATE INDEX "assets_customer_idx" ON "assets" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "assets_serial_idx" ON "assets" USING btree ("serial_number");--> statement-breakpoint
CREATE INDEX "assets_site_idx" ON "assets" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "assets_warranty_idx" ON "assets" USING btree ("warranty_end");--> statement-breakpoint
CREATE INDEX "assets_search_idx" ON "assets" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "attachments_entity_idx" ON "attachments" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "attachments_customer_idx" ON "attachments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "ci_interfaces_ci_idx" ON "ci_interfaces" USING btree ("ci_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_relationships_unique_idx" ON "ci_relationships" USING btree ("source_ci_id","target_ci_id","type_id");--> statement-breakpoint
CREATE INDEX "ci_relationships_target_idx" ON "ci_relationships" USING btree ("target_ci_id");--> statement-breakpoint
CREATE INDEX "cis_customer_idx" ON "cis" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "cis_type_idx" ON "cis" USING btree ("type_id");--> statement-breakpoint
CREATE INDEX "cis_hostname_idx" ON "cis" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "cis_ip_idx" ON "cis" USING btree ("ip_address");--> statement-breakpoint
CREATE INDEX "cis_serial_idx" ON "cis" USING btree ("serial_number");--> statement-breakpoint
CREATE INDEX "cis_monitoring_ref_idx" ON "cis" USING btree ("monitoring_ref");--> statement-breakpoint
CREATE INDEX "cis_search_idx" ON "cis" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "discovery_findings_run_idx" ON "discovery_findings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "discovery_findings_customer_idx" ON "discovery_findings" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "discovery_runs_source_idx" ON "discovery_runs" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE INDEX "discovery_sources_customer_idx" ON "discovery_sources" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "config_options_type_key_idx" ON "config_options" USING btree ("type","key");--> statement-breakpoint
CREATE INDEX "config_options_type_idx" ON "config_options" USING btree ("type");--> statement-breakpoint
CREATE INDEX "config_options_parent_idx" ON "config_options" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_entity_key_idx" ON "custom_field_definitions" USING btree ("entity","key");--> statement-breakpoint
CREATE UNIQUE INDEX "holidays_calendar_date_idx" ON "holidays" USING btree ("calendar_id","date");--> statement-breakpoint
CREATE INDEX "notification_rules_event_idx" ON "notification_rules" USING btree ("event");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_templates_event_channel_idx" ON "notification_templates" USING btree ("event","channel");--> statement-breakpoint
CREATE INDEX "entitlements_contract_idx" ON "contract_entitlements" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "entitlements_customer_idx" ON "contract_entitlements" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_notifications_unique_idx" ON "contract_notifications" USING btree ("contract_id","milestone");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_number_idx" ON "contracts" USING btree ("number");--> statement-breakpoint
CREATE INDEX "contracts_customer_idx" ON "contracts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "contracts_end_date_idx" ON "contracts" USING btree ("end_date");--> statement-breakpoint
CREATE INDEX "contracts_status_idx" ON "contracts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "consumptions_entitlement_idx" ON "entitlement_consumptions" USING btree ("entitlement_id");--> statement-breakpoint
CREATE INDEX "consumptions_customer_idx" ON "entitlement_consumptions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "scope_items_contract_idx" ON "scope_items" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "scope_items_customer_idx" ON "scope_items" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "contacts_customer_idx" ON "contacts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "contacts_email_idx" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_code_idx" ON "customers" USING btree ("code");--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "customers_search_idx" ON "customers" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_customer_code_idx" ON "sites" USING btree ("customer_id","code");--> statement-breakpoint
CREATE INDEX "sites_customer_idx" ON "sites" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "field_visit_notes_visit_idx" ON "field_visit_notes" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "field_visit_parts_visit_idx" ON "field_visit_parts" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "field_visits_customer_idx" ON "field_visits" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "field_visits_engineer_idx" ON "field_visits" USING btree ("engineer_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "field_visits_status_idx" ON "field_visits" USING btree ("status");--> statement-breakpoint
CREATE INDEX "field_visits_ticket_idx" ON "field_visits" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "pm_occurrences_program_idx" ON "pm_occurrences" USING btree ("program_id","planned_date");--> statement-breakpoint
CREATE INDEX "pm_occurrences_customer_status_idx" ON "pm_occurrences" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "pm_programs_customer_idx" ON "pm_programs" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_idx" ON "sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_unique_idx" ON "user_roles" USING btree ("user_id","role_id","customer_id");--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_customer_idx" ON "users" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "integrations_type_idx" ON "integrations" USING btree ("integration_type");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_article_versions_idx" ON "kb_article_versions" USING btree ("article_id","version");--> statement-breakpoint
CREATE INDEX "kb_articles_customer_idx" ON "kb_articles" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "kb_articles_status_idx" ON "kb_articles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "kb_articles_category_idx" ON "kb_articles" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "kb_articles_search_idx" ON "kb_articles" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "notification_outbox_status_idx" ON "notification_outbox" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_rollups_day_customer_idx" ON "metric_rollups_daily" USING btree ("day","customer_id");--> statement-breakpoint
CREATE INDEX "report_runs_customer_idx" ON "report_runs" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "report_runs_schedule_idx" ON "report_runs" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "report_schedules_next_run_idx" ON "report_schedules" USING btree ("is_active","next_run_at");--> statement-breakpoint
CREATE INDEX "report_schedules_customer_idx" ON "report_schedules" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_key_idx" ON "services" USING btree ("key");--> statement-breakpoint
CREATE INDEX "services_category_idx" ON "services" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "escalation_log_ticket_idx" ON "escalation_log" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_pause_statuses_idx" ON "sla_pause_statuses" USING btree ("policy_id","status_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_targets_unique_idx" ON "sla_targets" USING btree ("policy_id","ticket_type","priority_id","metric");--> statement-breakpoint
CREATE INDEX "sla_targets_policy_idx" ON "sla_targets" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "ticket_sla_events_sla_idx" ON "ticket_sla_events" USING btree ("ticket_sla_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_slas_ticket_metric_idx" ON "ticket_slas" USING btree ("ticket_id","metric");--> statement-breakpoint
CREATE INDEX "ticket_slas_state_due_idx" ON "ticket_slas" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX "ticket_slas_customer_idx" ON "ticket_slas" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "approvals_ticket_idx" ON "approvals" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "approvals_approver_idx" ON "approvals" USING btree ("approver_user_id","status");--> statement-breakpoint
CREATE INDEX "saved_views_user_idx" ON "saved_views" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ticket_activities_ticket_idx" ON "ticket_activities" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ticket_assets_asset_idx" ON "ticket_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "ticket_cis_ci_idx" ON "ticket_cis" USING btree ("ci_id");--> statement-breakpoint
CREATE INDEX "ticket_comments_ticket_idx" ON "ticket_comments" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_links_unique_idx" ON "ticket_links" USING btree ("source_ticket_id","target_ticket_id","link_type");--> statement-breakpoint
CREATE INDEX "ticket_links_target_idx" ON "ticket_links" USING btree ("target_ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_tasks_ticket_idx" ON "ticket_tasks" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_number_idx" ON "tickets" USING btree ("number");--> statement-breakpoint
CREATE INDEX "tickets_customer_created_idx" ON "tickets" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX "tickets_assignee_idx" ON "tickets" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "tickets_team_idx" ON "tickets" USING btree ("assigned_team_id");--> statement-breakpoint
CREATE INDEX "tickets_type_created_idx" ON "tickets" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "tickets_service_idx" ON "tickets" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "tickets_primary_ci_idx" ON "tickets" USING btree ("primary_ci_id");--> statement-breakpoint
CREATE INDEX "tickets_search_idx" ON "tickets" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "tickets_last_activity_idx" ON "tickets" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX "time_entries_ticket_idx" ON "time_entries" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "time_entries_user_idx" ON "time_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "time_entries_customer_idx" ON "time_entries" USING btree ("customer_id");