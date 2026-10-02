import { z } from 'zod';
import { ASSET_LIFECYCLE } from '@itsm/shared';
import { paginationSchema } from '@/core/pagination';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const nullableDate = dateStr.nullable().optional();
const nullableText = (max = 200) => z.string().max(max).nullable().optional();

export const assetListQuery = paginationSchema.extend({
  q: z.string().max(200).optional(),
  customerId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  statusId: z.string().uuid().optional(),
  lifecycleStage: z.enum(ASSET_LIFECYCLE).optional(),
  manufacturer: z.string().max(120).optional(),
  warrantyExpiringDays: z.coerce.number().int().min(0).max(3650).optional(),
  amcExpiringDays: z.coerce.number().int().min(0).max(3650).optional(),
  /** Coverage already lapsed: warranty, AMC or either. */
  expired: z.enum(['warranty', 'amc', 'any']).optional(),
  hasCi: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional()),
  tag: z.string().max(100).optional(),
  amcContractId: z.string().uuid().optional(),
  sort: z.enum(['tag', 'name', 'warrantyEnd', 'amcEnd', 'createdAt', 'customer', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  fields: z.enum(['min', 'full']).optional(),
});
export type AssetListQuery = z.infer<typeof assetListQuery>;

export const assetCreateBody = z.object({
  customerId: z.string().uuid(),
  siteId: z.string().uuid().nullable().optional(),
  tag: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200),
  categoryId: z.string().uuid().nullable().optional(),
  statusId: z.string().uuid().nullable().optional(),
  lifecycleStage: z.enum(ASSET_LIFECYCLE).optional(),
  manufacturer: nullableText(120),
  model: nullableText(120),
  serialNumber: nullableText(120),
  partNumber: nullableText(120),
  description: nullableText(2000),
  location: nullableText(200),
  rackPosition: nullableText(100),
  vendor: nullableText(200),
  purchaseDate: nullableDate,
  purchaseCost: z.coerce.number().min(0).nullable().optional(),
  currency: nullableText(8),
  poNumber: nullableText(100),
  invoiceNumber: nullableText(100),
  warrantyStart: nullableDate,
  warrantyEnd: nullableDate,
  warrantyProvider: nullableText(200),
  amcContractId: z.string().uuid().nullable().optional(),
  amcStart: nullableDate,
  amcEnd: nullableDate,
  eolDate: nullableDate,
  eosDate: nullableDate,
  ownerContactId: z.string().uuid().nullable().optional(),
  assignedContactId: z.string().uuid().nullable().optional(),
  ciId: z.string().uuid().nullable().optional(),
  notes: nullableText(5000),
  tags: z.array(z.string().max(50)).max(50).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});
export type AssetCreateInput = z.infer<typeof assetCreateBody>;

export const assetPatchBody = assetCreateBody.omit({ customerId: true }).partial();
export type AssetPatchInput = z.infer<typeof assetPatchBody>;

export const lifecycleBody = z.object({ stage: z.enum(ASSET_LIFECYCLE), notes: z.string().max(2000).optional() });
export const expiringQuery = z.object({ days: z.coerce.number().int().min(0).max(3650).default(90), kind: z.enum(['warranty', 'amc']).default('warranty'), customerId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });
export const summaryQuery = z.object({ customerId: z.string().uuid().optional() });

export const ASSET_IMPORT_COLUMNS = ['tag', 'name', 'category', 'status', 'site', 'manufacturer', 'model', 'serialNumber', 'purchaseDate', 'purchaseCost', 'vendor', 'warrantyStart', 'warrantyEnd', 'amcStart', 'amcEnd', 'location', 'notes'] as const;
