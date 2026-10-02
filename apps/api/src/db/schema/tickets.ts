import { pgTable, text, boolean, uuid, jsonb, index, uniqueIndex, integer, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { id, timestamps, ticketTypeEnum, scopeStatusEnum, tsvector, searchExpr } from './_common';
import { customers, sites, contacts } from './customers';
import { configOptions, approvalWorkflows } from './config';
import { services } from './services';
import { contracts } from './contracts';
import { teams, users } from './iam';
import { slaPolicies } from './sla';

/** Service request catalog: request types with their own forms, approvals and SLAs. */
export const catalogItems = pgTable('catalog_items', {
  id: id(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  categoryId: uuid('category_id').references(() => configOptions.id, { onDelete: 'set null' }),
  icon: text('icon'),
  /** [{ key, label, type: text|textarea|number|select|date|boolean|email, required, options, helpText }] */
  formSchema: jsonb('form_schema').$type<Record<string, unknown>[]>().notNull().default([]),
  slaPolicyId: uuid('sla_policy_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  approvalWorkflowId: uuid('approval_workflow_id').references(() => approvalWorkflows.id, { onDelete: 'set null' }),
  ticketCategoryId: uuid('ticket_category_id').references(() => configOptions.id, { onDelete: 'set null' }),
  defaultPriorityId: uuid('default_priority_id').references(() => configOptions.id, { onDelete: 'set null' }),
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
  fulfilmentInstructions: text('fulfilment_instructions'),
  /** Empty = available to all customers. */
  customerIds: uuid('customer_ids').array().notNull().default([]),
  portalVisible: boolean('portal_visible').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
});

/** Unified ticket record for incidents, service requests, problems and changes. */
export const tickets = pgTable('tickets', {
  id: id(),
  number: text('number').notNull(),
  type: ticketTypeEnum('type').notNull(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
  siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
  contractId: uuid('contract_id').references(() => contracts.id, { onDelete: 'set null' }),
  serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'),
  categoryId: uuid('category_id').references(() => configOptions.id, { onDelete: 'set null' }),
  subcategoryId: uuid('subcategory_id').references(() => configOptions.id, { onDelete: 'set null' }),
  priorityId: uuid('priority_id').references(() => configOptions.id, { onDelete: 'set null' }),
  impactId: uuid('impact_id').references(() => configOptions.id, { onDelete: 'set null' }),
  urgencyId: uuid('urgency_id').references(() => configOptions.id, { onDelete: 'set null' }),
  statusId: uuid('status_id').notNull().references(() => configOptions.id, { onDelete: 'restrict' }),
  sourceId: uuid('source_id').references(() => configOptions.id, { onDelete: 'set null' }),
  domain: text('domain').notNull().default('general'),
  assignedTeamId: uuid('assigned_team_id').references(() => teams.id, { onDelete: 'set null' }),
  assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
  requesterUserId: uuid('requester_user_id').references(() => users.id, { onDelete: 'set null' }),
  requesterContactId: uuid('requester_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  primaryCiId: uuid('primary_ci_id'),
  primaryAssetId: uuid('primary_asset_id'),
  scopeStatus: scopeStatusEnum('scope_status').notNull().default('unknown'),
  scopeContractId: uuid('scope_contract_id'),
  scopeItemId: uuid('scope_item_id'),
  scopeNote: text('scope_note'),
  scopeClassifiedBy: uuid('scope_classified_by'),
  scopeClassifiedAt: timestamp('scope_classified_at', { withTimezone: true }),
  slaPolicyId: uuid('sla_policy_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
  catalogItemId: uuid('catalog_item_id').references(() => catalogItems.id, { onDelete: 'set null' }),
  formData: jsonb('form_data').$type<Record<string, unknown>>().notNull().default({}),
  parentTicketId: uuid('parent_ticket_id'),
  securitySeverityId: uuid('security_severity_id').references(() => configOptions.id, { onDelete: 'set null' }),
  resolutionCodeId: uuid('resolution_code_id').references(() => configOptions.id, { onDelete: 'set null' }),
  closureCodeId: uuid('closure_code_id').references(() => configOptions.id, { onDelete: 'set null' }),
  resolutionNotes: text('resolution_notes'),
  approvalStatus: text('approval_status'),
  firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  restoredAt: timestamp('restored_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  reopenCount: integer('reopen_count').notNull().default(0),
  escalationLevel: integer('escalation_level').notNull().default(0),
  isMajor: boolean('is_major').notNull().default(false),
  integrationEventId: uuid('integration_event_id'),
  externalRef: text('external_ref'),
  tags: text('tags').array().notNull().default([]),
  customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow().notNull(),
  searchVector: tsvector('search_vector').generatedAlwaysAs(searchExpr('number', 'title', 'description', 'external_ref')),
  ...timestamps,
}, (t) => [
  uniqueIndex('tickets_number_idx').on(t.number),
  index('tickets_customer_created_idx').on(t.customerId, t.createdAt),
  index('tickets_status_idx').on(t.statusId),
  index('tickets_assignee_idx').on(t.assigneeId),
  index('tickets_team_idx').on(t.assignedTeamId),
  index('tickets_type_created_idx').on(t.type, t.createdAt),
  index('tickets_service_idx').on(t.serviceId),
  index('tickets_primary_ci_idx').on(t.primaryCiId),
  index('tickets_search_idx').using('gin', t.searchVector),
  index('tickets_last_activity_idx').on(t.lastActivityAt),
]);

export const ticketComments = pgTable('ticket_comments', {
  id: id(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  authorName: text('author_name'),
  /** comment (customer-visible) | work_note (internal) | resolution | system */
  kind: text('kind').notNull().default('comment'),
  isInternal: boolean('is_internal').notNull().default(false),
  body: text('body').notNull(),
  source: text('source').notNull().default('ui'),
  minutesSpent: integer('minutes_spent'),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('ticket_comments_ticket_idx').on(t.ticketId, t.createdAt)]);

/** Timeline of what happened to a ticket (status, assignment, SLA, links...). */
export const ticketActivities = pgTable('ticket_activities', {
  id: id(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  actorId: uuid('actor_id'),
  actorName: text('actor_name'),
  activityType: text('activity_type').notNull(),
  summary: text('summary').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  customerVisible: boolean('customer_visible').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('ticket_activities_ticket_idx').on(t.ticketId, t.createdAt)]);

export const ticketLinks = pgTable('ticket_links', {
  id: id(),
  sourceTicketId: uuid('source_ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  targetTicketId: uuid('target_ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  linkType: text('link_type').notNull().default('related'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('ticket_links_unique_idx').on(t.sourceTicketId, t.targetTicketId, t.linkType),
  index('ticket_links_target_idx').on(t.targetTicketId),
]);

export const ticketCis = pgTable('ticket_cis', {
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  ciId: uuid('ci_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  role: text('role').notNull().default('affected'),
}, (t) => [primaryKey({ columns: [t.ticketId, t.ciId] }), index('ticket_cis_ci_idx').on(t.ciId)]);

export const ticketAssets = pgTable('ticket_assets', {
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  assetId: uuid('asset_id').notNull(),
  customerId: uuid('customer_id').notNull(),
}, (t) => [primaryKey({ columns: [t.ticketId, t.assetId] }), index('ticket_assets_asset_idx').on(t.assetId)]);

export const ticketTasks = pgTable('ticket_tasks', {
  id: id(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('open'),
  assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
}, (t) => [index('ticket_tasks_ticket_idx').on(t.ticketId)]);

export const timeEntries = pgTable('time_entries', {
  id: id(),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  fieldVisitId: uuid('field_visit_id'),
  customerId: uuid('customer_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  minutes: integer('minutes').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  description: text('description'),
  workType: text('work_type').notNull().default('remote'),
  billable: boolean('billable').notNull().default(false),
  entitlementId: uuid('entitlement_id'),
  consumptionId: uuid('consumption_id'),
  ...timestamps,
}, (t) => [index('time_entries_ticket_idx').on(t.ticketId), index('time_entries_user_idx').on(t.userId), index('time_entries_customer_idx').on(t.customerId)]);

export const approvals = pgTable('approvals', {
  id: id(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  step: integer('step').notNull().default(1),
  stepName: text('step_name'),
  approverUserId: uuid('approver_user_id').references(() => users.id, { onDelete: 'set null' }),
  approverRoleKey: text('approver_role_key'),
  approverTeamId: uuid('approver_team_id'),
  status: text('status').notNull().default('pending'),
  decidedBy: uuid('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index('approvals_ticket_idx').on(t.ticketId), index('approvals_approver_idx').on(t.approverUserId, t.status)]);

export const problemDetails = pgTable('problem_details', {
  ticketId: uuid('ticket_id').primaryKey().references(() => tickets.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  symptoms: text('symptoms'),
  investigation: text('investigation'),
  rootCause: text('root_cause'),
  workaround: text('workaround'),
  isKnownError: boolean('is_known_error').notNull().default(false),
  permanentFix: text('permanent_fix'),
  kbArticleId: uuid('kb_article_id'),
  impactSummary: text('impact_summary'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const changeDetails = pgTable('change_details', {
  ticketId: uuid('ticket_id').primaryKey().references(() => tickets.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  changeType: text('change_type').notNull().default('normal'),
  riskId: uuid('risk_id').references(() => configOptions.id, { onDelete: 'set null' }),
  riskAssessment: text('risk_assessment'),
  impactAssessment: text('impact_assessment'),
  justification: text('justification'),
  implementationPlan: text('implementation_plan'),
  testPlan: text('test_plan'),
  backoutPlan: text('backout_plan'),
  communicationPlan: text('communication_plan'),
  scheduledStart: timestamp('scheduled_start', { withTimezone: true }),
  scheduledEnd: timestamp('scheduled_end', { withTimezone: true }),
  actualStart: timestamp('actual_start', { withTimezone: true }),
  actualEnd: timestamp('actual_end', { withTimezone: true }),
  downtimeExpectedMinutes: integer('downtime_expected_minutes'),
  cabNotes: text('cab_notes'),
  implementationNotes: text('implementation_notes'),
  pirNotes: text('pir_notes'),
  pirOutcome: text('pir_outcome'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const ticketWatchers = pgTable('ticket_watchers', {
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
}, (t) => [primaryKey({ columns: [t.ticketId, t.userId] })]);

export const savedViews = pgTable('saved_views', {
  id: id(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  entity: text('entity').notNull().default('ticket'),
  filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default({}),
  columns: text('columns').array().notNull().default([]),
  sort: text('sort'),
  isShared: boolean('is_shared').notNull().default(false),
  isDefault: boolean('is_default').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
}, (t) => [index('saved_views_user_idx').on(t.userId)]);
