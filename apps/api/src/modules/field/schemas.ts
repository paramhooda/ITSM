import { z } from 'zod';
import { FIELD_VISIT_STATUSES } from '@itsm/shared';
import { paginationSchema, sortSchema } from '@/core/pagination';

export const uuid = z.string().uuid();
const nullableUuid = uuid.nullable().optional();
const jsonRecord = z.record(z.string(), z.unknown());
/** Query-string boolean ("true"/"false"/"1"/"0"); `z.coerce.boolean()` would treat "false" as true. */
export const boolQ = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
/** Accepts ISO datetimes and plain dates in query strings. */
const dateish = z.string().min(4).max(40);

/** Checklist item as stored in `field_visits.checklist` (planned items + execution results in one place). */
export const checklistItemSchema = z.object({
  item: z.string().trim().min(1).max(500),
  required: z.boolean().optional(),
  done: z.boolean().optional(),
  result: z.enum(['ok', 'issue', 'na']).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;
export const checklistSchema = z.array(checklistItemSchema).max(200);

export const visitListQuery = paginationSchema.merge(sortSchema).extend({
  q: z.string().max(200).optional(),
  customerId: uuid.optional(),
  siteId: uuid.optional(),
  /** Comma separated statuses. */
  status: z.string().max(200).optional(),
  engineerId: uuid.optional(),
  teamId: uuid.optional(),
  typeId: uuid.optional(),
  ticketId: uuid.optional(),
  contractId: uuid.optional(),
  pmProgramId: uuid.optional(),
  from: dateish.optional(),
  to: dateish.optional(),
  mine: boolQ,
  unacknowledged: boolQ,
});
export type VisitListQuery = z.infer<typeof visitListQuery>;

export const calendarQuery = z.object({
  from: dateish,
  to: dateish,
  engineerId: uuid.optional(),
  teamId: uuid.optional(),
  customerId: uuid.optional(),
  includeCancelled: boolQ,
});
export type CalendarQuery = z.infer<typeof calendarQuery>;

export const createVisitSchema = z.object({
  customerId: uuid,
  siteId: nullableUuid,
  ticketId: nullableUuid,
  contractId: nullableUuid,
  serviceId: nullableUuid,
  typeId: uuid,
  title: z.string().trim().min(3).max(300),
  purpose: z.string().max(10000).nullable().optional(),
  scheduledStart: z.coerce.date().nullable().optional(),
  scheduledEnd: z.coerce.date().nullable().optional(),
  engineerId: nullableUuid,
  teamId: nullableUuid,
  additionalEngineerIds: z.array(uuid).max(20).optional(),
  entitlementId: nullableUuid,
  billable: z.boolean().optional(),
  checklist: checklistSchema.optional(),
  customFields: jsonRecord.optional(),
});
export type CreateVisitInput = z.infer<typeof createVisitSchema>;

export const updateVisitSchema = createVisitSchema.omit({ customerId: true }).partial();
export type UpdateVisitInput = z.infer<typeof updateVisitSchema>;

export const scheduleVisitSchema = z.object({
  scheduledStart: z.coerce.date(),
  scheduledEnd: z.coerce.date().nullable().optional(),
  engineerId: uuid,
  teamId: nullableUuid,
  additionalEngineerIds: z.array(uuid).max(20).optional(),
});
export type ScheduleVisitInput = z.infer<typeof scheduleVisitSchema>;

export const startVisitSchema = z.object({ actualStart: z.coerce.date().optional() }).optional();

export const completeVisitSchema = z.object({
  actualEnd: z.coerce.date().nullable().optional(),
  workSummary: z.string().trim().min(3).max(20000),
  findings: z.string().max(20000).nullable().optional(),
  recommendations: z.string().max(20000).nullable().optional(),
  workMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  travelMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  checklist: checklistSchema.optional(),
  consumeEntitlement: z.boolean().optional(),
  billable: z.boolean().optional(),
});
export type CompleteVisitInput = z.infer<typeof completeVisitSchema>;

export const cancelVisitSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export const rescheduleVisitSchema = z.object({
  scheduledStart: z.coerce.date(),
  scheduledEnd: z.coerce.date().nullable().optional(),
  reason: z.string().trim().min(1).max(2000),
});
export type RescheduleVisitInput = z.infer<typeof rescheduleVisitSchema>;

export const acknowledgeVisitSchema = z.object({
  name: z.string().trim().min(1).max(200),
  title: z.string().max(200).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
});
export type AcknowledgeVisitInput = z.infer<typeof acknowledgeVisitSchema>;

export const partSchema = z.object({
  name: z.string().trim().min(1).max(300),
  partNumber: z.string().max(100).nullable().optional(),
  serialNumber: z.string().max(100).nullable().optional(),
  quantity: z.coerce.number().positive().max(1_000_000).optional(),
  unitCost: z.coerce.number().min(0).nullable().optional(),
  assetId: nullableUuid,
  billable: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type PartInput = z.infer<typeof partSchema>;
export const partPatchSchema = partSchema.partial();

export const noteSchema = z.object({
  body: z.string().trim().min(1).max(20000),
  isInternal: z.boolean().optional(),
});
export type NoteInput = z.infer<typeof noteSchema>;

export const summaryQuery = z.object({
  customerId: uuid.optional(),
  from: dateish.optional(),
  to: dateish.optional(),
});
export type SummaryQuery = z.infer<typeof summaryQuery>;

export const workloadQuery = z.object({
  from: dateish,
  to: dateish,
  teamId: uuid.optional(),
});
export type WorkloadQuery = z.infer<typeof workloadQuery>;

export const VISIT_STATUSES = FIELD_VISIT_STATUSES;
export type VisitStatus = (typeof FIELD_VISIT_STATUSES)[number];
