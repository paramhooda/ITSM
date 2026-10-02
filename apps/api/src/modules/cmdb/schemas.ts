import { z } from 'zod';
import { CI_STATUSES } from '@itsm/shared';
import { paginationSchema } from '@/core/pagination';

export const CI_ENVIRONMENTS = ['production', 'staging', 'test', 'development', 'dr', 'other'] as const;
export const CI_CRITICALITIES = ['critical', 'high', 'medium', 'low'] as const;

const nullableText = (max = 200) => z.string().max(max).nullable().optional();
const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());

export const ciListQuery = paginationSchema.extend({
  q: z.string().max(200).optional(),
  customerId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  typeId: z.string().uuid().optional(),
  typeKey: z.string().max(64).optional(),
  status: z.enum(CI_STATUSES).optional(),
  environment: z.string().max(32).optional(),
  criticality: z.enum(CI_CRITICALITIES).optional(),
  ownerTeamId: z.string().uuid().optional(),
  hasAsset: bool,
  serviceId: z.string().uuid().optional(),
  tag: z.string().max(50).optional(),
  stale: bool,
  sort: z.enum(['name', 'hostname', 'ipAddress', 'typeName', 'updatedAt', 'lastSeenAt', 'createdAt', 'customer', 'criticality']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  fields: z.enum(['min', 'full']).optional(),
});
export type CiListQuery = z.infer<typeof ciListQuery>;

export const ciCreateBody = z.object({
  customerId: z.string().uuid(),
  siteId: z.string().uuid().nullable().optional(),
  typeId: z.string().uuid(),
  name: z.string().min(1).max(200),
  hostname: nullableText(253),
  fqdn: nullableText(253),
  ipAddress: nullableText(64),
  macAddress: nullableText(32),
  serialNumber: nullableText(120),
  manufacturer: nullableText(120),
  model: nullableText(120),
  osName: nullableText(120),
  osVersion: nullableText(120),
  firmwareVersion: nullableText(120),
  environment: z.enum(CI_ENVIRONMENTS).optional(),
  criticality: z.enum(CI_CRITICALITIES).optional(),
  status: z.enum(CI_STATUSES).optional(),
  description: nullableText(5000),
  ownerTeamId: z.string().uuid().nullable().optional(),
  assetId: z.string().uuid().nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  monitoringRef: nullableText(200),
  siemRef: nullableText(200),
  tags: z.array(z.string().max(50)).max(50).optional(),
  serviceIds: z.array(z.string().uuid()).max(100).optional(),
});
export type CiCreateInput = z.infer<typeof ciCreateBody>;

export const ciPatchBody = ciCreateBody.omit({ customerId: true }).partial();
export type CiPatchInput = z.infer<typeof ciPatchBody>;

export const relationshipBody = z.object({ targetCiId: z.string().uuid(), typeId: z.string().uuid(), description: z.string().max(500).nullable().optional() });
export const servicesBody = z.object({ serviceIds: z.array(z.string().uuid()).max(200) });
export const interfaceItem = z.object({
  name: z.string().min(1).max(120),
  ifIndex: z.number().int().nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  macAddress: z.string().max(32).nullable().optional(),
  ipAddress: z.string().max(64).nullable().optional(),
  speedMbps: z.number().int().nullable().optional(),
  adminStatus: z.string().max(16).nullable().optional(),
  operStatus: z.string().max(16).nullable().optional(),
  vlan: z.string().max(32).nullable().optional(),
});
export const interfacesBody = z.object({ interfaces: z.array(interfaceItem).max(1024) });
export type InterfaceInput = z.infer<typeof interfaceItem>;

export const graphQuery = z.object({ depth: z.coerce.number().int().min(1).max(3).default(2), limit: z.coerce.number().int().min(10).max(150).default(150) });
export const summaryQuery = z.object({ customerId: z.string().uuid().optional() });

export const CI_IMPORT_COLUMNS = ['name', 'type', 'hostname', 'ipAddress', 'macAddress', 'serialNumber', 'manufacturer', 'model', 'osName', 'site', 'environment', 'criticality', 'status', 'description'] as const;
