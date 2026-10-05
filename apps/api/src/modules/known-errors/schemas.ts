import { z } from 'zod';
import { KNOWN_ERROR_STATUSES } from '@itsm/shared';
import { paginationSchema } from '@/core/pagination';

// Do NOT import from '@/modules/tickets/schemas' here: that file merges knownErrorPatchSchema from this one,
// and two value imports evaluated at module load would form a cycle. Local copy of the boolean query flag.
const boolQ = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

const uuid = z.string().uuid();
export const KE_STATUS_FILTERS = [...KNOWN_ERROR_STATUSES, 'active', 'all'] as const;
export type KeStatusFilter = (typeof KE_STATUS_FILTERS)[number];

export const listQuerySchema = paginationSchema.extend({
  q: z.string().max(200).optional(),
  customerId: uuid.optional(),
  serviceId: uuid.optional(),
  ciId: uuid.optional(),
  status: z.enum(KE_STATUS_FILTERS).default('active'),
  portalVisible: boolQ,
  hasFixChange: boolQ,
  sort: z.enum(['updatedAt', 'identifiedAt', 'publishedAt', 'incidents', 'title', 'number', 'status']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const statsQuerySchema = z.object({ customerId: uuid.optional() });

export const suggestQuerySchema = z.object({
  q: z.string().min(2).max(500),
  customerId: uuid.optional(),
  serviceId: uuid.optional(),
  ciId: uuid.optional(),
  excludeTicketId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});
export type SuggestQuery = z.infer<typeof suggestQuerySchema>;

/** Known-error fields an engineer edits (problems:manage); also merged into problemDetailsSchema. */
export const knownErrorPatchSchema = z.object({
  keStatus: z.enum(KNOWN_ERROR_STATUSES).optional(),
  fixChangeId: uuid.nullable().optional(),
  fixChangeNumber: z.string().max(40).optional(),
  customerSummary: z.string().max(2000).nullable().optional(),
  customerWorkaround: z.string().max(4000).nullable().optional(),
});
export type KnownErrorPatch = z.infer<typeof knownErrorPatchSchema>;

export const statusBodySchema = z.object({ status: z.enum(KNOWN_ERROR_STATUSES) });

export const publishBodySchema = z.object({
  customerSummary: z.string().trim().min(10).max(2000),
  customerWorkaround: z.string().trim().min(10).max(4000),
  notify: z.boolean().optional(),
});
export type PublishBody = z.infer<typeof publishBodySchema>;

/** Portal list: own organisation, published entries only. */
export const portalListQuerySchema = paginationSchema.extend({
  customerId: uuid.optional(),
  q: z.string().max(200).optional(),
  serviceId: uuid.optional(),
  status: z.enum(['active', 'resolved', 'all']).default('active'),
});
export type PortalListQuery = z.infer<typeof portalListQuerySchema>;

export const portalSuggestQuerySchema = z.object({ q: z.string().min(2).max(500), customerId: uuid.optional(), serviceId: uuid.optional(), limit: z.coerce.number().int().min(1).max(10).optional() });
export type PortalSuggestQuery = z.infer<typeof portalSuggestQuerySchema>;
