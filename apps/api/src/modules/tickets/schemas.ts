import { z } from 'zod';
import { TICKET_TYPES, LINK_TYPES, CHANGE_TYPES, SCOPE_STATUSES } from '@itsm/shared';
import { paginationSchema, sortSchema } from '@/core/pagination';

const uuid = z.string().uuid();
const nullableUuid = uuid.nullable().optional();
const jsonRecord = z.record(z.string(), z.unknown());

/** Boolean query flags (`?mine=true`); `z.coerce.boolean()` would treat "false" as true. */
export const boolQ = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

export const changeDetailsSchema = z.object({
  changeType: z.enum(CHANGE_TYPES).optional(),
  riskId: nullableUuid,
  riskAssessment: z.string().max(10000).nullable().optional(),
  impactAssessment: z.string().max(10000).nullable().optional(),
  justification: z.string().max(10000).nullable().optional(),
  implementationPlan: z.string().max(20000).nullable().optional(),
  testPlan: z.string().max(20000).nullable().optional(),
  backoutPlan: z.string().max(20000).nullable().optional(),
  communicationPlan: z.string().max(20000).nullable().optional(),
  scheduledStart: z.coerce.date().nullable().optional(),
  scheduledEnd: z.coerce.date().nullable().optional(),
  actualStart: z.coerce.date().nullable().optional(),
  actualEnd: z.coerce.date().nullable().optional(),
  downtimeExpectedMinutes: z.number().int().min(0).nullable().optional(),
  cabNotes: z.string().max(10000).nullable().optional(),
  implementationNotes: z.string().max(20000).nullable().optional(),
  pirNotes: z.string().max(20000).nullable().optional(),
  pirOutcome: z.string().max(200).nullable().optional(),
});
export type ChangeDetailsInput = z.infer<typeof changeDetailsSchema>;

export const problemDetailsSchema = z.object({
  symptoms: z.string().max(20000).nullable().optional(),
  investigation: z.string().max(20000).nullable().optional(),
  rootCause: z.string().max(20000).nullable().optional(),
  workaround: z.string().max(20000).nullable().optional(),
  isKnownError: z.boolean().optional(),
  permanentFix: z.string().max(20000).nullable().optional(),
  kbArticleId: nullableUuid,
  impactSummary: z.string().max(10000).nullable().optional(),
});
export type ProblemDetailsInput = z.infer<typeof problemDetailsSchema>;

export const createTicketSchema = z.object({
  type: z.enum(TICKET_TYPES),
  customerId: uuid,
  siteId: nullableUuid,
  serviceId: nullableUuid,
  contractId: nullableUuid,
  title: z.string().trim().min(3).max(300),
  description: z.string().max(50000).nullable().optional(),
  categoryId: nullableUuid,
  subcategoryId: nullableUuid,
  priorityId: nullableUuid,
  impactId: nullableUuid,
  urgencyId: nullableUuid,
  statusId: nullableUuid,
  sourceId: nullableUuid,
  assignedTeamId: nullableUuid,
  assigneeId: nullableUuid,
  requesterUserId: nullableUuid,
  requesterContactId: nullableUuid,
  primaryCiId: nullableUuid,
  primaryAssetId: nullableUuid,
  ciIds: z.array(uuid).max(100).optional(),
  assetIds: z.array(uuid).max(100).optional(),
  watcherIds: z.array(uuid).max(50).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  customFields: jsonRecord.optional(),
  catalogItemId: nullableUuid,
  formData: jsonRecord.optional(),
  securitySeverityId: nullableUuid,
  isMajor: z.boolean().optional(),
  parentTicketId: nullableUuid,
  slaPolicyId: nullableUuid,
  externalRef: z.string().max(200).nullable().optional(),
  change: changeDetailsSchema.optional(),
  problem: problemDetailsSchema.optional(),
});
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const updateTicketSchema = z.object({
  title: z.string().trim().min(3).max(300).optional(),
  description: z.string().max(50000).nullable().optional(),
  siteId: nullableUuid,
  serviceId: nullableUuid,
  contractId: nullableUuid,
  categoryId: nullableUuid,
  subcategoryId: nullableUuid,
  priorityId: nullableUuid,
  impactId: nullableUuid,
  urgencyId: nullableUuid,
  sourceId: nullableUuid,
  requesterUserId: nullableUuid,
  requesterContactId: nullableUuid,
  primaryCiId: nullableUuid,
  primaryAssetId: nullableUuid,
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  customFields: jsonRecord.optional(),
  formData: jsonRecord.optional(),
  securitySeverityId: nullableUuid,
  isMajor: z.boolean().optional(),
  parentTicketId: nullableUuid,
  slaPolicyId: nullableUuid,
  externalRef: z.string().max(200).nullable().optional(),
  resolutionNotes: z.string().max(20000).nullable().optional(),
});
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

export const statusChangeSchema = z.object({
  statusId: uuid,
  resolutionCodeId: nullableUuid,
  resolutionNotes: z.string().max(20000).nullable().optional(),
  closureCodeId: nullableUuid,
  comment: z.string().max(20000).nullable().optional(),
});

export const resolveSchema = z.object({
  resolutionCodeId: nullableUuid,
  resolutionNotes: z.string().trim().min(1).max(20000),
  comment: z.string().max(20000).nullable().optional(),
});

export const closeSchema = z.object({ closureCodeId: nullableUuid, comment: z.string().max(20000).nullable().optional() });
export const reopenSchema = z.object({ comment: z.string().max(20000).nullable().optional() });
export const cancelSchema = z.object({ closureCodeId: nullableUuid, comment: z.string().max(20000).nullable().optional() });

export const assignSchema = z.object({
  teamId: nullableUuid,
  assigneeId: nullableUuid,
  autoProgress: z.boolean().optional(),
  comment: z.string().max(2000).nullable().optional(),
});

export const escalateSchema = z.object({ reason: z.string().trim().min(1).max(2000), notifyRoles: z.array(z.string()).optional() });

export const scopeOverrideSchema = z.object({ scopeStatus: z.enum(SCOPE_STATUSES), scopeNote: z.string().max(2000).nullable().optional(), scopeContractId: nullableUuid });

export const scopePreviewSchema = z.object({ customerId: uuid, serviceId: nullableUuid, siteId: nullableUuid, ticketCategoryId: nullableUuid, primaryCiId: nullableUuid });

export const commentSchema = z.object({
  kind: z.enum(['comment', 'work_note', 'resolution']).default('comment'),
  body: z.string().trim().min(1).max(50000),
  minutesSpent: z.number().int().min(1).max(24 * 60).nullable().optional(),
  workType: z.string().max(40).optional(),
  billable: z.boolean().optional(),
});

export const commentEditSchema = z.object({ body: z.string().trim().min(1).max(50000) });

export const linkSchema = z.object({ targetTicketId: uuid.optional(), targetNumber: z.string().trim().max(40).optional(), linkType: z.enum(LINK_TYPES).default('related') }).refine((v) => v.targetTicketId || v.targetNumber, { message: 'targetTicketId or targetNumber is required' });

export const idsSchema = z.object({ ids: z.array(uuid).max(200) });

export const taskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10000).nullable().optional(),
  status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(),
  assigneeId: nullableUuid,
  teamId: nullableUuid,
  dueAt: z.coerce.date().nullable().optional(),
  sortOrder: z.number().int().optional(),
});
export const taskPatchSchema = taskSchema.partial();

export const timeEntrySchema = z.object({
  minutes: z.number().int().min(1).max(24 * 60 * 7),
  description: z.string().max(2000).nullable().optional(),
  workType: z.enum(['remote', 'onsite', 'travel', 'other']).default('remote'),
  billable: z.boolean().optional(),
  startedAt: z.coerce.date().nullable().optional(),
  entitlementId: nullableUuid,
  userId: nullableUuid,
});

export const watcherSchema = z.object({ userId: uuid.optional() });

export const decideSchema = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(5000).nullable().optional() });
export const requestApprovalSchema = z.object({ approvalWorkflowId: nullableUuid });

export const bulkSchema = z.object({
  ids: z.array(uuid).min(1).max(200),
  action: z.enum(['assign', 'status', 'priority']),
  payload: z.object({ teamId: nullableUuid, assigneeId: nullableUuid, statusId: uuid.optional(), priorityId: uuid.optional(), comment: z.string().max(2000).nullable().optional() }).default({}),
});

export const listQuerySchema = paginationSchema.merge(sortSchema).extend({
  q: z.string().max(200).optional(),
  type: z.enum(TICKET_TYPES).optional(),
  customerId: uuid.optional(),
  siteId: uuid.optional(),
  serviceId: uuid.optional(),
  statusId: z.string().optional(),
  statusCategory: z.string().optional(),
  priorityId: z.string().optional(),
  assigneeId: uuid.optional(),
  teamId: uuid.optional(),
  categoryId: uuid.optional(),
  domain: z.string().max(40).optional(),
  scopeStatus: z.enum(SCOPE_STATUSES).optional(),
  slaState: z.enum(['breached', 'at_risk', 'ok']).optional(),
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
  unassigned: boolQ,
  mine: boolQ,
  watching: boolQ,
  isMajor: boolQ,
  open: boolQ,
  tags: z.string().optional(),
  primaryCiId: uuid.optional(),
  assetId: uuid.optional(),
  catalogItemId: uuid.optional(),
  securitySeverityId: uuid.optional(),
  requesterUserId: uuid.optional(),
  parentTicketId: uuid.optional(),
  fields: z.enum(['min', 'full']).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

/** Stats accept every list filter (the paging/sort/projection fields are meaningless for aggregates). */
export const statsQuerySchema = listQuerySchema.omit({ page: true, pageSize: true, sort: true, order: true, fields: true });
/** The list filters alone (every key optional): what `buildWhere`/`ticketStats` consume; callers may pass a subset. */
export type StatsQuery = Partial<z.infer<typeof statsQuerySchema>>;

export const savedViewSchema = z.object({
  name: z.string().trim().min(1).max(100),
  entity: z.string().max(40).default('ticket'),
  filters: jsonRecord.default({}),
  columns: z.array(z.string()).default([]),
  sort: z.string().max(60).nullable().optional(),
  isShared: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});
export type SavedViewInput = z.infer<typeof savedViewSchema>;
