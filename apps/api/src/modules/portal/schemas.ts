import { z } from 'zod';
import { paginationSchema } from '@/core/pagination';
import { boolQ } from '@/modules/tickets/schemas';

const uuid = z.string().uuid();
const nullableUuid = uuid.nullable().optional();

/** `?customerId=` is only honoured for MSP users previewing a customer's portal (see service `resolvePortalCustomer`). */
export const previewQuery = z.object({ customerId: uuid.optional() });

export const PORTAL_STATUS_CHIPS = ['open', 'awaiting', 'resolved', 'closed', 'all'] as const;
export type PortalStatusChip = (typeof PORTAL_STATUS_CHIPS)[number];

export const ticketListQuery = paginationSchema.extend({
  customerId: uuid.optional(),
  status: z.enum(PORTAL_STATUS_CHIPS).default('open'),
  type: z.enum(['incident', 'request']).optional(),
  q: z.string().max(200).optional(),
  siteId: uuid.optional(),
  /** Priority key (p1..p5) or id, as the portal home's "by priority" bars link to it. */
  priority: z.string().max(40).optional(),
  mine: boolQ.optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'lastActivityAt', 'dueAt', 'priority', 'number', 'status']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export type TicketListQuery = z.infer<typeof ticketListQuery>;

export const createTicketBody = z.object({
  type: z.enum(['incident', 'request']),
  title: z.string().trim().min(3).max(300),
  description: z.string().max(50000).nullable().optional(),
  siteId: nullableUuid,
  serviceId: nullableUuid,
  catalogItemId: nullableUuid,
  formData: z.record(z.string(), z.unknown()).optional(),
  impactId: nullableUuid,
  urgencyId: nullableUuid,
  ciId: nullableUuid,
  assetId: nullableUuid,
});
export type CreateTicketBody = z.infer<typeof createTicketBody>;

export const commentBody = z.object({ body: z.string().trim().min(1).max(50000) });
export const reopenBody = z.object({ reason: z.string().trim().min(1).max(20000) });
export const closeConfirmBody = z.object({ comment: z.string().trim().max(20000).nullable().optional() }).optional();

export const decideBody = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(5000).nullable().optional() });

export const slaQuery = previewQuery.extend({ days: z.coerce.number().int().min(1).max(365).default(30) });

export const assetListQuery = paginationSchema.extend({
  customerId: uuid.optional(),
  q: z.string().max(200).optional(),
  siteId: uuid.optional(),
  categoryId: uuid.optional(),
  sort: z.enum(['tag', 'name', 'warrantyEnd', 'amcEnd', 'createdAt', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export type AssetListQuery = z.infer<typeof assetListQuery>;

export const ciListQuery = paginationSchema.extend({
  customerId: uuid.optional(),
  q: z.string().max(200).optional(),
  siteId: uuid.optional(),
  typeId: uuid.optional(),
  status: z.string().max(32).optional(),
  criticality: z.string().max(32).optional(),
  sort: z.enum(['name', 'hostname', 'ipAddress', 'typeName', 'updatedAt', 'criticality']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export type CiListQuery = z.infer<typeof ciListQuery>;

export const maintenanceQuery = previewQuery.extend({ pastDays: z.coerce.number().int().min(1).max(365).default(90), futureDays: z.coerce.number().int().min(1).max(365).default(90) });

export const acknowledgeBody = z.object({
  name: z.string().trim().min(1).max(200),
  title: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
});
export type AcknowledgeBody = z.infer<typeof acknowledgeBody>;

export const PORTAL_ROLE_KEYS = ['customer_user', 'customer_admin'] as const;
export type PortalRoleKey = (typeof PORTAL_ROLE_KEYS)[number];

export const userListQuery = paginationSchema.extend({ customerId: uuid.optional(), q: z.string().max(200).optional(), status: z.enum(['active', 'disabled']).optional() });
export type UserListQuery = z.infer<typeof userListQuery>;

export const createUserBody = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(50).nullable().optional(),
  title: z.string().trim().max(100).nullable().optional(),
  role: z.enum(PORTAL_ROLE_KEYS).default('customer_user'),
});
export type CreateUserBody = z.infer<typeof createUserBody>;

export const updateUserBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  title: z.string().trim().max(100).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  role: z.enum(PORTAL_ROLE_KEYS).optional(),
});
export type UpdateUserBody = z.infer<typeof updateUserBody>;
