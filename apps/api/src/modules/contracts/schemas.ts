import { z } from 'zod';
import { ENTITLEMENT_PERIODS } from '@itsm/shared';

export const uuid = z.string().uuid();
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
/** Query-string boolean ("true"/"false"/"1"/"0"). */
export const boolQuery = z.preprocess((v) => (typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) : v), z.boolean());
/** Comma separated list in a query string. */
export const csv = z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v), z.array(z.string()));

export const CONTRACT_STATUSES = ['draft', 'active', 'expiring', 'expired', 'terminated', 'renewed'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
/** Statuses under which a contract provides coverage. */
export const COVERING_STATUSES: ContractStatus[] = ['active', 'expiring'];

export const contractServiceInput = z.object({
  serviceId: uuid,
  slaPolicyId: uuid.nullable().optional(),
  teamId: uuid.nullable().optional(),
  supportHoursCalendarId: uuid.nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});
export type ContractServiceInput = z.infer<typeof contractServiceInput>;

export const entitlementInput = z.object({
  typeId: uuid.nullable().optional(),
  name: z.string().min(1).max(200),
  serviceId: uuid.nullable().optional(),
  quantity: z.coerce.number().min(0),
  unit: z.string().max(32).optional(),
  period: z.enum(ENTITLEMENT_PERIODS).optional(),
  warnThresholdPct: z.coerce.number().int().min(1).max(100).optional(),
  overageAllowed: z.boolean().optional(),
  overageRate: z.coerce.number().min(0).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type EntitlementInput = z.infer<typeof entitlementInput>;

export const consumptionInput = z.object({
  quantity: z.coerce.number().positive(),
  consumedAt: z.string().datetime({ offset: true }).optional(),
  notes: z.string().max(2000).nullable().optional(),
  ticketId: uuid.nullable().optional(),
  sourceType: z.string().max(32).optional(),
  sourceId: uuid.nullable().optional(),
});
export type ConsumptionInput = z.infer<typeof consumptionInput>;

export const scopeItemInput = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(4000).nullable().optional(),
  classification: z.enum(['in_scope', 'out_of_scope']).optional(),
  headerId: uuid.nullable().optional(),
  categoryId: uuid.nullable().optional(),
  typeId: uuid.nullable().optional(),
  statusId: uuid.nullable().optional(),
  serviceId: uuid.nullable().optional(),
  siteId: uuid.nullable().optional(),
  ticketCategoryId: uuid.nullable().optional(),
  ciTypeKey: z.string().max(64).nullable().optional(),
  assetCategoryId: uuid.nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.coerce.number().int().optional(),
});
export type ScopeItemInput = z.infer<typeof scopeItemInput>;

export const escalationLevel = z.object({
  level: z.coerce.number().int().min(1).max(20),
  name: z.string().max(200).nullable().optional(),
  contactId: uuid.nullable().optional(),
  userId: uuid.nullable().optional(),
  afterMinutes: z.coerce.number().int().min(0).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const commercialFields = ['value', 'currency', 'billingCycle', 'commercial', 'poNumber', 'signedAt'] as const;

export const contractCreate = z.object({
  customerId: uuid,
  number: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(200),
  typeId: uuid.nullable().optional(),
  status: z.enum(CONTRACT_STATUSES).optional(),
  startDate: dateStr,
  endDate: dateStr,
  renewalDate: dateStr.nullable().optional(),
  noticePeriodDays: z.coerce.number().int().min(0).max(3650).nullable().optional(),
  autoRenew: z.boolean().optional(),
  supportHoursCalendarId: uuid.nullable().optional(),
  holidayCalendarId: uuid.nullable().optional(),
  slaPolicyId: uuid.nullable().optional(),
  escalationMatrix: z.array(escalationLevel).optional(),
  responseCommitment: z.string().max(2000).nullable().optional(),
  resolutionCommitment: z.string().max(2000).nullable().optional(),
  exclusions: z.string().max(8000).nullable().optional(),
  description: z.string().max(8000).nullable().optional(),
  value: z.coerce.number().min(0).nullable().optional(),
  currency: z.string().max(8).nullable().optional(),
  billingCycle: z.string().max(32).nullable().optional(),
  commercial: z.record(z.string(), z.unknown()).optional(),
  poNumber: z.string().max(100).nullable().optional(),
  signedAt: dateStr.nullable().optional(),
  ownerUserId: uuid.nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  services: z.array(contractServiceInput).optional(),
  siteIds: z.array(uuid).optional(),
  entitlements: z.array(entitlementInput).optional(),
  scopeItems: z.array(scopeItemInput).optional(),
});
export type ContractCreate = z.infer<typeof contractCreate>;

export const contractPatch = contractCreate.omit({ customerId: true, services: true, siteIds: true, entitlements: true, scopeItems: true, status: true }).partial();
export type ContractPatch = z.infer<typeof contractPatch>;

export const renewInput = z.object({
  startDate: dateStr,
  endDate: dateStr,
  number: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(200).optional(),
  carryEntitlements: z.boolean().optional(),
  resetConsumption: z.boolean().optional(),
});
export type RenewInput = z.infer<typeof renewInput>;

export const contractListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sort: z.enum(['endDate', 'startDate', 'number', 'name', 'customer', 'status', 'createdAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  q: z.string().max(200).optional(),
  customerId: uuid.optional(),
  status: csv.optional(),
  typeId: uuid.optional(),
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  serviceId: uuid.optional(),
  siteId: uuid.optional(),
  ownerUserId: uuid.optional(),
  includeInactive: boolQuery.optional(),
});
export type ContractListQuery = z.infer<typeof contractListQuery>;
