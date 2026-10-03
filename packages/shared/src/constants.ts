/** Ticket types supported by the unified ticket model. */
export const TICKET_TYPES = ['incident', 'request', 'problem', 'change'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const TICKET_PREFIX: Record<TicketType, string> = {
  incident: 'INC',
  request: 'REQ',
  problem: 'PRB',
  change: 'CHG',
};

/**
 * Status categories: every configurable status maps to one of these so that
 * SLA clocks, dashboards and reports can reason about any custom status.
 */
export const STATUS_CATEGORIES = ['new', 'open', 'pending', 'resolved', 'closed', 'cancelled'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** Scope classification of a ticket relative to the customer's contracts. Never a blocker. */
export const SCOPE_STATUSES = ['in_scope', 'out_of_scope', 'unknown'] as const;
export type ScopeStatus = (typeof SCOPE_STATUSES)[number];

export const SLA_METRICS = ['acknowledgement', 'response', 'restoration', 'resolution'] as const;
export type SlaMetric = (typeof SLA_METRICS)[number];

export const SLA_STATES = ['running', 'paused', 'met', 'breached', 'cancelled'] as const;
export type SlaState = (typeof SLA_STATES)[number];

/** Operational domains used to tag categories/defaults (NOC / SOC / AMC / Service Desk). */
export const DOMAINS = ['general', 'noc', 'soc', 'amc', 'service_desk'] as const;
export type Domain = (typeof DOMAINS)[number];

/** Configurable option lists (picklists) managed in Administration. */
export const OPTION_TYPES = [
  'ticket_category',
  'ticket_subcategory',
  'ticket_priority',
  'ticket_impact',
  'ticket_urgency',
  'ticket_status',
  'ticket_source',
  'resolution_code',
  'closure_code',
  'customer_type',
  'customer_status',
  'customer_industry',
  'site_type',
  'contract_type',
  'contract_status',
  'entitlement_type',
  'scope_header',
  'scope_category',
  'scope_type',
  'scope_status',
  'service_category',
  'service_subcategory',
  'service_status',
  'asset_category',
  'asset_status',
  'field_visit_type',
  'field_visit_status',
  'pm_frequency',
  'change_type',
  'change_risk',
  'security_severity',
  'kb_type',
  'team_type',
] as const;
export type OptionType = (typeof OPTION_TYPES)[number];

/** Option types that hang off a parent type: their `parentId` must reference an option of the parent type. */
export const OPTION_PARENT_TYPES: Partial<Record<OptionType, OptionType>> = {
  ticket_subcategory: 'ticket_category',
  service_subcategory: 'service_category',
};

export const CHANGE_TYPES = ['standard', 'normal', 'emergency'] as const;
export const LINK_TYPES = ['related', 'duplicate_of', 'caused_by', 'blocks', 'child_of', 'problem_of', 'change_for', 'resolved_by'] as const;
export const ENTITLEMENT_UNITS = ['visits', 'hours', 'count', 'incidents'] as const;
export const ENTITLEMENT_PERIODS = ['contract', 'yearly', 'half_yearly', 'quarterly', 'monthly'] as const;
export const PM_STATUSES = ['planned', 'scheduled', 'completed', 'missed', 'rescheduled', 'cancelled'] as const;
export const FIELD_VISIT_STATUSES = ['requested', 'scheduled', 'in_progress', 'completed', 'cancelled'] as const;
export const CI_STATUSES = ['planned', 'active', 'inactive', 'maintenance', 'retired'] as const;
/**
 * How a failure travels along a CI relationship (source → target):
 * downstream = the SOURCE is impacted when the TARGET fails (depends_on, runs_on, ...),
 * upstream   = the TARGET is impacted when the SOURCE fails (supports, manages),
 * none       = no impact propagation (connected_to, located_at, ...).
 */
export const IMPACT_DIRECTIONS = ['downstream', 'upstream', 'none'] as const;
export type ImpactDirection = (typeof IMPACT_DIRECTIONS)[number];
export const ASSET_LIFECYCLE = ['ordered', 'in_stock', 'deployed', 'in_repair', 'retired', 'disposed'] as const;
export const KB_VISIBILITY = ['internal', 'customer', 'public'] as const;
export const NOTIFICATION_EVENTS = [
  'ticket.created', 'ticket.assigned', 'ticket.status_changed', 'ticket.customer_comment', 'ticket.engineer_comment',
  'ticket.resolved', 'ticket.closed', 'ticket.escalated', 'sla.warning', 'sla.breached',
  'change.approval_requested', 'change.approved', 'change.rejected', 'request.approval_requested', 'request.approved', 'request.rejected',
  'contract.expiring', 'contract.expired', 'contract.renewal_due', 'contract.missing_documents',
  'entitlement.threshold', 'entitlement.exhausted',
  'pm.scheduled', 'pm.due', 'pm.missed', 'field_visit.scheduled', 'field_visit.completed',
  'report.delivered', 'user.password_reset', 'user.welcome',
  'incident.major_declared', 'incident.major_update', 'incident.major_resolved', 'incident.major_update_due',
  'page.sent', 'page.acknowledged', 'page.expired',
  'ticket.sentiment_negative',
  'change.window_reminder',
  'change.cab_decision',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/**
 * Navigation areas of the MSP workspace. A role lists the areas its holders
 * work in; the sidebar shows only those (administrators see everything).
 * Permissions still guard every route and API call.
 */
export const NAV_AREAS = {
  tickets: 'Tickets',
  operations: 'Operations',
  customers: 'Customers',
  contracts: 'Contracts & scope',
  catalog: 'Service catalog',
  teams: 'Teams',
  assets: 'Assets',
  cmdb: 'CMDB',
  discovery: 'Discovery',
  monitoring: 'Monitoring & SIEM',
  field: 'Field service',
  maintenance: 'Preventive maintenance',
  knowledge: 'Knowledge',
  reports: 'Reports',
} as const;
export type NavArea = keyof typeof NAV_AREAS;
export const ALL_NAV_AREAS = Object.keys(NAV_AREAS) as NavArea[];
