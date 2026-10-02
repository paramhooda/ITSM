import { z } from 'zod';
import { PM_STATUSES } from '@itsm/shared';
import { paginationSchema, sortSchema } from '@/core/pagination';
import { boolQ, dateStr, uuid } from '@/modules/field/schemas';

const nullableUuid = uuid.nullable().optional();

export const PM_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'half_yearly', 'annual', 'custom'] as const;
export type PmFrequency = (typeof PM_FREQUENCIES)[number];
export { PM_STATUSES };
export type PmStatus = (typeof PM_STATUSES)[number];

export const programChecklistItem = z.object({ item: z.string().trim().min(1).max(500), required: z.boolean().optional() });
export type ProgramChecklistItem = z.infer<typeof programChecklistItem>;

export const programListQuery = paginationSchema.merge(sortSchema).extend({
  q: z.string().max(200).optional(),
  customerId: uuid.optional(),
  siteId: uuid.optional(),
  contractId: uuid.optional(),
  serviceId: uuid.optional(),
  frequency: z.enum(PM_FREQUENCIES).optional(),
  isActive: boolQ,
  assignedTeamId: uuid.optional(),
  assignedEngineerId: uuid.optional(),
});
export type ProgramListQuery = z.infer<typeof programListQuery>;

export const createProgramSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    description: z.string().max(10000).nullable().optional(),
    customerId: uuid,
    siteId: nullableUuid,
    contractId: nullableUuid,
    serviceId: nullableUuid,
    entitlementId: nullableUuid,
    frequency: z.enum(PM_FREQUENCIES).default('quarterly'),
    intervalDays: z.number().int().min(1).max(3650).nullable().optional(),
    startDate: dateStr,
    endDate: dateStr.nullable().optional(),
    leadDays: z.number().int().min(0).max(365).optional(),
    graceDays: z.number().int().min(0).max(365).optional(),
    checklist: z.array(programChecklistItem).max(200).optional(),
    assignedTeamId: nullableUuid,
    assignedEngineerId: nullableUuid,
    ciIds: z.array(uuid).max(500).optional(),
    assetIds: z.array(uuid).max(500).optional(),
    requiresSiteVisit: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.frequency !== 'custom' || !!v.intervalDays, { message: 'intervalDays is required for a custom frequency', path: ['intervalDays'] })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, { message: 'End date must be after the start date', path: ['endDate'] });
export type CreateProgramInput = z.infer<typeof createProgramSchema>;

export const updateProgramSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  description: z.string().max(10000).nullable().optional(),
  siteId: nullableUuid,
  contractId: nullableUuid,
  serviceId: nullableUuid,
  entitlementId: nullableUuid,
  frequency: z.enum(PM_FREQUENCIES).optional(),
  intervalDays: z.number().int().min(1).max(3650).nullable().optional(),
  startDate: dateStr.optional(),
  endDate: dateStr.nullable().optional(),
  leadDays: z.number().int().min(0).max(365).optional(),
  graceDays: z.number().int().min(0).max(365).optional(),
  checklist: z.array(programChecklistItem).max(200).optional(),
  assignedTeamId: nullableUuid,
  assignedEngineerId: nullableUuid,
  ciIds: z.array(uuid).max(500).optional(),
  assetIds: z.array(uuid).max(500).optional(),
  requiresSiteVisit: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;

export const occurrenceListQuery = paginationSchema.merge(sortSchema).extend({
  q: z.string().max(200).optional(),
  customerId: uuid.optional(),
  siteId: uuid.optional(),
  programId: uuid.optional(),
  /** Comma separated statuses. */
  status: z.string().max(200).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  engineerId: uuid.optional(),
  teamId: uuid.optional(),
  overdue: boolQ,
  mine: boolQ,
});
export type OccurrenceListQuery = z.infer<typeof occurrenceListQuery>;

export const scheduleOccurrenceSchema = z.object({
  scheduledDate: dateStr,
  /** Local start time (HH:MM) in the customer's time zone for the generated visit. Default 10:00. */
  scheduledTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  durationMinutes: z.number().int().min(15).max(1440).optional(),
  engineerId: nullableUuid,
  createVisit: z.boolean().optional(),
  notes: z.string().max(4000).nullable().optional(),
});
export type ScheduleOccurrenceInput = z.infer<typeof scheduleOccurrenceSchema>;

export const occurrenceChecklistResult = z.object({
  item: z.string().trim().min(1).max(500),
  required: z.boolean().optional(),
  done: z.boolean().optional(),
  result: z.enum(['ok', 'issue', 'na']).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const completeOccurrenceSchema = z.object({
  completedAt: z.coerce.date().optional(),
  checklistResults: z.array(occurrenceChecklistResult).max(200).optional(),
  notes: z.string().max(10000).nullable().optional(),
  consumeEntitlement: z.boolean().optional(),
});
export type CompleteOccurrenceInput = z.infer<typeof completeOccurrenceSchema>;

export const rescheduleOccurrenceSchema = z.object({
  scheduledDate: dateStr,
  reason: z.string().trim().min(1).max(2000),
});
export type RescheduleOccurrenceInput = z.infer<typeof rescheduleOccurrenceSchema>;

export const cancelOccurrenceSchema = z.object({ reason: z.string().trim().min(1).max(2000) });

export const createTicketSchema = z
  .object({
    title: z.string().trim().min(3).max(300).optional(),
    description: z.string().max(20000).nullable().optional(),
    priorityId: nullableUuid,
  })
  .optional();
export type CreateOccurrenceTicketInput = z.infer<typeof createTicketSchema>;

export const pmSummaryQuery = z.object({
  customerId: uuid.optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
});
export type PmSummaryQuery = z.infer<typeof pmSummaryQuery>;

export const pmCalendarQuery = z.object({
  from: dateStr,
  to: dateStr,
  customerId: uuid.optional(),
  engineerId: uuid.optional(),
  teamId: uuid.optional(),
});
export type PmCalendarQuery = z.infer<typeof pmCalendarQuery>;
