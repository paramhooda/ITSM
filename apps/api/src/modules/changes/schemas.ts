import { z } from 'zod';
import { paginationSchema } from '@/core/pagination';

const uuid = z.string().uuid();
const when = z.coerce.date();
const key = z.string().trim().min(1).max(60).regex(/^[a-z0-9_]+$/, 'Lowercase letters, digits and underscores only');

export const CAB_DECISIONS = ['pending', 'approved', 'rejected', 'deferred'] as const;
export const CAB_STATUSES = ['scheduled', 'in_progress', 'closed', 'cancelled'] as const;
export const CHANGE_TYPES = ['standard', 'normal', 'emergency'] as const;

// ---------------------------------------------------------------- blackout windows

export const blackoutBodySchema = z
  .object({
    customerId: uuid.nullable().optional(),
    name: z.string().trim().min(1).max(160),
    reason: z.string().trim().max(1000).nullable().optional(),
    startsAt: when,
    endsAt: when,
    allowEmergency: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((b) => b.endsAt.getTime() > b.startsAt.getTime(), { message: 'The window must end after it starts', path: ['endsAt'] });
export type BlackoutBody = z.infer<typeof blackoutBodySchema>;
export const blackoutPatchSchema = z.object({
  customerId: uuid.nullable().optional(),
  name: z.string().trim().min(1).max(160).optional(),
  reason: z.string().trim().max(1000).nullable().optional(),
  startsAt: when.optional(),
  endsAt: when.optional(),
  allowEmergency: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export type BlackoutPatch = z.infer<typeof blackoutPatchSchema>;

// ---------------------------------------------------------------- risk questions

const optionSchema = z.object({ key, label: z.string().trim().min(1).max(160), score: z.number().int().min(0).max(100) });
export const riskQuestionBodySchema = z.object({
  key,
  question: z.string().trim().min(1).max(300),
  hint: z.string().trim().max(500).nullable().optional(),
  weight: z.number().int().min(0).max(10).optional(),
  options: z.array(optionSchema).min(2).max(10),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
});
export type RiskQuestionBody = z.infer<typeof riskQuestionBodySchema>;
export const riskQuestionPatchSchema = riskQuestionBodySchema.partial();
export type RiskQuestionPatch = z.infer<typeof riskQuestionPatchSchema>;

/** Question key → option key. */
export const riskAnswersSchema = z.record(key, key);
export type RiskAnswers = z.infer<typeof riskAnswersSchema>;
export const assessBodySchema = z.object({ answers: riskAnswersSchema });

// ---------------------------------------------------------------- templates

export const templateBodySchema = z.object({
  key,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  changeType: z.enum(CHANGE_TYPES).optional(),
  categoryId: uuid.nullable().optional(),
  serviceId: uuid.nullable().optional(),
  riskId: uuid.nullable().optional(),
  titleTemplate: z.string().trim().max(200).nullable().optional(),
  descriptionTemplate: z.string().trim().max(5000).nullable().optional(),
  justification: z.string().trim().max(5000).nullable().optional(),
  implementationPlan: z.string().trim().max(10000).nullable().optional(),
  testPlan: z.string().trim().max(10000).nullable().optional(),
  backoutPlan: z.string().trim().max(10000).nullable().optional(),
  communicationPlan: z.string().trim().max(5000).nullable().optional(),
  downtimeExpectedMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  skipApproval: z.boolean().optional(),
  customerIds: z.array(uuid).max(200).optional(),
  isActive: z.boolean().optional(),
});
export type TemplateBody = z.infer<typeof templateBodySchema>;
export const templatePatchSchema = templateBodySchema.partial();
export type TemplatePatch = z.infer<typeof templatePatchSchema>;
export const templatesQuerySchema = z.object({ customerId: uuid.optional(), all: z.coerce.boolean().optional() });

// ---------------------------------------------------------------- calendar and conflicts

export const calendarQuerySchema = z.object({
  from: when,
  to: when,
  customerId: uuid.optional(),
  /** Include blackout windows in the answer (default true). */
  blackouts: z.coerce.boolean().optional(),
});
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

export const conflictPreviewSchema = z.object({
  /** The change being edited (excluded from the overlap check); omit for a new one. */
  ticketId: uuid.optional(),
  customerId: uuid,
  scheduledStart: when,
  scheduledEnd: when.optional(),
  changeType: z.enum(CHANGE_TYPES).optional(),
  ciIds: z.array(uuid).max(100).optional(),
  primaryCiId: uuid.nullable().optional(),
});
export type ConflictPreview = z.infer<typeof conflictPreviewSchema>;

// ---------------------------------------------------------------- CAB

export const cabMeetingBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  scheduledAt: when,
  chairUserId: uuid.nullable().optional(),
  status: z.enum(CAB_STATUSES).optional(),
  minutes: z.string().trim().max(20000).nullable().optional(),
  /** Change tickets to put on the agenda at creation. */
  ticketIds: z.array(uuid).max(100).optional(),
});
export type CabMeetingBody = z.infer<typeof cabMeetingBodySchema>;
export const cabMeetingPatchSchema = cabMeetingBodySchema.omit({ ticketIds: true }).partial();
export type CabMeetingPatch = z.infer<typeof cabMeetingPatchSchema>;
export const cabListSchema = paginationSchema.extend({ status: z.enum([...CAB_STATUSES, 'upcoming', 'all']).optional(), q: z.string().max(200).optional() });
export type CabListQuery = z.infer<typeof cabListSchema>;
export const cabItemBodySchema = z.object({ ticketId: uuid, notes: z.string().trim().max(2000).nullable().optional() });
export type CabItemBody = z.infer<typeof cabItemBodySchema>;
export const cabDecideSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'deferred']),
  notes: z.string().trim().max(2000).nullable().optional(),
  /** Also decide the ticket's pending CAB approval step (default true for approved and rejected). */
  applyToApproval: z.boolean().optional(),
});
export type CabDecideBody = z.infer<typeof cabDecideSchema>;
