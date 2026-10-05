CREATE TABLE "software_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"ci_id" uuid,
	"asset_id" uuid,
	"host_name" text,
	"assigned_user" text,
	"version" text,
	"edition" text,
	"cores" integer,
	"install_path" text,
	"installed_at" date,
	"source" text DEFAULT 'manual' NOT NULL,
	"discovered_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "software_licences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"contract_id" uuid,
	"name" text NOT NULL,
	"metric" text DEFAULT 'per_device' NOT NULL,
	"term" text DEFAULT 'perpetual' NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"start_date" date,
	"end_date" date,
	"renewal_date" date,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"cost" numeric(14, 2),
	"currency" text DEFAULT 'INR',
	"vendor" text,
	"po_number" text,
	"invoice_number" text,
	"licence_key" text,
	"owner_user_id" uuid,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"successor_id" uuid,
	"renewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "software_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"milestone" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "software_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"key" text NOT NULL,
	"publisher" text NOT NULL,
	"name" text NOT NULL,
	"version_family" text,
	"category_id" uuid,
	"licence_model" text DEFAULT 'per_device' NOT NULL,
	"description" text,
	"website" text,
	"eol_date" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(publisher, '') || ' ' || coalesce(name, '') || ' ' || coalesce(version_family, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "software_installations" ADD CONSTRAINT "software_installations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_installations" ADD CONSTRAINT "software_installations_product_id_software_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."software_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_installations" ADD CONSTRAINT "software_installations_ci_id_cis_id_fk" FOREIGN KEY ("ci_id") REFERENCES "public"."cis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_installations" ADD CONSTRAINT "software_installations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_licences" ADD CONSTRAINT "software_licences_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_licences" ADD CONSTRAINT "software_licences_product_id_software_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."software_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_licences" ADD CONSTRAINT "software_licences_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_licences" ADD CONSTRAINT "software_licences_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_licences" ADD CONSTRAINT "software_licences_successor_id_software_licences_id_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."software_licences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_notifications" ADD CONSTRAINT "software_notifications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_products" ADD CONSTRAINT "software_products_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_products" ADD CONSTRAINT "software_products_category_id_config_options_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "software_installs_customer_product_idx" ON "software_installations" USING btree ("customer_id","product_id");--> statement-breakpoint
CREATE INDEX "software_installs_ci_idx" ON "software_installations" USING btree ("ci_id");--> statement-breakpoint
CREATE INDEX "software_installs_asset_idx" ON "software_installations" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "software_installs_last_seen_idx" ON "software_installations" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "software_licences_customer_idx" ON "software_licences" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "software_licences_product_idx" ON "software_licences" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "software_licences_contract_idx" ON "software_licences" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "software_licences_end_idx" ON "software_licences" USING btree ("end_date");--> statement-breakpoint
CREATE INDEX "software_licences_renewal_idx" ON "software_licences" USING btree ("renewal_date");--> statement-breakpoint
CREATE UNIQUE INDEX "software_notifications_uniq" ON "software_notifications" USING btree ("scope_type","scope_id","milestone");--> statement-breakpoint
CREATE INDEX "software_notifications_customer_idx" ON "software_notifications" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "software_products_key_idx" ON "software_products" USING btree ("key");--> statement-breakpoint
CREATE INDEX "software_products_customer_idx" ON "software_products" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "software_products_publisher_idx" ON "software_products" USING btree ("publisher");--> statement-breakpoint
CREATE INDEX "software_products_search_idx" ON "software_products" USING gin ("search_vector");