import { z } from 'zod';
import { paginationSchema } from '@/core/pagination';

const uuid = z.string().uuid();
const when = z.coerce.date();

export const ANNOUNCEMENT_TYPES = ['info', 'maintenance', 'outage'] as const;
export const ANNOUNCEMENT_AUDIENCES = ['all', 'customers', 'staff'] as const;

export const announcementBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  type: z.enum(ANNOUNCEMENT_TYPES).optional(),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
  /** Customer organisations the announcement is for; empty = every customer within the audience. */
  customerIds: z.array(uuid).max(200).optional(),
  startsAt: when.optional(),
  endsAt: when.nullable().optional(),
  pinned: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sourceTicketId: uuid.nullable().optional(),
});
export type AnnouncementBody = z.infer<typeof announcementBodySchema>;
export const announcementPatchSchema = announcementBodySchema.partial();
export type AnnouncementPatch = z.infer<typeof announcementPatchSchema>;

export const announcementListSchema = paginationSchema.extend({
  q: z.string().max(200).optional(),
  type: z.enum(ANNOUNCEMENT_TYPES).optional(),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
  /** live = active and inside its window (the default), scheduled = active but not started, ended = past its window or switched off, all. */
  state: z.enum(['live', 'scheduled', 'ended', 'all']).optional(),
  customerId: uuid.optional(),
});
export type AnnouncementListQuery = z.infer<typeof announcementListSchema>;

export const tokenBodySchema = z.object({
  customerId: uuid,
  label: z.string().trim().min(1).max(120),
});
export type TokenBody = z.infer<typeof tokenBodySchema>;

export const customerQuerySchema = z.object({ customerId: uuid.optional() });

export const draftAnnouncementSchema = z.object({
  /** The incident, change or maintenance the announcement is about. */
  ticketId: uuid.optional(),
  type: z.enum(ANNOUNCEMENT_TYPES).optional(),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
  /** Free text to build from when there is no ticket (what happened, what is affected, when it ends). */
  notes: z.string().trim().max(2000).optional(),
});
export type DraftAnnouncementInput = z.infer<typeof draftAnnouncementSchema>;
