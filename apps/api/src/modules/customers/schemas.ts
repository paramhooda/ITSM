import { z } from 'zod';

export const uuid = z.string().uuid();
const addr = z.record(z.string(), z.string().max(300));
const tz = z.string().max(64);

export const customerCreate = z.object({
  code: z.string().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, dash and underscore only').optional(),
  name: z.string().min(1).max(200),
  legalName: z.string().max(300).nullable().optional(),
  industryId: uuid.nullable().optional(),
  typeId: uuid.nullable().optional(),
  statusId: uuid.nullable().optional(),
  accountManagerId: uuid.nullable().optional(),
  website: z.string().max(300).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  address: addr.optional(),
  timezone: tz.optional(),
  commercial: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().max(8000).nullable().optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
});
export type CustomerCreate = z.infer<typeof customerCreate>;
export const customerPatch = customerCreate.partial();
export type CustomerPatch = z.infer<typeof customerPatch>;

export const customerListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sort: z.enum(['name', 'code', 'createdAt', 'status', 'openTickets', 'activeContracts']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  q: z.string().max(200).optional(),
  statusId: uuid.optional(),
  typeId: uuid.optional(),
  industryId: uuid.optional(),
  accountManagerId: uuid.optional(),
  tag: z.string().max(50).optional(),
  isActive: z.enum(['true', 'false', 'all']).optional(),
  fields: z.enum(['min', 'full']).optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuery>;

/** GET /customers/summary: the list filters without paging/sort/projection. */
export const customerSummaryQuery = customerListQuery.omit({ page: true, pageSize: true, sort: true, order: true, fields: true });
export type CustomerSummaryQuery = z.infer<typeof customerSummaryQuery>;

export const siteInput = z.object({
  code: z.string().min(1).max(32).regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, dash and underscore only').optional(),
  name: z.string().min(1).max(200),
  typeId: uuid.nullable().optional(),
  address: addr.optional(),
  timezone: tz.nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  isPrimary: z.boolean().optional(),
  isActive: z.boolean().optional(),
  businessHoursCalendarId: uuid.nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});
export type SiteInput = z.infer<typeof siteInput>;

export const contactInput = z.object({
  name: z.string().min(1).max(200),
  siteId: uuid.nullable().optional(),
  userId: uuid.nullable().optional(),
  email: z.string().email().max(200).nullable().optional().or(z.literal('')),
  phone: z.string().max(50).nullable().optional(),
  mobile: z.string().max(50).nullable().optional(),
  title: z.string().max(120).nullable().optional(),
  department: z.string().max(120).nullable().optional(),
  isPrimary: z.boolean().optional(),
  isEscalation: z.boolean().optional(),
  escalationLevel: z.coerce.number().int().min(1).max(20).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type ContactInput = z.infer<typeof contactInput>;
