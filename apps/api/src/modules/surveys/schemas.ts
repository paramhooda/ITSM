import { z } from 'zod';
import { TICKET_TYPES, SURVEY_SEND_ON, SURVEY_CHANNELS } from '@itsm/shared';
import { paginationSchema } from '@/core/pagination';

const uuid = z.string().uuid();
export const ratingSchema = z.number().int().min(1).max(5);
export const commentSchema = z.string().trim().max(4000);

/** A survey policy override for one customer (contractId null) or one contract; null fields inherit the global settings. */
export const configInput = z.object({
  customerId: uuid,
  contractId: uuid.nullable().optional(),
  enabled: z.boolean().nullable().optional(),
  sendOn: z.enum(SURVEY_SEND_ON).nullable().optional(),
  resendOnClose: z.boolean().nullable().optional(),
  samplingPct: z.number().int().min(0).max(100).nullable().optional(),
  question: z.string().trim().min(5).max(300).nullable().optional(),
  commentPrompt: z.string().trim().max(300).nullable().optional(),
  reminderDays: z.number().int().min(0).max(60).nullable().optional(),
  expiryDays: z.number().int().min(1).max(90).nullable().optional(),
  fatigueDays: z.number().int().min(0).max(365).nullable().optional(),
  lowRatingThreshold: z.number().int().min(1).max(4).nullable().optional(),
  ticketTypes: z.array(z.enum(TICKET_TYPES)).min(1).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type ConfigInput = z.infer<typeof configInput>;
export const configPatch = configInput.omit({ customerId: true }).partial();
export type ConfigPatch = z.infer<typeof configPatch>;
export const configListQuery = z.object({ customerId: uuid.optional() });

export const answerBody = z.object({ rating: ratingSchema, comment: commentSchema.nullable().optional() });
export type AnswerBody = z.infer<typeof answerBody>;
export const publicRatingBody = z.object({ rating: ratingSchema });
export const publicCommentBody = z.object({ comment: commentSchema.min(1) });

export const GROUP_BY = ['customer', 'engineer', 'team', 'service', 'priority', 'channel', 'month'] as const;
export type GroupBy = (typeof GROUP_BY)[number];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const summaryQuery = z.object({
  customerId: uuid.optional(),
  days: z.coerce.number().int().min(1).max(730).optional(),
  from: day.optional(),
  to: day.optional(),
  groupBy: z.enum(GROUP_BY).optional(),
  assigneeId: uuid.optional(),
  teamId: uuid.optional(),
  serviceId: uuid.optional(),
  domain: z.string().max(40).optional(),
});
export type SummaryQuery = z.infer<typeof summaryQuery>;

export const SURVEY_STATUSES = ['pending', 'answered', 'expired', 'cancelled'] as const;
export const responsesQuery = paginationSchema.extend({
  customerId: uuid.optional(),
  days: z.coerce.number().int().min(1).max(730).optional(),
  from: day.optional(),
  to: day.optional(),
  status: z.enum(SURVEY_STATUSES).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  low: z.coerce.boolean().optional(),
  /** Overrides the global low-rating threshold for the `low` filter (the assistant's threshold argument). */
  lowThreshold: z.coerce.number().int().min(1).max(4).optional(),
  assigneeId: uuid.optional(),
  teamId: uuid.optional(),
  serviceId: uuid.optional(),
  channel: z.enum(SURVEY_CHANNELS).optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(['answeredAt', 'requestedAt', 'rating', 'customer']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export type ResponsesQuery = z.infer<typeof responsesQuery>;
export const policyQuery = z.object({ customerId: uuid.optional(), contractId: uuid.optional() });
export type PolicyQuery = z.infer<typeof policyQuery>;
/** The format is checked again inside the public reader so a malformed token answers the same 404 as an unknown one. */
export const tokenParam = z.object({ token: z.string().min(1).max(128) });
