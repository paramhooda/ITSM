CREATE TABLE "report_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'custom' NOT NULL,
	"entity" text NOT NULL,
	"spec" jsonb NOT NULL,
	"default_date_range" text DEFAULT 'last_30_days' NOT NULL,
	"scope_customer_id" uuid,
	"owner_id" uuid,
	"visibility" text DEFAULT 'private' NOT NULL,
	"shared_role_keys" text[] DEFAULT '{}' NOT NULL,
	"shared_team_ids" uuid[] DEFAULT '{}' NOT NULL,
	"portal_visible" boolean DEFAULT false NOT NULL,
	"cover" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_scope_customer_id_customers_id_fk" FOREIGN KEY ("scope_customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_definitions_owner_idx" ON "report_definitions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "report_definitions_scope_customer_idx" ON "report_definitions" USING btree ("scope_customer_id");--> statement-breakpoint
CREATE INDEX "report_definitions_entity_idx" ON "report_definitions" USING btree ("entity");