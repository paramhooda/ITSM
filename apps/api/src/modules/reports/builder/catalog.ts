import { sql, type SQL } from 'drizzle-orm';
import { CHANGE_TYPES, FIELD_VISIT_STATUSES, ASSET_LIFECYCLE, ENTITLEMENT_UNITS, ENTITLEMENT_PERIODS, CI_STATUSES, INSTALL_SOURCES, SURVEY_CHANNELS, TICKET_TYPES, type Permission } from '@itsm/shared';
import type { Ctx } from '@/core/context';
import { isCustomerUser } from '../registry';
import { socCond, OPEN_STATUS, EMPTY } from '../definitions/helpers';
import { CI_ENVIRONMENTS, CI_CRITICALITIES } from '@/modules/cmdb/schemas';
import { CONTRACT_STATUSES } from '@/modules/contracts/schemas';
import { worstSlaStateSql } from '@/modules/sla/predicates';

/**
 * The field catalogue of the report builder: every entity a custom report can be
 * built on, with every field as a fixed SQL expression over fixed aliases. A
 * saved specification only ever names keys of this catalogue; the compiler turns
 * them into parameterised SQL. Nothing from a user ever reaches the SQL text.
 */

export type FieldType = 'text' | 'number' | 'minutes' | 'pct' | 'date' | 'datetime' | 'boolean' | 'option' | 'enum' | 'ref';
export type LookupKind = 'customer' | 'site' | 'service' | 'team' | 'user' | 'ciType';

export interface FieldOptions {
  /** Config option type the web resolves into choices (option fields). */
  optionType?: string;
  /** Directory the web resolves into choices (ref fields). */
  lookup?: LookupKind;
  /** Fixed choices (enum fields). */
  values?: { value: string; label: string }[];
}

export interface FieldDef {
  key: string;
  label: string;
  group: string;
  type: FieldType;
  /** Expression over the entity's aliases; never built from user input. */
  select: SQL;
  /** Join keys from EntityDef.joins this expression needs, in join order. */
  joins?: string[];
  /** Offered to customer users and allowed in portal-visible reports. */
  portal: boolean;
  groupable?: boolean;
  aggregatable?: boolean;
  options?: FieldOptions;
  /** For option/ref fields: the id column the IN filter applies to (the select shows the label). */
  filterOn?: SQL;
  /** For text fields backed by an array: the array column the contains filter searches element by element. */
  arrayCol?: SQL;
}

export const ENTITY_KEYS = ['tickets', 'changes', 'problems', 'sla_clocks', 'time_entries', 'visits', 'assets', 'cis', 'contracts', 'entitlements', 'surveys', 'software'] as const;
export type EntityKey = (typeof ENTITY_KEYS)[number];

export interface EntityDef {
  key: EntityKey;
  label: string;
  description: string;
  /** `tickets t` */
  from: SQL;
  /** join key → LEFT JOIN fragment, in the order they may be emitted. */
  joins: Record<string, SQL>;
  /** `t.customer_id` */
  customerCol: SQL;
  /** Beyond reports:run (saving also requires reports:build). */
  permissions: Permission[];
  /** May appear in portal-visible reports. */
  portal: boolean;
  /** Keys of fields usable as the period field. */
  dateFields: string[];
  defaultDateField: string | null;
  defaultColumns: string[];
  /** Fixed conditions (`AND …`) every query carries, such as the SOC fence. */
  baseWhere?: (ctx: Ctx) => SQL;
  fields: Record<string, FieldDef>;
}

export const OPERATORS: Record<FieldType, string[]> = {
  text: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'is_empty', 'is_not_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
  minutes: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
  pct: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
  date: ['on', 'before', 'after', 'between', 'last_n_days', 'next_n_days', 'is_empty', 'is_not_empty'],
  datetime: ['on', 'before', 'after', 'between', 'last_n_days', 'next_n_days', 'is_empty', 'is_not_empty'],
  boolean: ['is_true', 'is_false'],
  option: ['in', 'not_in', 'is_empty', 'is_not_empty'],
  enum: ['in', 'not_in', 'is_empty', 'is_not_empty'],
  ref: ['in', 'not_in', 'is_empty', 'is_not_empty'],
};

export const OPERATOR_LABELS: Record<string, string> = {
  eq: 'is', neq: 'is not', contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with', is_empty: 'is empty', is_not_empty: 'is not empty',
  gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most', between: 'is between',
  on: 'is on', before: 'is before', after: 'is after', last_n_days: 'is in the last N days', next_n_days: 'is in the next N days',
  is_true: 'is yes', is_false: 'is no', in: 'is any of', not_in: 'is none of',
};

// ---------------------------------------------------------------- field helpers

const title = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const values = (list: readonly string[]) => list.map((v) => ({ value: v, label: title(v) }));

type Flags = { portal?: boolean; groupable?: boolean; aggregatable?: boolean; joins?: string[]; options?: FieldOptions; filterOn?: SQL; arrayCol?: SQL };
/** A field definition: portal-safe unless `portal: false` is given. */
const f = (key: string, label: string, group: string, type: FieldType, select: SQL, flags: Flags = {}): FieldDef => ({ key, label, group, type, select, portal: flags.portal ?? true, ...(flags.joins ? { joins: flags.joins } : {}), ...(flags.groupable ? { groupable: true } : {}), ...(flags.aggregatable ? { aggregatable: true } : {}), ...(flags.options ? { options: flags.options } : {}), ...(flags.filterOn ? { filterOn: flags.filterOn } : {}), ...(flags.arrayCol ? { arrayCol: flags.arrayCol } : {}) });
const option = (key: string, label: string, group: string, select: SQL, optionType: string, filterOn: SQL, joins: string[], portal = true): FieldDef => f(key, label, group, 'option', select, { portal, groupable: true, joins, options: { optionType }, filterOn });
const ref = (key: string, label: string, group: string, select: SQL, lookup: LookupKind, filterOn: SQL, joins: string[], portal = true): FieldDef => f(key, label, group, 'ref', select, { portal, groupable: true, joins, options: { lookup }, filterOn });
const enumField = (key: string, label: string, group: string, select: SQL, list: readonly string[], portal = true, joins?: string[]): FieldDef => f(key, label, group, 'enum', select, { portal, groupable: true, joins, options: { values: values(list) } });
const map = (list: FieldDef[]): Record<string, FieldDef> => Object.fromEntries(list.map((x) => [x.key, x]));

const G = { identity: 'Identity', classification: 'Classification', people: 'People', dates: 'Dates', sla: 'Service levels', measures: 'Measures', change: 'Change', problem: 'Problem', coverage: 'Coverage', purchase: 'Purchase', technical: 'Technical', survey: 'Survey', software: 'Software', host: 'Host' };

/** Age, resolution and response durations of a ticket row aliased `t`. */
const minutesBetween = (a: SQL, b: SQL) => sql`round((extract(epoch from (${a} - ${b})) / 60)::numeric)`;
const WORST_SLA = worstSlaStateSql(sql`t.id`, sql`x`);

const TICKET_JOINS: Record<string, SQL> = {
  pr: sql`LEFT JOIN config_options pr ON pr.id = t.priority_id`,
  st: sql`LEFT JOIN config_options st ON st.id = t.status_id`,
  cat: sql`LEFT JOIN config_options cat ON cat.id = t.category_id`,
  sub: sql`LEFT JOIN config_options sub ON sub.id = t.subcategory_id`,
  cu: sql`LEFT JOIN customers cu ON cu.id = t.customer_id`,
  si: sql`LEFT JOIN sites si ON si.id = t.site_id`,
  sv: sql`LEFT JOIN services sv ON sv.id = t.service_id`,
  asg: sql`LEFT JOIN users asg ON asg.id = t.assignee_id`,
  tm: sql`LEFT JOIN teams tm ON tm.id = t.assigned_team_id`,
  req: sql`LEFT JOIN users req ON req.id = t.requester_user_id`,
  rc: sql`LEFT JOIN contacts rc ON rc.id = t.requester_contact_id`,
  src: sql`LEFT JOIN config_options src ON src.id = t.source_id`,
  rcode: sql`LEFT JOIN config_options rcode ON rcode.id = t.resolution_code_id`,
};

/** The fields every ticket-based entity shares (tickets, changes, problems); `omit` drops the ones that do not apply. */
function ticketFields(omit: string[] = []): FieldDef[] {
  const all: FieldDef[] = [
    f('number', 'Number', G.identity, 'text', sql`t.number`),
    enumField('type', 'Type', G.identity, sql`t.type::text`, TICKET_TYPES),
    f('title', 'Title', G.identity, 'text', sql`t.title`),
    f('description', 'Description', G.identity, 'text', sql`left(t.description, 500)`),
    f('tags', 'Tags', G.identity, 'text', sql`array_to_string(t.tags, ', ')`, { arrayCol: sql`t.tags` }),
    ref('customer', 'Customer', G.classification, sql`cu.name`, 'customer', sql`t.customer_id`, ['cu']),
    f('customer_code', 'Customer code', G.classification, 'text', sql`cu.code`, { groupable: true, joins: ['cu'] }),
    ref('site', 'Site', G.classification, sql`si.name`, 'site', sql`t.site_id`, ['si']),
    ref('service', 'Service', G.classification, sql`sv.name`, 'service', sql`t.service_id`, ['sv']),
    option('category', 'Category', G.classification, sql`cat.label`, 'ticket_category', sql`t.category_id`, ['cat']),
    option('subcategory', 'Subcategory', G.classification, sql`sub.label`, 'ticket_subcategory', sql`t.subcategory_id`, ['sub']),
    option('priority', 'Priority', G.classification, sql`pr.label`, 'ticket_priority', sql`t.priority_id`, ['pr']),
    f('priority_level', 'Priority level', G.classification, 'number', sql`pr.level`, { aggregatable: true, joins: ['pr'] }),
    option('status', 'Status', G.classification, sql`st.label`, 'ticket_status', sql`t.status_id`, ['st']),
    enumField('status_category', 'Status category', G.classification, sql`st.status_category::text`, ['new', 'open', 'pending', 'resolved', 'closed', 'cancelled'], true, ['st']),
    option('source', 'Source', G.classification, sql`src.label`, 'ticket_source', sql`t.source_id`, ['src']),
    enumField('domain', 'Domain', G.classification, sql`t.domain`, ['general', 'noc', 'soc', 'amc', 'service_desk']),
    f('is_major', 'Major incident', G.classification, 'boolean', sql`t.is_major`, { groupable: true }),
    enumField('scope_status', 'Scope', G.classification, sql`t.scope_status::text`, ['in_scope', 'out_of_scope', 'unknown']),
    f('scope_note', 'Scope note', G.classification, 'text', sql`t.scope_note`, { portal: false }),
    option('resolution_code', 'Resolution code', G.classification, sql`rcode.label`, 'resolution_code', sql`t.resolution_code_id`, ['rcode']),
    f('approval_status', 'Approval status', G.classification, 'text', sql`t.approval_status`, { groupable: true }),
    ref('assignee', 'Assignee', G.people, sql`asg.name`, 'user', sql`t.assignee_id`, ['asg']),
    ref('team', 'Team', G.people, sql`tm.name`, 'team', sql`t.assigned_team_id`, ['tm']),
    f('requester', 'Requester', G.people, 'text', sql`coalesce(req.name, rc.name)`, { joins: ['req', 'rc'] }),
    f('created_at', 'Created', G.dates, 'datetime', sql`t.created_at`),
    f('first_response_at', 'First response', G.dates, 'datetime', sql`t.first_response_at`),
    f('acknowledged_at', 'Acknowledged', G.dates, 'datetime', sql`t.acknowledged_at`),
    f('restored_at', 'Restored', G.dates, 'datetime', sql`t.restored_at`),
    f('resolved_at', 'Resolved', G.dates, 'datetime', sql`t.resolved_at`),
    f('closed_at', 'Closed', G.dates, 'datetime', sql`t.closed_at`),
    f('due_at', 'Due', G.dates, 'datetime', sql`t.due_at`),
    f('age_hours', 'Age (h)', G.sla, 'number', sql`round((extract(epoch from (coalesce(t.resolved_at, now()) - t.created_at)) / 3600)::numeric, 1)`, { aggregatable: true }),
    f('resolution_minutes', 'Resolution time', G.sla, 'minutes', minutesBetween(sql`t.resolved_at`, sql`t.created_at`), { aggregatable: true }),
    f('first_response_minutes', 'First response time', G.sla, 'minutes', minutesBetween(sql`t.first_response_at`, sql`t.created_at`), { aggregatable: true }),
    f('reopen_count', 'Reopened', G.sla, 'number', sql`t.reopen_count`, { aggregatable: true }),
    f('escalation_level', 'Escalation level', G.sla, 'number', sql`t.escalation_level`, { aggregatable: true }),
    enumField('sla_state', 'SLA state', G.sla, WORST_SLA, ['breached', 'at_risk', 'ok']),
    enumField('breach_risk', 'Breach risk', G.sla, sql`t.breach_risk`, ['low', 'medium', 'high'], false),
    enumField('last_sentiment', 'Last sentiment', G.sla, sql`t.last_sentiment`, ['positive', 'neutral', 'negative', 'angry'], false),
  ];
  return all.filter((x) => !omit.includes(x.key));
}

const TICKET_DATES = ['created_at', 'resolved_at', 'closed_at', 'due_at', 'first_response_at'];

// ---------------------------------------------------------------- entities

const tickets: EntityDef = {
  key: 'tickets',
  label: 'Tickets',
  description: 'Incidents, requests, problems and changes with their classification, people, dates and service-level figures.',
  from: sql`tickets t`,
  joins: TICKET_JOINS,
  customerCol: sql`t.customer_id`,
  permissions: [],
  portal: true,
  dateFields: TICKET_DATES,
  defaultDateField: 'created_at',
  defaultColumns: ['number', 'type', 'title', 'customer', 'priority', 'status', 'assignee', 'created_at'],
  baseWhere: (ctx) => socCond(ctx),
  fields: map(ticketFields()),
};

const changes: EntityDef = {
  key: 'changes',
  label: 'Changes',
  description: 'Change tickets with their type, risk, windows and review outcome.',
  from: sql`tickets t JOIN change_details cd ON cd.ticket_id = t.id`,
  joins: { ...TICKET_JOINS, rk: sql`LEFT JOIN config_options rk ON rk.id = cd.risk_id` },
  customerCol: sql`t.customer_id`,
  permissions: [],
  portal: true,
  dateFields: ['scheduled_start', 'scheduled_end', 'actual_start', 'created_at', 'closed_at'],
  defaultDateField: 'scheduled_start',
  defaultColumns: ['number', 'title', 'customer', 'change_type', 'risk_level', 'status', 'scheduled_start', 'scheduled_end', 'assignee'],
  baseWhere: (ctx) => sql`AND t.type = 'change' ${socCond(ctx)}`,
  fields: map([
    ...ticketFields(['type', 'domain', 'sla_state']),
    enumField('change_type', 'Change type', G.change, sql`cd.change_type`, CHANGE_TYPES),
    option('risk', 'Risk', G.change, sql`rk.label`, 'change_risk', sql`cd.risk_id`, ['rk']),
    enumField('risk_level', 'Risk level', G.change, sql`cd.risk_level`, ['low', 'medium', 'high']),
    f('risk_score', 'Risk score', G.change, 'number', sql`cd.risk_score`, { aggregatable: true }),
    f('scheduled_start', 'Scheduled start', G.change, 'datetime', sql`cd.scheduled_start`),
    f('scheduled_end', 'Scheduled end', G.change, 'datetime', sql`cd.scheduled_end`),
    f('actual_start', 'Actual start', G.change, 'datetime', sql`cd.actual_start`),
    f('actual_end', 'Actual end', G.change, 'datetime', sql`cd.actual_end`),
    f('window_minutes', 'Window length', G.change, 'minutes', sql`round((extract(epoch from (coalesce(cd.scheduled_end, cd.scheduled_start + interval '1 hour') - cd.scheduled_start)) / 60)::numeric)`, { aggregatable: true }),
    f('downtime_expected_minutes', 'Expected downtime', G.change, 'minutes', sql`cd.downtime_expected_minutes`, { aggregatable: true }),
    f('pir_outcome', 'Review outcome', G.change, 'text', sql`cd.pir_outcome`, { portal: false, groupable: true }),
    f('cab_notes', 'CAB notes', G.change, 'text', sql`left(cd.cab_notes, 500)`, { portal: false }),
    f('reviewed_at', 'Reviewed', G.change, 'datetime', sql`cd.reviewed_at`, { portal: false }),
  ]),
};

const problems: EntityDef = {
  key: 'problems',
  label: 'Problems',
  description: 'Problem records with root cause, workaround, known-error state and the incidents linked to them. Staff only.',
  from: sql`tickets t JOIN problem_details pd ON pd.ticket_id = t.id`,
  joins: TICKET_JOINS,
  customerCol: sql`t.customer_id`,
  permissions: [],
  portal: false,
  dateFields: ['created_at', 'resolved_at', 'closed_at'],
  defaultDateField: 'created_at',
  defaultColumns: ['number', 'title', 'customer', 'priority', 'status', 'is_known_error', 'ke_status', 'incident_count', 'assignee', 'created_at'],
  baseWhere: (ctx) => sql`AND t.type = 'problem' ${socCond(ctx)}`,
  fields: map([
    ...ticketFields(['type', 'domain', 'sla_state']),
    f('is_known_error', 'Known error', G.problem, 'boolean', sql`pd.is_known_error`, { groupable: true }),
    f('ke_status', 'Known error status', G.problem, 'text', sql`pd.ke_status`, { portal: false, groupable: true }),
    f('ke_published', 'Published to portal', G.problem, 'boolean', sql`pd.portal_visible`, { portal: false, groupable: true }),
    f('symptoms', 'Symptoms', G.problem, 'text', sql`left(pd.symptoms, 500)`),
    f('root_cause', 'Root cause', G.problem, 'text', sql`left(pd.root_cause, 500)`),
    f('workaround', 'Workaround', G.problem, 'text', sql`left(pd.workaround, 500)`),
    f('permanent_fix', 'Permanent fix', G.problem, 'text', sql`left(pd.permanent_fix, 500)`),
    f('incident_count', 'Linked incidents', G.problem, 'number', sql`(SELECT count(*)::int FROM ticket_links l WHERE (l.target_ticket_id = t.id OR l.source_ticket_id = t.id) AND l.link_type IN ('problem_of', 'caused_by', 'related'))`, { aggregatable: true }),
    f('kb_article', 'Article', G.problem, 'text', sql`(SELECT a.number FROM kb_articles a WHERE a.id = pd.kb_article_id)`),
  ]),
};

const SLA_ELAPSED = sql`coalesce(s.elapsed_minutes_at_completion, round((extract(epoch from (now() - s.started_at)) / 60)::numeric)::int - s.paused_minutes)`;
const slaClocks: EntityDef = {
  key: 'sla_clocks',
  label: 'SLA clocks',
  description: 'One row per ticket and metric (acknowledgement, response, restoration, resolution): target, elapsed, state and the policy that applied.',
  from: sql`ticket_slas s JOIN tickets t ON t.id = s.ticket_id`,
  joins: { pr: TICKET_JOINS.pr!, st: TICKET_JOINS.st!, cu: TICKET_JOINS.cu!, sv: TICKET_JOINS.sv!, asg: TICKET_JOINS.asg!, tm: TICKET_JOINS.tm!, pol: sql`LEFT JOIN sla_policies pol ON pol.id = s.policy_id` },
  customerCol: sql`s.customer_id`,
  permissions: [],
  portal: true,
  dateFields: ['started_at', 'due_at', 'completed_at', 'breached_at'],
  defaultDateField: 'started_at',
  defaultColumns: ['ticket_number', 'customer', 'priority', 'metric', 'state', 'target_minutes', 'elapsed_minutes', 'pct_used', 'due_at'],
  baseWhere: (ctx) => socCond(ctx),
  fields: map([
    f('ticket_number', 'Ticket', G.identity, 'text', sql`t.number`),
    f('ticket_title', 'Title', G.identity, 'text', sql`t.title`),
    enumField('ticket_type', 'Ticket type', G.identity, sql`t.type::text`, TICKET_TYPES),
    ref('customer', 'Customer', G.classification, sql`cu.name`, 'customer', sql`t.customer_id`, ['cu']),
    ref('service', 'Service', G.classification, sql`sv.name`, 'service', sql`t.service_id`, ['sv']),
    option('priority', 'Priority', G.classification, sql`pr.label`, 'ticket_priority', sql`t.priority_id`, ['pr']),
    option('status', 'Ticket status', G.classification, sql`st.label`, 'ticket_status', sql`t.status_id`, ['st']),
    ref('assignee', 'Assignee', G.people, sql`asg.name`, 'user', sql`t.assignee_id`, ['asg']),
    ref('team', 'Team', G.people, sql`tm.name`, 'team', sql`t.assigned_team_id`, ['tm']),
    enumField('metric', 'Metric', G.sla, sql`s.metric::text`, ['acknowledgement', 'response', 'restoration', 'resolution']),
    enumField('state', 'State', G.sla, sql`s.state::text`, ['running', 'paused', 'met', 'breached', 'cancelled']),
    f('policy', 'Policy', G.sla, 'text', sql`pol.name`, { groupable: true, joins: ['pol'] }),
    f('calendar_time', 'Calendar time', G.sla, 'boolean', sql`s.calendar_time`, { groupable: true }),
    f('target_minutes', 'Target', G.measures, 'minutes', sql`s.target_minutes`, { aggregatable: true }),
    f('paused_minutes', 'Paused', G.measures, 'minutes', sql`s.paused_minutes`, { aggregatable: true }),
    f('elapsed_minutes', 'Elapsed', G.measures, 'minutes', SLA_ELAPSED, { aggregatable: true }),
    f('pct_used', 'Used (%)', G.measures, 'pct', sql`round((100.0 * ${SLA_ELAPSED} / nullif(s.target_minutes, 0))::numeric, 1)`, { aggregatable: true }),
    f('started_at', 'Started', G.dates, 'datetime', sql`s.started_at`),
    f('due_at', 'Due', G.dates, 'datetime', sql`s.due_at`),
    f('completed_at', 'Completed', G.dates, 'datetime', sql`s.completed_at`),
    f('breached_at', 'Breached', G.dates, 'datetime', sql`s.breached_at`),
    f('warned_at', 'Warned', G.dates, 'datetime', sql`s.warned_at`),
  ]),
};

const timeEntries: EntityDef = {
  key: 'time_entries',
  label: 'Time entries',
  description: 'Time recorded against tickets and visits: who, how long, what kind of work and whether it is billable. Staff only.',
  from: sql`time_entries te LEFT JOIN tickets t ON t.id = te.ticket_id`,
  joins: {
    u: sql`LEFT JOIN users u ON u.id = te.user_id`,
    cu: sql`LEFT JOIN customers cu ON cu.id = te.customer_id`,
    sv: sql`LEFT JOIN services sv ON sv.id = t.service_id`,
    tm: sql`LEFT JOIN teams tm ON tm.id = t.assigned_team_id`,
    fv: sql`LEFT JOIN field_visits fv ON fv.id = te.field_visit_id`,
  },
  customerCol: sql`te.customer_id`,
  permissions: ['tickets:read'],
  portal: false,
  dateFields: ['started_at', 'created_at'],
  defaultDateField: 'started_at',
  defaultColumns: ['user', 'ticket_number', 'customer', 'work_type', 'minutes', 'billable', 'started_at'],
  // entries without a ticket have no domain: the plain SOC fence would drop them
  baseWhere: (ctx) => (!isCustomerUser(ctx) && !ctx.can('soc:read') ? sql`AND coalesce(t.domain, 'general') <> 'soc'` : EMPTY),
  fields: map([
    ref('user', 'Person', G.people, sql`u.name`, 'user', sql`te.user_id`, ['u'], false),
    f('ticket_number', 'Ticket', G.identity, 'text', sql`t.number`, { portal: false }),
    f('ticket_title', 'Ticket title', G.identity, 'text', sql`t.title`, { portal: false }),
    enumField('ticket_type', 'Ticket type', G.identity, sql`t.type::text`, TICKET_TYPES, false),
    f('visit_number', 'Visit', G.identity, 'text', sql`fv.number`, { portal: false, joins: ['fv'] }),
    ref('customer', 'Customer', G.classification, sql`cu.name`, 'customer', sql`te.customer_id`, ['cu'], false),
    ref('service', 'Service', G.classification, sql`sv.name`, 'service', sql`t.service_id`, ['sv'], false),
    ref('team', 'Team', G.people, sql`tm.name`, 'team', sql`t.assigned_team_id`, ['tm'], false),
    enumField('work_type', 'Work type', G.classification, sql`te.work_type`, ['remote', 'onsite', 'travel', 'other'], false),
    f('billable', 'Billable', G.classification, 'boolean', sql`te.billable`, { portal: false, groupable: true }),
    f('minutes', 'Minutes', G.measures, 'number', sql`te.minutes`, { portal: false, aggregatable: true }),
    f('hours', 'Hours', G.measures, 'number', sql`round(te.minutes / 60.0, 2)`, { portal: false, aggregatable: true }),
    f('description', 'Description', G.identity, 'text', sql`left(te.description, 500)`, { portal: false }),
    f('started_at', 'Started', G.dates, 'datetime', sql`te.started_at`, { portal: false }),
    f('created_at', 'Recorded', G.dates, 'datetime', sql`te.created_at`, { portal: false }),
  ]),
};

const visits: EntityDef = {
  key: 'visits',
  label: 'Field visits',
  description: 'Site visits with their engineer, schedule, actual times, acknowledgement and rating.',
  from: sql`field_visits v`,
  joins: {
    cu: sql`LEFT JOIN customers cu ON cu.id = v.customer_id`,
    si: sql`LEFT JOIN sites si ON si.id = v.site_id`,
    sv: sql`LEFT JOIN services sv ON sv.id = v.service_id`,
    ty: sql`LEFT JOIN config_options ty ON ty.id = v.type_id`,
    eng: sql`LEFT JOIN users eng ON eng.id = v.engineer_id`,
    tm: sql`LEFT JOIN teams tm ON tm.id = v.team_id`,
    t: sql`LEFT JOIN tickets t ON t.id = v.ticket_id`,
    c: sql`LEFT JOIN contracts c ON c.id = v.contract_id`,
  },
  customerCol: sql`v.customer_id`,
  permissions: ['field:read'],
  portal: true,
  dateFields: ['scheduled_start', 'actual_start', 'actual_end', 'customer_ack_at', 'created_at'],
  defaultDateField: 'scheduled_start',
  defaultColumns: ['number', 'title', 'customer', 'site', 'status', 'engineer', 'scheduled_start', 'actual_end', 'customer_rating'],
  fields: map([
    f('number', 'Number', G.identity, 'text', sql`v.number`),
    f('title', 'Title', G.identity, 'text', sql`v.title`),
    f('purpose', 'Purpose', G.identity, 'text', sql`left(v.purpose, 500)`),
    enumField('status', 'Status', G.classification, sql`v.status`, FIELD_VISIT_STATUSES),
    option('type', 'Visit type', G.classification, sql`ty.label`, 'field_visit_type', sql`v.type_id`, ['ty']),
    ref('customer', 'Customer', G.classification, sql`cu.name`, 'customer', sql`v.customer_id`, ['cu']),
    ref('site', 'Site', G.classification, sql`si.name`, 'site', sql`v.site_id`, ['si']),
    ref('service', 'Service', G.classification, sql`sv.name`, 'service', sql`v.service_id`, ['sv']),
    ref('engineer', 'Engineer', G.people, sql`eng.name`, 'user', sql`v.engineer_id`, ['eng']),
    ref('team', 'Team', G.people, sql`tm.name`, 'team', sql`v.team_id`, ['tm']),
    f('ticket_number', 'Ticket', G.identity, 'text', sql`t.number`, { joins: ['t'] }),
    f('contract_number', 'Contract', G.identity, 'text', sql`c.number`, { joins: ['c'] }),
    f('scheduled_start', 'Scheduled start', G.dates, 'datetime', sql`v.scheduled_start`),
    f('scheduled_end', 'Scheduled end', G.dates, 'datetime', sql`v.scheduled_end`),
    f('actual_start', 'Actual start', G.dates, 'datetime', sql`v.actual_start`),
    f('actual_end', 'Actual end', G.dates, 'datetime', sql`v.actual_end`),
    f('customer_ack_at', 'Acknowledged', G.dates, 'datetime', sql`v.customer_ack_at`),
    f('created_at', 'Created', G.dates, 'datetime', sql`v.created_at`),
    f('travel_minutes', 'Travel', G.measures, 'minutes', sql`v.travel_minutes`, { aggregatable: true }),
    f('work_minutes', 'Work', G.measures, 'minutes', sql`v.work_minutes`, { aggregatable: true }),
    f('duration_minutes', 'On site', G.measures, 'minutes', minutesBetween(sql`v.actual_end`, sql`v.actual_start`), { aggregatable: true }),
    f('customer_rating', 'Customer rating', G.measures, 'number', sql`v.customer_rating`, { aggregatable: true }),
    f('parts_count', 'Parts used', G.measures, 'number', sql`(SELECT count(*)::int FROM field_visit_parts p WHERE p.visit_id = v.id)`, { aggregatable: true }),
    f('customer_ack_name', 'Acknowledged by', G.people, 'text', sql`v.customer_ack_name`),
    f('billable', 'Billable', G.classification, 'boolean', sql`v.billable`, { portal: false, groupable: true }),
  ]),
};

const assets: EntityDef = {
  key: 'assets',
  label: 'Assets',
  description: 'The asset register: tags, models, locations, warranty and AMC coverage, lifecycle and purchase details.',
  from: sql`assets a`,
  joins: {
    cu: sql`LEFT JOIN customers cu ON cu.id = a.customer_id`,
    si: sql`LEFT JOIN sites si ON si.id = a.site_id`,
    cat: sql`LEFT JOIN config_options cat ON cat.id = a.category_id`,
    stt: sql`LEFT JOIN config_options stt ON stt.id = a.status_id`,
    c: sql`LEFT JOIN contracts c ON c.id = a.amc_contract_id`,
    ci: sql`LEFT JOIN cis ci ON ci.id = a.ci_id`,
  },
  customerCol: sql`a.customer_id`,
  permissions: ['assets:read'],
  portal: true,
  dateFields: ['purchase_date', 'warranty_end', 'amc_end', 'eol_date', 'eos_date', 'created_at'],
  defaultDateField: 'warranty_end',
  defaultColumns: ['tag', 'name', 'customer', 'site', 'category', 'status', 'lifecycle_stage', 'warranty_end', 'amc_end'],
  fields: map([
    f('tag', 'Tag', G.identity, 'text', sql`a.tag`),
    f('name', 'Name', G.identity, 'text', sql`a.name`),
    f('manufacturer', 'Manufacturer', G.identity, 'text', sql`a.manufacturer`, { groupable: true }),
    f('model', 'Model', G.identity, 'text', sql`a.model`, { groupable: true }),
    f('serial_number', 'Serial number', G.identity, 'text', sql`a.serial_number`),
    f('part_number', 'Part number', G.identity, 'text', sql`a.part_number`),
    f('location', 'Location', G.identity, 'text', sql`a.location`, { groupable: true }),
    f('rack_position', 'Rack position', G.identity, 'text', sql`a.rack_position`),
    f('tags', 'Tags', G.identity, 'text', sql`array_to_string(a.tags, ', ')`, { arrayCol: sql`a.tags` }),
    option('category', 'Category', G.classification, sql`cat.label`, 'asset_category', sql`a.category_id`, ['cat']),
    option('status', 'Status', G.classification, sql`stt.label`, 'asset_status', sql`a.status_id`, ['stt']),
    enumField('lifecycle_stage', 'Lifecycle stage', G.classification, sql`a.lifecycle_stage`, ASSET_LIFECYCLE),
    ref('customer', 'Customer', G.classification, sql`cu.name`, 'customer', sql`a.customer_id`, ['cu']),
    ref('site', 'Site', G.classification, sql`si.name`, 'site', sql`a.site_id`, ['si']),
    f('ci_name', 'Configuration item', G.classification, 'text', sql`ci.name`, { joins: ['ci'] }),
    f('has_ci', 'Linked to a CI', G.classification, 'boolean', sql`a.ci_id IS NOT NULL`, { groupable: true }),
    f('purchase_date', 'Purchased', G.purchase, 'date', sql`a.purchase_date`),
    f('purchase_cost', 'Purchase cost', G.purchase, 'number', sql`a.purchase_cost`, { portal: false, aggregatable: true }),
    f('currency', 'Currency', G.purchase, 'text', sql`a.currency`, { portal: false, groupable: true }),
    f('vendor', 'Vendor', G.purchase, 'text', sql`a.vendor`, { portal: false, groupable: true }),
    f('po_number', 'PO number', G.purchase, 'text', sql`a.po_number`, { portal: false }),
    f('invoice_number', 'Invoice number', G.purchase, 'text', sql`a.invoice_number`, { portal: false }),
    f('warranty_start', 'Warranty start', G.coverage, 'date', sql`a.warranty_start`),
    f('warranty_end', 'Warranty end', G.coverage, 'date', sql`a.warranty_end`),
    f('warranty_days_left', 'Warranty days left', G.coverage, 'number', sql`a.warranty_end - current_date`, { aggregatable: true }),
    f('amc_start', 'AMC start', G.coverage, 'date', sql`a.amc_start`),
    f('amc_end', 'AMC end', G.coverage, 'date', sql`a.amc_end`),
    f('amc_days_left', 'AMC days left', G.coverage, 'number', sql`coalesce(a.amc_end, c.end_date) - current_date`, { aggregatable: true, joins: ['c'] }),
    f('amc_contract', 'AMC contract', G.coverage, 'text', sql`c.number`, { joins: ['c'] }),
    f('eol_date', 'End of life', G.coverage, 'date', sql`a.eol_date`),
    f('eos_date', 'End of support', G.coverage, 'date', sql`a.eos_date`),
    f('notes', 'Notes', G.identity, 'text', sql`left(a.notes, 500)`, { portal: false }),
    f('created_at', 'Created', G.dates, 'datetime', sql`a.created_at`),
    f('updated_at', 'Updated', G.dates, 'datetime', sql`a.updated_at`),
  ]),
};

const cis: EntityDef = {
  key: 'cis',
  label: 'Configuration items',
  description: 'Configuration items with their type, environment, criticality, addresses, owner team, relationships and open tickets.',
  from: sql`cis ci`,
  joins: {
    ty: sql`LEFT JOIN ci_types ty ON ty.id = ci.type_id`,
    cu: sql`LEFT JOIN customers cu ON cu.id = ci.customer_id`,
    si: sql`LEFT JOIN sites si ON si.id = ci.site_id`,
    tm: sql`LEFT JOIN teams tm ON tm.id = ci.owner_team_id`,
    a: sql`LEFT JOIN assets a ON a.id = ci.asset_id`,
  },
  customerCol: sql`ci.customer_id`,
  permissions: ['cmdb:read'],
  portal: true,
  dateFields: ['last_seen_at', 'discovered_at', 'created_at', 'updated_at'],
  defaultDateField: 'updated_at',
  defaultColumns: ['name', 'type', 'customer', 'site', 'environment', 'criticality', 'status', 'ip_address', 'open_tickets'],
  fields: map([
    f('name', 'Name', G.identity, 'text', sql`ci.name`),
    f('hostname', 'Host name', G.identity, 'text', sql`ci.hostname`),
    f('fqdn', 'FQDN', G.identity, 'text', sql`ci.fqdn`),
    f('ip_address', 'IP address', G.technical, 'text', sql`ci.ip_address`),
    f('mac_address', 'MAC address', G.technical, 'text', sql`ci.mac_address`),
    f('serial_number', 'Serial number', G.technical, 'text', sql`ci.serial_number`),
    f('manufacturer', 'Manufacturer', G.technical, 'text', sql`ci.manufacturer`, { groupable: true }),
    f('model', 'Model', G.technical, 'text', sql`ci.model`, { groupable: true }),
    f('os_name', 'Operating system', G.technical, 'text', sql`ci.os_name`, { groupable: true }),
    f('os_version', 'OS version', G.technical, 'text', sql`ci.os_version`, { groupable: true }),
    f('firmware_version', 'Firmware', G.technical, 'text', sql`ci.firmware_version`),
    ref('type', 'Type', G.classification, sql`ty.name`, 'ciType', sql`ci.type_id`, ['ty']),
    enumField('environment', 'Environment', G.classification, sql`ci.environment`, CI_ENVIRONMENTS),
    enumField('criticality', 'Criticality', G.classification, sql`ci.criticality`, CI_CRITICALITIES),
    enumField('status', 'Status', G.classification, sql`ci.status`, CI_STATUSES),
    ref('customer', 'Customer', G.classification, sql`cu.name`, 'customer', sql`ci.customer_id`, ['cu']),
    ref('site', 'Site', G.classification, sql`si.name`, 'site', sql`ci.site_id`, ['si']),
    ref('owner_team', 'Owner team', G.people, sql`tm.name`, 'team', sql`ci.owner_team_id`, ['tm']),
    f('asset_tag', 'Asset tag', G.classification, 'text', sql`a.tag`, { joins: ['a'] }),
    f('tags', 'Tags', G.identity, 'text', sql`array_to_string(ci.tags, ', ')`, { arrayCol: sql`ci.tags` }),
    f('discovery_source', 'Discovery source', G.technical, 'text', sql`ci.discovery_source`, { portal: false, groupable: true }),
    f('monitoring_ref', 'Monitoring reference', G.technical, 'text', sql`ci.monitoring_ref`, { portal: false }),
    f('stale', 'Stale (not seen for 30 days)', G.technical, 'boolean', sql`ci.last_seen_at IS NOT NULL AND ci.last_seen_at < now() - interval '30 days'`, { portal: false, groupable: true }),
    f('relationship_count', 'Relationships', G.measures, 'number', sql`(SELECT count(*)::int FROM ci_relationships r WHERE r.source_ci_id = ci.id OR r.target_ci_id = ci.id)`, { aggregatable: true }),
    f('open_tickets', 'Open tickets', G.measures, 'number', sql`(SELECT count(*)::int FROM tickets x WHERE x.primary_ci_id = ci.id AND x.status_id IN ${OPEN_STATUS})`, { aggregatable: true }),
    f('last_seen_at', 'Last seen', G.dates, 'datetime', sql`ci.last_seen_at`, { portal: false }),
    f('discovered_at', 'Discovered', G.dates, 'datetime', sql`ci.discovered_at`, { portal: false }),
    f('created_at', 'Created', G.dates, 'datetime', sql`ci.created_at`),
    f('updated_at', 'Updated', G.dates, 'datetime', sql`ci.updated_at`),
  ]),
};

const contracts: EntityDef = {
  key: 'contracts',
  label: 'Contracts',
  description: 'Contracts with their type, status, dates, owner, service level policy and open tickets.',
  from: sql`contracts c`,
  joins: {
    cu: sql`LEFT JOIN customers cu ON cu.id = c.customer_id`,
    ty: sql`LEFT JOIN config_options ty ON ty.id = c.type_id`,
    own: sql`LEFT JOIN users own ON own.id = c.owner_user_id`,
    pol: sql`LEFT JOIN sla_policies pol ON pol.id = c.sla_policy_id`,
  },
  customerCol: sql`c.customer_id`,
  permissions: ['contracts:read'],
  portal: true,
  dateFields: ['start_date', 'end_date', 'renewal_date', 'signed_at', 'created_at'],
  defaultDateField: 'end_date',
  defaultColumns: ['number', 'name', 'customer', 'type', 'status', 'start_date', 'end_date', 'days_to_end', 'owner'],
  fields: map([
    f('number', 'Number', G.identity, 'text', sql`c.number`),
    f('name', 'Name', G.identity, 'text', sql`c.name`),
    f('description', 'Description', G.identity, 'text', sql`left(c.description, 500)`),
    option('type', 'Type', G.classification, sql`ty.label`, 'contract_type', sql`c.type_id`, ['ty']),
    enumField('status', 'Status', G.classification, sql`c.status`, CONTRACT_STATUSES),
    ref('customer', 'Customer', G.classification, sql`cu.name`, 'customer', sql`c.customer_id`, ['cu']),
    ref('owner', 'Owner', G.people, sql`own.name`, 'user', sql`c.owner_user_id`, ['own'], false),
    f('sla_policy', 'SLA policy', G.sla, 'text', sql`pol.name`, { groupable: true, joins: ['pol'] }),
    f('start_date', 'Start', G.dates, 'date', sql`c.start_date`),
    f('end_date', 'End', G.dates, 'date', sql`c.end_date`),
    f('renewal_date', 'Renewal', G.dates, 'date', sql`c.renewal_date`),
    f('signed_at', 'Signed', G.dates, 'date', sql`c.signed_at`),
    f('created_at', 'Created', G.dates, 'datetime', sql`c.created_at`),
    f('days_to_end', 'Days to end', G.measures, 'number', sql`c.end_date - current_date`, { aggregatable: true }),
    f('notice_period_days', 'Notice period (days)', G.measures, 'number', sql`c.notice_period_days`, { aggregatable: true }),
    f('auto_renew', 'Auto-renew', G.classification, 'boolean', sql`c.auto_renew`, { groupable: true }),
    f('service_count', 'Services', G.measures, 'number', sql`(SELECT count(*)::int FROM contract_services cs WHERE cs.contract_id = c.id)`, { aggregatable: true }),
    f('site_count', 'Sites', G.measures, 'number', sql`(SELECT count(*)::int FROM contract_sites cs WHERE cs.contract_id = c.id)`, { aggregatable: true }),
    f('open_tickets', 'Open tickets', G.measures, 'number', sql`(SELECT count(*)::int FROM tickets x WHERE x.contract_id = c.id AND x.status_id IN ${OPEN_STATUS})`, { aggregatable: true }),
  ]),
};

const CONSUMED = sql`(SELECT coalesce(sum(q.quantity), 0) FROM entitlement_consumptions q WHERE q.entitlement_id = e.id)`;
const entitlements: EntityDef = {
  key: 'entitlements',
  label: 'Entitlements',
  description: 'Contract entitlements (visits, hours, counts) with totals consumed over the whole contract; use the AMC utilisation report for the current period.',
  from: sql`contract_entitlements e JOIN contracts c ON c.id = e.contract_id`,
  joins: {
    cu: sql`LEFT JOIN customers cu ON cu.id = e.customer_id`,
    sv: sql`LEFT JOIN services sv ON sv.id = e.service_id`,
    ty: sql`LEFT JOIN config_options ty ON ty.id = e.type_id`,
  },
  customerCol: sql`e.customer_id`,
  permissions: ['contracts:read'],
  portal: true,
  dateFields: ['created_at'],
  defaultDateField: null,
  defaultColumns: ['name', 'customer', 'contract_number', 'type', 'quantity', 'unit', 'period', 'consumed_total', 'consumed_pct', 'remaining'],
  fields: map([
    f('name', 'Name', G.identity, 'text', sql`e.name`),
    option('type', 'Type', G.classification, sql`ty.label`, 'entitlement_type', sql`e.type_id`, ['ty']),
    ref('customer', 'Customer', G.classification, sql`cu.name`, 'customer', sql`e.customer_id`, ['cu']),
    f('contract_number', 'Contract', G.classification, 'text', sql`c.number`, { groupable: true }),
    enumField('contract_status', 'Contract status', G.classification, sql`c.status`, CONTRACT_STATUSES),
    ref('service', 'Service', G.classification, sql`sv.name`, 'service', sql`e.service_id`, ['sv']),
    enumField('unit', 'Unit', G.classification, sql`e.unit`, ENTITLEMENT_UNITS),
    enumField('period', 'Period', G.classification, sql`e.period`, ENTITLEMENT_PERIODS),
    f('overage_allowed', 'Overage allowed', G.classification, 'boolean', sql`e.overage_allowed`, { groupable: true }),
    f('is_active', 'Active', G.classification, 'boolean', sql`e.is_active`, { groupable: true }),
    f('quantity', 'Quantity', G.measures, 'number', sql`e.quantity`, { aggregatable: true }),
    f('warn_threshold_pct', 'Warning threshold (%)', G.measures, 'pct', sql`e.warn_threshold_pct`),
    f('consumed_total', 'Consumed', G.measures, 'number', CONSUMED, { aggregatable: true }),
    f('consumed_pct', 'Consumed (%)', G.measures, 'pct', sql`round((100.0 * ${CONSUMED} / nullif(e.quantity, 0))::numeric, 1)`, { aggregatable: true }),
    f('remaining', 'Remaining', G.measures, 'number', sql`e.quantity - ${CONSUMED}`, { aggregatable: true }),
    f('created_at', 'Created', G.dates, 'datetime', sql`e.created_at`),
  ]),
};

const surveys: EntityDef = {
  key: 'surveys',
  label: 'Surveys',
  description: 'Satisfaction surveys sent when tickets end: who was asked, through which channel, whether they answered, the rating and the comment.',
  from: sql`ticket_surveys su JOIN tickets t ON t.id = su.ticket_id`,
  joins: {
    cu: sql`LEFT JOIN customers cu ON cu.id = t.customer_id`,
    sv: sql`LEFT JOIN services sv ON sv.id = t.service_id`,
    pr: sql`LEFT JOIN config_options pr ON pr.id = t.priority_id`,
    asg: sql`LEFT JOIN users asg ON asg.id = su.assignee_id`,
    tm: sql`LEFT JOIN teams tm ON tm.id = su.assigned_team_id`,
  },
  customerCol: sql`su.customer_id`,
  permissions: ['surveys:read'],
  portal: true,
  dateFields: ['answered_at', 'requested_at'],
  defaultDateField: 'answered_at',
  defaultColumns: ['ticket_number', 'customer', 'service', 'rating', 'comment', 'channel', 'status', 'answered_at'],
  baseWhere: (ctx) => socCond(ctx),
  fields: map([
    f('ticket_number', 'Ticket', G.identity, 'text', sql`t.number`),
    f('ticket_title', 'Title', G.identity, 'text', sql`t.title`),
    ref('customer', 'Customer', G.classification, sql`cu.name`, 'customer', sql`t.customer_id`, ['cu']),
    ref('service', 'Service', G.classification, sql`sv.name`, 'service', sql`t.service_id`, ['sv']),
    option('priority', 'Priority', G.classification, sql`pr.label`, 'ticket_priority', sql`t.priority_id`, ['pr']),
    ref('assignee', 'Assignee', G.people, sql`asg.name`, 'user', sql`su.assignee_id`, ['asg'], false),
    ref('team', 'Team', G.people, sql`tm.name`, 'team', sql`su.assigned_team_id`, ['tm'], false),
    f('rating', 'Rating', G.survey, 'number', sql`su.rating`, { aggregatable: true }),
    f('comment', 'Comment', G.survey, 'text', sql`left(su.comment, 500)`),
    enumField('channel', 'Channel', G.survey, sql`su.channel`, SURVEY_CHANNELS),
    enumField('status', 'Status', G.survey, sql`su.status`, ['pending', 'answered', 'expired', 'cancelled']),
    f('answered', 'Answered', G.survey, 'boolean', sql`su.answered_at IS NOT NULL`, { groupable: true }),
    f('requested_at', 'Requested', G.dates, 'datetime', sql`su.requested_at`),
    f('answered_at', 'Answered at', G.dates, 'datetime', sql`su.answered_at`),
  ]),
};

const software: EntityDef = {
  key: 'software',
  label: 'Software',
  description: 'Software installations: the title and publisher, the host (CI, asset or host name), the person, the source and when it was last seen. Staff only.',
  from: sql`software_installations i JOIN software_products p ON p.id = i.product_id`,
  joins: {
    cu: sql`LEFT JOIN customers cu ON cu.id = i.customer_id`,
    ci: sql`LEFT JOIN cis ci ON ci.id = i.ci_id`,
    a: sql`LEFT JOIN assets a ON a.id = i.asset_id`,
    si: sql`LEFT JOIN sites si ON si.id = coalesce(ci.site_id, a.site_id)`,
  },
  customerCol: sql`i.customer_id`,
  permissions: ['software:read'],
  portal: false,
  dateFields: ['installed_at', 'last_seen_at', 'created_at'],
  defaultDateField: 'last_seen_at',
  defaultColumns: ['product', 'publisher', 'version', 'customer', 'host_name', 'assigned_user', 'source', 'last_seen_at'],
  fields: map([
    f('product', 'Product', G.software, 'text', sql`p.name`, { portal: false, groupable: true }),
    f('publisher', 'Publisher', G.software, 'text', sql`p.publisher`, { portal: false, groupable: true }),
    f('version_family', 'Version family', G.software, 'text', sql`p.version_family`, { portal: false, groupable: true }),
    f('version', 'Version', G.software, 'text', sql`i.version`, { portal: false, groupable: true }),
    f('edition', 'Edition', G.software, 'text', sql`i.edition`, { portal: false, groupable: true }),
    f('ci_name', 'Configuration item', G.host, 'text', sql`ci.name`, { portal: false, joins: ['ci'] }),
    f('asset_tag', 'Asset tag', G.host, 'text', sql`a.tag`, { portal: false, joins: ['a'] }),
    f('host_name', 'Host name', G.host, 'text', sql`i.host_name`, { portal: false }),
    f('assigned_user', 'Assigned user', G.host, 'text', sql`i.assigned_user`, { portal: false, groupable: true }),
    ref('customer', 'Customer', G.classification, sql`cu.name`, 'customer', sql`i.customer_id`, ['cu'], false),
    ref('site', 'Site', G.classification, sql`si.name`, 'site', sql`coalesce(ci.site_id, a.site_id)`, ['ci', 'a', 'si'], false),
    enumField('source', 'Source', G.classification, sql`i.source`, INSTALL_SOURCES, false),
    f('cores', 'Cores', G.measures, 'number', sql`i.cores`, { portal: false, aggregatable: true }),
    f('installed_at', 'Installed', G.dates, 'date', sql`i.installed_at`, { portal: false }),
    f('last_seen_at', 'Last seen', G.dates, 'datetime', sql`i.last_seen_at`, { portal: false }),
    f('created_at', 'Recorded', G.dates, 'datetime', sql`i.created_at`, { portal: false }),
  ]),
};

export const ENTITIES: Record<EntityKey, EntityDef> = { tickets, changes, problems, sla_clocks: slaClocks, time_entries: timeEntries, visits, assets, cis, contracts, entitlements, surveys, software };

export const entityOf = (key: string): EntityDef | null => ((ENTITY_KEYS as readonly string[]).includes(key) ? ENTITIES[key as EntityKey] : null);

// ---------------------------------------------------------------- the public (SQL-free) view

export interface PublicField {
  key: string;
  label: string;
  group: string;
  type: FieldType;
  portal: boolean;
  groupable: boolean;
  aggregatable: boolean;
  options?: FieldOptions;
}
export interface PublicEntity {
  key: EntityKey;
  label: string;
  description: string;
  permissions: Permission[];
  /** The caller holds every entity permission (the real fence is the service). */
  permissionsOk: boolean;
  portal: boolean;
  dateFields: string[];
  defaultDateField: string | null;
  defaultColumns: string[];
  fields: PublicField[];
}

export const publicField = (x: FieldDef): PublicField => ({ key: x.key, label: x.label, group: x.group, type: x.type, portal: x.portal, groupable: !!x.groupable, aggregatable: !!x.aggregatable, ...(x.options ? { options: x.options } : {}) });

/** May the caller read the entity's records (entity permissions for staff; portal reports for customer users)? */
export const entityPermitted = (ctx: Pick<Ctx, 'user' | 'can'>, entity: EntityDef): boolean => (isCustomerUser(ctx as Ctx) ? entity.portal && ctx.can('portal:reports', ctx.user.customerId) : entity.permissions.every((p) => ctx.can(p)));

/** Every entity with `permissionsOk`; portal callers get portal entities and portal fields only. Fields never carry their SQL. */
export function catalogFor(ctx: Pick<Ctx, 'user' | 'can'>, opts: { portal: boolean }): { entities: PublicEntity[] } {
  const entities: PublicEntity[] = [];
  for (const key of ENTITY_KEYS) {
    const e = ENTITIES[key];
    if (opts.portal && !e.portal) continue;
    const fields = Object.values(e.fields).filter((x) => !opts.portal || x.portal).map(publicField);
    entities.push({ key: e.key, label: e.label, description: e.description, permissions: e.permissions, permissionsOk: entityPermitted(ctx, e), portal: e.portal, dateFields: opts.portal ? e.dateFields.filter((d) => e.fields[d]?.portal) : e.dateFields, defaultDateField: e.defaultDateField, defaultColumns: opts.portal ? e.defaultColumns.filter((c) => e.fields[c]?.portal) : e.defaultColumns, fields });
  }
  return { entities };
}
