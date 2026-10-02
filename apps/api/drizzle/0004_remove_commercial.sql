ALTER TABLE "contracts" DROP COLUMN IF EXISTS "value", DROP COLUMN IF EXISTS "currency", DROP COLUMN IF EXISTS "billing_cycle", DROP COLUMN IF EXISTS "commercial", DROP COLUMN IF EXISTS "po_number";--> statement-breakpoint
ALTER TABLE "contract_entitlements" DROP COLUMN IF EXISTS "overage_rate";--> statement-breakpoint
ALTER TABLE "customers" DROP COLUMN IF EXISTS "commercial";--> statement-breakpoint
DELETE FROM "role_permissions" WHERE "permission" = 'contracts:commercial';--> statement-breakpoint
UPDATE "attachments" SET "doc_type" = 'other' WHERE "doc_type" = 'po';
