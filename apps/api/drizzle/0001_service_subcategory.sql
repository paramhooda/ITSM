ALTER TABLE "services" ADD COLUMN "subcategory_id" uuid;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_subcategory_id_config_options_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."config_options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "services_subcategory_idx" ON "services" USING btree ("subcategory_id");