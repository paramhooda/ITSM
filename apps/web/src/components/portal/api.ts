import { get, post, patch } from '@/api/client';
import type { OptionLabel, SlaCompact, SlaMetricSummary, TimelineEntry, CatalogField, TicketPending } from '@/components/tickets/types';
import type { PortalAssetsOverview } from '@/components/overview/types';
import type { Announcement } from '@/components/announcements/api';
import type { PortalKnownError, PortalKnownErrorList } from '@/components/known-errors/api';
import type { PortalSurvey } from '@/components/surveys/api';
import type { TicketRow } from '@/components/dashboards/types';

/** API shapes of the customer portal module (apps/api/src/modules/portal). */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PortalMe {
  user: { id: string; name: string; email: string; phone: string | null; timezone: string; roles: { key: string; name: string }[] };
  customer: { id: string; code: string; name: string; timezone: string; isActive: boolean };
  sites: { id: string; code: string; name: string; isPrimary: boolean; address: Record<string, string>; phone: string | null; timezone: string | null }[];
  serviceTeam: {
    accountManager: { name: string; email: string; phone: string | null; title: string | null } | null;
    serviceDesk: { name: string; email: string | null } | null;
    teams: { id: string; name: string; teamType: string }[];
  };
  permissions: string[];
  /** The navigator badges: the same numbers as the ticket list's tiles and chips (`GET /portal/tickets/stats` over the whole organisation). */
  counts: { open: number; awaiting: number; resolved: number; closed: number; toRate: number; all: number; pendingApprovals: number; upcomingVisits: number };
  preview: boolean;
}

/**
 * `GET /portal/tickets/stats`: the list's tiles, chips and pills under the list's
 * scope. `total` is the list's own count; `open`, `awaiting`, `breached`,
 * `atRisk`, `toRate`, `resolved`, `closed`, `all` and `byStatusCategory` are
 * counted with the status keys and the tile keys stripped, so a tile or a chip
 * never moves another; `byType` and `allTypes` also ignore the type pill.
 */
export interface PortalTicketStats {
  total: number;
  open: number;
  awaiting: number;
  breached: number;
  atRisk: number;
  toRate: number;
  resolved: number;
  closed: number;
  all: number;
  byStatusCategory: Record<string, number>;
  byType: Record<string, number>;
  allTypes: number;
  series: { day: string; opened: number; resolved: number }[];
}

export interface PortalTicketRow {
  id: string;
  number: string;
  type: 'incident' | 'request';
  typeLabel: string;
  title: string;
  status: OptionLabel;
  priority: OptionLabel | null;
  siteId: string | null;
  siteName: string | null;
  serviceName: string | null;
  categoryLabel: string | null;
  requesterUserId: string | null;
  requesterName: string | null;
  isMine: boolean;
  assigneeName: string | null;
  teamName: string | null;
  approvalStatus: string | null;
  /** The ticket waits on the organisation (a reply or an approval): the one "Waiting on you" predicate (`waitingOn=customer`). */
  awaitingCustomer: boolean;
  /** The party in the customer's vocabulary (customer, vendor, change, agreement); null when nothing waits or the hold is the desk's own. */
  waitingOn: 'customer' | 'vendor' | 'change' | 'agreement' | null;
  dueAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  sla: SlaCompact | null;
  /** The customer's rating once given, and whether the satisfaction survey is still waiting for one. */
  csatRating?: number | null;
  surveyPending?: boolean;
}

export interface PortalTicketList extends Paginated<PortalTicketRow> {
  /** The same figures as `GET /portal/tickets/stats` for the list's filters. */
  counts: PortalTicketStats;
}

export interface PortalApproval {
  id: string;
  ticketId: string;
  step: number;
  stepName: string | null;
  status: string;
  approverLabel: string;
  decidedByName: string | null;
  decidedAt: string | null;
  comment: string | null;
  createdAt: string;
  canDecide: boolean;
}

export interface PortalAttachment {
  id: string;
  filename: string;
  title: string | null;
  contentType: string;
  size: number;
  uploadedByName: string | null;
  createdAt: string;
  canDelete: boolean;
}

export interface PortalMajorBanner {
  kind: 'major_incident';
  ticketId: string;
  number: string;
  title: string;
  declaredAt: string;
  lastUpdateAt: string | null;
  nextUpdateDueAt: string | null;
  latestUpdate: { body: string; at: string } | null;
}
/** Above every portal page: major incidents being announced and the announcements aimed at this organisation. */
export type PortalBanner = PortalMajorBanner | ({ kind: 'announcement' } & Announcement);

export interface PortalTicket {
  id: string;
  number: string;
  type: 'incident' | 'request';
  isMajor?: boolean;
  typeLabel: string;
  title: string;
  description: string | null;
  status: OptionLabel | null;
  priority: OptionLabel | null;
  impact: OptionLabel | null;
  urgency: OptionLabel | null;
  category: OptionLabel | null;
  site: { id: string; name: string; code: string } | null;
  service: { id: string; name: string; key: string } | null;
  requester: { id: string; name: string } | null;
  requesterContact: { name: string } | null;
  isMine: boolean;
  assignee: { name: string; firstName: string | null } | null;
  team: { id: string; name: string } | null;
  catalogItem: { id: string; name: string } | null;
  form: { key: string; label: string; type: string; value: unknown }[];
  cis: { id: string; name: string; hostname: string | null; ipAddress: string | null; role: string }[];
  assets: { id: string; tag: string; name: string; serialNumber: string | null }[];
  scope: { status: 'in_scope' | 'out_of_scope' | 'unknown'; label: string; contract: { id: string; number: string; name: string } | null };
  contract: { id: string; number: string; name: string; slaPolicyName: string | null; endDate: string } | null;
  slaPolicy: { id: string; name: string | null } | null;
  slas: SlaMetricSummary[];
  sla: SlaCompact | null;
  resolutionNotes: string | null;
  resolutionCode: OptionLabel | null;
  closureCode: OptionLabel | null;
  approvalStatus: string | null;
  /** Why the ticket waits, in the customer's words (exactly waitingOn, waitingOnLabel, reason when shown, expectedAt); null when nothing waits on anyone the customer should know about. */
  pending: TicketPending | null;
  approvals: PortalApproval[];
  pendingForMe: PortalApproval[];
  reopenCount: number;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  timeline: TimelineEntry[];
  attachments: { items: PortalAttachment[]; canUpload: boolean };
  actions: { comment: boolean; reopen: boolean; confirmClose: boolean; approve: boolean; rate: boolean; reopenWindowDays: number };
  /** The planned window of a change ticket; nothing else of the change reaches the portal. */
  change?: { changeType: string; scheduledStart: string | null; scheduledEnd: string | null; actualStart: string | null; actualEnd: string | null; downtimeExpectedMinutes: number | null } | null;
  /** The published known error the incident is linked to (customer wording only), or matches while nothing is linked; null without portal:kedb. */
  knownError?: { linked: PortalKnownError | null; suggestions: PortalKnownError[] } | null;
  /** The satisfaction survey: the customer's own answer or the question to ask; never the recipient's email or the send history. */
  survey?: PortalSurvey;
}

/** Customer-facing state of a planned change (never the internal workflow status). */
export type PortalChangeState = 'planned' | 'approved' | 'in_progress' | 'implemented' | 'cancelled';
export interface PortalChange {
  id: string;
  number: string;
  title: string;
  changeType: string;
  state: PortalChangeState;
  outcome: 'failed' | 'backed_out' | null;
  scheduledStart: string;
  scheduledEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  downtimeExpectedMinutes: number | null;
  service: { id: string; name: string | null } | null;
  businessServices: { id: string; name: string }[];
  isMine: boolean;
}
export interface PortalChanges {
  window: { from: string; to: string };
  items: PortalChange[];
  counts: { upcoming: number; inProgress: number; past: number };
  preview: boolean;
}
export type PortalChangesParams = { state?: 'upcoming' | 'in_progress' | 'past' | 'all'; serviceId?: string; customerId?: string };

export interface PortalCatalogItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  categoryId: string | null;
  categoryLabel: string | null;
  serviceId: string | null;
  serviceName: string | null;
  formSchema: CatalogField[];
  ticketCategoryId: string | null;
  defaultPriorityId: string | null;
  defaultPriorityLabel: string | null;
  requiresApproval: boolean;
  slaPolicyName: string | null;
  sortOrder: number;
}

export interface PortalApprovalItem {
  id: string;
  step: number;
  stepName: string | null;
  status: string;
  createdAt: string;
  ticket: {
    id: string;
    number: string;
    title: string;
    type: string;
    description: string | null;
    createdAt: string;
    requesterName: string | null;
    priority: { id: string; key: string; label: string; color: string | null } | null;
    status: { id: string; key: string; label: string; color: string | null } | null;
    catalogItemName: string | null;
    form: { label: string; value: unknown }[];
  };
}

export interface SlaTarget {
  ticketType: string;
  priorityId: string | null;
  priorityKey: string | null;
  priorityLabel: string | null;
  priorityLevel: number | null;
  priorityColor: string | null;
  metric: string;
  minutes: number;
  calendarTime: boolean;
}

export interface ScopeItem {
  id: string;
  name: string;
  description: string | null;
  classification: 'in_scope' | 'out_of_scope' | 'unknown';
  serviceName: string | null;
  siteName: string | null;
  ciTypeName: string | null;
  ticketCategoryLabel: string | null;
  categoryLabel: string | null;
  typeLabel: string | null;
}

export interface ScopeGroup {
  headerId: string | null;
  headerLabel: string;
  items: ScopeItem[];
}

export interface PortalContract {
  id: string;
  number: string;
  name: string;
  status: string;
  typeLabel: string | null;
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  autoRenew: boolean;
  daysToExpiry: number;
  supportHours: { name: string; timezone: string; is24x7: boolean; hours: Record<string, [string, string][]> } | null;
  description: string | null;
  responseCommitment: string | null;
  resolutionCommitment: string | null;
  exclusions: string | null;
  slaPolicy: { id: string; name: string; calendarName: string | null; targets: SlaTarget[] } | null;
  slaPolicyName: string | null;
  services: { id: string; name: string; domain: string; teamName: string | null; slaPolicyName: string | null; supportHoursCalendarName: string | null }[];
  sites: { id: string; name: string; code: string }[];
  allSites: boolean;
  scopeGroups: ScopeGroup[];
  escalationMatrix: { level: number | null; name: string | null; afterMinutes: number | null; contact: { name: string; title: string | null; email: string | null; phone: string | null } | null; mspContactName: string | null }[];
  documents: { id: string; filename: string; title: string | null; docType: string; contentType: string; size: number; createdAt: string }[];
}

export interface Utilization {
  period: string;
  periodStart: string;
  periodEnd: string;
  quantity: number;
  used: number;
  remaining: number;
  pct: number;
  warnThresholdPct: number;
  overThreshold: boolean;
  exhausted: boolean;
}

export interface PortalEntitlement {
  id: string;
  name: string;
  typeLabel: string | null;
  unit: string;
  period: string;
  quantity: number;
  serviceName: string | null;
  contractNumber: string | null;
  contractName: string | null;
  utilization: Utilization;
}

export interface PortalServices {
  contracts: PortalContract[];
  services: { id: string; name: string; description: string | null; domain: string; teamName: string | null; slaPolicyName: string | null; contractNumbers: string[] }[];
  entitlements: PortalEntitlement[];
  preview: boolean;
}

export interface ComplianceGroup {
  key: string;
  label: string;
  met: number;
  breached: number;
  running: number;
  paused: number;
  cancelled: number;
  overdueRunning: number;
  avgElapsedMinutes: number | null;
  avgTargetMinutes: number | null;
  completed: number;
  compliancePct: number | null;
}

export interface PortalSla {
  days: number;
  from: string;
  /** The dashboards' window: whole UTC days, the list's cut, so the donut's doors reproduce. */
  period: { days: number; from: string; to: string };
  /** The dashboard figure: resolution clocks that ended in the period (met and breached are doors through `slaOutcome` + `slaEndedFrom/To`). */
  resolution: { met: number; breached: number; compliancePct: number | null };
  totals: { met: number; breached: number; running: number; paused: number; cancelled: number; overdueRunning: number; completed: number; compliancePct: number | null; avgElapsedMinutes: number | null };
  byMetric: ComplianceGroup[];
  byPriority: ComplianceGroup[];
}

/** `expiring` filter of GET /portal/assets: which cover is about to end. */
export type AssetExpiring = 'warranty30' | 'warranty90' | 'amc30' | 'amc90' | 'expired';
export const ASSET_EXPIRING_OPTIONS: { value: AssetExpiring; label: string }[] = [
  { value: 'warranty30', label: 'Warranty ending ≤ 30 d' },
  { value: 'warranty90', label: 'Warranty ending ≤ 90 d' },
  { value: 'amc30', label: 'AMC ending ≤ 30 d' },
  { value: 'amc90', label: 'AMC ending ≤ 90 d' },
  { value: 'expired', label: 'Cover expired' },
];
export const ASSET_EXPIRING_LABELS: Record<string, string> = Object.fromEntries(ASSET_EXPIRING_OPTIONS.map((o) => [o.value, o.label]));

/** Query parameters of GET /portal/assets. */
export interface PortalAssetListParams {
  q?: string;
  siteId?: string;
  categoryId?: string;
  lifecycleStage?: string;
  expiring?: AssetExpiring;
  sort?: 'tag' | 'name' | 'warrantyEnd' | 'amcEnd' | 'createdAt' | 'updatedAt' | string;
  order?: 'asc' | 'desc' | string;
  page?: number;
  pageSize?: number;
  [key: string]: unknown;
}

export interface Coverage {
  status: 'none' | 'active' | 'expiring' | 'expired';
  days: number | null;
  end: string | null;
}

export interface PortalAsset {
  id: string;
  tag: string;
  name: string;
  categoryLabel: string | null;
  siteId: string | null;
  siteName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  location: string | null;
  statusLabel: string | null;
  statusColor: string | null;
  lifecycleStage: string;
  warrantyEnd: string | null;
  warranty: Coverage;
  amcEnd: string | null;
  amc: Coverage;
  ciName: string | null;
}

export interface PortalCi {
  id: string;
  name: string;
  typeName: string;
  typeKey: string;
  typeColor: string | null;
  hostname: string | null;
  ipAddress: string | null;
  siteId: string | null;
  siteName: string | null;
  status: string;
  criticality: string;
  environment: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  assetTag: string | null;
}

export interface PortalOccurrence {
  id: string;
  programId: string;
  programName: string;
  description: string | null;
  frequency: string;
  siteId: string | null;
  siteName: string | null;
  plannedDate: string;
  scheduledDate: string | null;
  date: string;
  status: string;
  completedAt: string | null;
  fieldVisitId: string | null;
  engineerName: string | null;
  requiresSiteVisit: boolean;
  upcoming: boolean;
}

export interface PortalVisit {
  id: string;
  number: string;
  title: string;
  purpose: string | null;
  type: string | null;
  status: string;
  siteId: string | null;
  siteName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  engineerName: string | null;
  ticket: { id: string; number: string | null } | null;
  pmOccurrenceId: string | null;
  workSummary: string | null;
  recommendations: string | null;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  rating: number | null;
  reportAttachmentId: string | null;
  reportFilename: string | null;
  canAcknowledge: boolean;
  upcoming: boolean;
}

export interface PortalMaintenance {
  window: { from: string; to: string };
  upcoming: { occurrences: PortalOccurrence[]; visits: PortalVisit[] };
  past: { occurrences: PortalOccurrence[]; visits: PortalVisit[] };
  preview: boolean;
}

export type PortalRole = 'customer_user' | 'customer_admin';

export interface PortalUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  whatsappOptIn: boolean;
  /** Set when the person proved they control the number with a one-time code over WhatsApp (ISO string), or null. */
  whatsappVerifiedAt: string | null;
  /** The person switched "WhatsApp chat with Grady" on (meaningful only with a verified number). */
  assistantOn: boolean;
  title: string | null;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  role: PortalRole | null;
  roleName: string | null;
  /** May approve on behalf of the organisation: every administrator by role, a user given the approval right (the customer approver role). */
  canApprove: boolean;
  isSelf: boolean;
}

/** The body of an invitation; the approval right travels beside the base role and is ignored for an administrator, who approves by role. */
export interface PortalUserInvite {
  name: string;
  email: string;
  phone: string | null;
  title: string | null;
  role: PortalRole;
  canApprove?: boolean;
}

/** A partial update; `role` and `canApprove` may travel together or alone, the server writes the full role list either way so a role edit keeps the approval right. */
export interface PortalUserPatch {
  name?: string;
  phone?: string | null;
  title?: string | null;
  status?: 'active' | 'disabled';
  whatsappOptIn?: boolean;
  role?: PortalRole;
  canApprove?: boolean;
}

export const ROLE_LABELS: Record<PortalRole, string> = { customer_user: 'User', customer_admin: 'Administrator' };

/** Query keys start with 'portal' so pages can invalidate the module. */
/** GET /portal/software: the organisation's titles and their licence position (never cost, keys or paperwork). */
export interface PortalPosition {
  /** Positions have no id of their own; tables key rows on productId. */
  id?: string;
  productId: string;
  publisher: string;
  name: string;
  versionFamily: string | null;
  categoryLabel: string | null;
  metric: string;
  installed: number;
  entitled: number | null;
  unused: number | null;
  utilisationPct: number | null;
  position: string;
  nextEndDate: string | null;
}
export interface PortalSoftware {
  totals: { titles: number; installations: number; overDeployed: number; unlicensed: number; expiring90: number };
  positions: PortalPosition[];
  preview: boolean;
}
export interface PortalLicence {
  id: string;
  name: string;
  productId: string;
  publisher: string;
  product: string;
  versionFamily: string | null;
  metric: string;
  term: string;
  quantity: number;
  startDate: string | null;
  endDate: string | null;
  renewalDate: string | null;
  autoRenew: boolean;
  status: string;
  daysLeft: number | null;
  installed: number;
  contractNumber: string | null;
}
export interface PortalInstallation {
  id: string;
  productId: string;
  publisher: string;
  product: string;
  versionFamily: string | null;
  version: string | null;
  edition: string | null;
  host: string | null;
  assignedUser: string | null;
  source: string;
  lastSeenAt: string | null;
}

/** A period-over-period movement on the home's tiles. */
export interface PortalDelta {
  current: number;
  previous: number | null;
  deltaPct: number | null;
}

/** One row of "open by site" or "open by service" (`openLoad`): a null id is a figure ("No site"), never a door. */
export interface PortalLoadRow {
  id: string | null;
  label: string;
  open: number;
  breached: number;
  atRisk: number;
}

/** One priority's share of the home's compliance figure: the same two doors with `priorityIds` added. */
export interface PortalSlaPriorityRow {
  id: string | null;
  key: string | null;
  label: string;
  color: string | null;
  level: number;
  met: number;
  breached: number;
  compliancePct: number | null;
}

/**
 * `GET /dashboards/customer?days=&siteId=` for a portal user (mirrors
 * apps/api/src/modules/dashboards/service.ts customer()): every number counted
 * live under the organisation (and site) fence with the predicates its door
 * carries, the flow per UTC day, the backlog ageing and the response by
 * priority, the customer-audience announcements, the upcoming work with one
 * predicate per count, and the figures (SLA compliance, satisfaction, contracts,
 * entitlements, reports).
 */
export interface PortalHome {
  generatedAt: string;
  customer: { id: string; name: string; code: string; timezone: string };
  period: { days: number; from: string; to: string; previousFrom: string; previousTo: string };
  timezone: string;
  /** The site scope applied (null for all sites) and its name. */
  siteId: string | null;
  site: { id: string; name: string } | null;
  series: { day: string; opened: number; incidentsOpened: number; requestsOpened: number; problemsOpened: number; changesOpened: number; resolved: number; breaches: number; resolutionMet: number; resolutionBreached: number; compliancePct: number | null }[];
  tickets: {
    open: number;
    breached: number;
    atRisk: number;
    /** Open tickets waiting on the organisation (a reply or an approval): door `waitingOn=customer`. */
    waitingOnYou: number;
    /** Of them, those awaiting the organisation's approval: door `waitingOn=customer` with `statusId=awaitingApprovalStatusId`. */
    awaitingApproval: number;
    awaitingApprovalStatusId: string | null;
    openedInPeriod: number;
    resolvedInPeriod: number;
    openedPrevious: number;
    resolvedPrevious: number;
    openAtStart: number;
    /** Staff only; null for a portal user. */
    majorOpen: number | null;
    byStatusCategory: Record<string, number>;
    /** Largest first, ties in the ticket-type order (incident, request, problem, change). */
    byType: { type: string; count: number; breached: number }[];
    /** In level order; a null id is the "No priority" figure. */
    byPriority: { id: string | null; key: string | null; label: string; color: string | null; level: number; count: number; breached: number }[];
    bySite: PortalLoadRow[];
    byService: PortalLoadRow[];
  };
  deltas: { open: PortalDelta; openedInPeriod: PortalDelta; resolvedInPeriod: PortalDelta; slaCompliancePct: PortalDelta };
  ageing: { bucket: string; count: number; breached: number; createdFrom: string | null; createdTo: string | null }[];
  byPriorityResponsiveness: { id: string | null; priority: string; level: number; opened: number; resolved: number; mttaMinutes: number | null; mttrMinutes: number | null; fcrPct: number | null; reopenPct: number | null }[];
  /** Announcements aimed at customers (this organisation or every customer), pinned first. */
  announcements: { id: string; title: string; body: string; type: string; pinned: boolean; startsAt: string | null; endsAt: string | null; sourceTicket: { id: string; number: string; title: string } | null }[];
  upcoming: {
    horizonDays: number;
    /** Changes and approvals are null when the person may not open their pages. */
    counts: { visits: number; maintenance: number; changes: number | null; approvals: number | null };
    visits: { id: string; number: string; title: string; status: string; scheduledStart: string | null; scheduledEnd: string | null; siteId: string | null; site: string | null; engineer: string | null }[];
    maintenance: { id: string; program: string; plannedDate: string; scheduledDate: string | null; status: string; siteId: string | null; site: string | null; engineer: string | null }[];
    changes: { id: string; number: string; title: string; changeType: string | null; state: PortalChangeState; scheduledStart: string | null; scheduledEnd: string | null; downtimeExpectedMinutes: number | null; service: { id: string; name: string | null } | null }[] | null;
    approvals: { id: string; step: number; stepName: string | null; createdAt: string; ticket: { id: string; number: string; title: string; type: string } }[] | null;
  };
  /** SLA compliance · Nd: resolution clocks that ended in the period under the organisation (and site) fence, the previous period, the open clocks now and the same by priority; met and breached are doors. */
  sla: { met: number; breached: number; compliancePct: number | null; previous: { met: number; breached: number; compliancePct: number | null }; open: { atRisk: number; breached: number }; byPriority: PortalSlaPriorityRow[] };
  contracts: { id: string; number: string; name: string; status: string; start_date: string; end_date: string; days_to_expiry: number; auto_renew: boolean; type: string | null; services: string | null }[];
  entitlements: { id: string; name: string; unit: string; period: string; contractNumber: string | null; quantity: number; used: number; remaining: number; pct: number; overThreshold: boolean; exhausted: boolean; periodEnd: string }[];
  reports: { id: string; name: string; report_key: string; format: string; created_at: string; attachment_id: string | null; filename: string | null; size: number | null; period: string | null }[];
  recentTickets: TicketRow[];
  serviceTeam: { accountManager: { id: string; name: string; email: string; phone: string | null } | null; teams: { id: string; name: string; team_type: string; email: string | null; manager_name: string | null }[] };
  /** Published known errors of the organisation (empty without portal:kedb). */
  knownErrors: { published: number; items: { id: string; number: string; title: string; keStatus: string; publishedAt: string | null }[] };
  /** The organisation's satisfaction over the period (figures) and the tickets still to rate (one predicate with the list). */
  csat: { avg: number | null; responses: number; satisfiedPct: number | null; pending: { count: number; items: { ticketId: string; number: string; title: string; requestedAt: string; expiresAt: string }[] } };
}

export const pk = {
  me: ['portal', 'me'] as const,
  home: (params: Record<string, unknown>) => ['dashboards', 'customer', 'portal', params] as const,
  catalog: ['portal', 'catalog'] as const,
  tickets: (params: Record<string, unknown>) => ['portal', 'tickets', params] as const,
  ticketStats: (params: Record<string, unknown>) => ['portal', 'tickets', 'stats', params] as const,
  ticket: (id: string) => ['portal', 'ticket', id] as const,
  approvals: ['portal', 'approvals'] as const,
  services: ['portal', 'services'] as const,
  sla: (days: number) => ['portal', 'sla', days] as const,
  assets: (params: Record<string, unknown>) => ['portal', 'assets', params] as const,
  assetsOverview: ['portal', 'assets', 'overview'] as const,
  cis: (params: Record<string, unknown>) => ['portal', 'cis', params] as const,
  maintenance: ['portal', 'maintenance'] as const,
  changes: (params: Record<string, unknown>) => ['portal', 'changes', params] as const,
  users: (params: Record<string, unknown>) => ['portal', 'users', params] as const,
  knownErrors: (params: Record<string, unknown>) => ['portal', 'known-errors', params] as const,
  knownError: (id: string) => ['portal', 'known-error', id] as const,
  knownErrorSuggest: (params: Record<string, unknown>) => ['portal', 'known-errors', 'suggest', params] as const,
  software: (customerId?: string) => ['portal', 'software', customerId ?? ''] as const,
  softwareLicences: (params: Record<string, unknown>) => ['portal', 'software', 'licences', params] as const,
  softwareInstallations: (params: Record<string, unknown>) => ['portal', 'software', 'installations', params] as const,
};

export const portalApi = {
  me: () => get<PortalMe>('/portal/me'),
  /** The portal home's payload for a period and an optional site. */
  home: (params: { days: number; siteId?: string }) => get<PortalHome>('/dashboards/customer', params),
  catalog: () => get<{ items: PortalCatalogItem[] }>('/portal/catalog'),
  tickets: (params: Record<string, unknown>) => get<PortalTicketList>('/portal/tickets', params),
  /** The list's tiles, chips and pills for the same filters (paging and sort left out). */
  ticketStats: (params: Record<string, unknown>) => get<PortalTicketStats>('/portal/tickets/stats', params),
  ticket: (id: string) => get<PortalTicket>(`/portal/tickets/${id}`),
  createTicket: (body: Record<string, unknown>) => post<PortalTicket>('/portal/tickets', body),
  comment: (id: string, body: string) => post(`/portal/tickets/${id}/comments`, { body }),
  reopen: (id: string, reason: string) => post<PortalTicket>(`/portal/tickets/${id}/reopen`, { reason }),
  confirmClose: (id: string, comment?: string | null) => post<PortalTicket>(`/portal/tickets/${id}/close-confirm`, { comment: comment || null }),
  approvals: () => get<{ items: PortalApprovalItem[]; total: number }>('/portal/approvals'),
  decide: (ticketId: string, approvalId: string, decision: 'approved' | 'rejected', comment?: string | null) => post(`/portal/approvals/${ticketId}/${approvalId}`, { decision, comment: comment || null }),
  services: () => get<PortalServices>('/portal/services'),
  sla: (days: number) => get<PortalSla>('/portal/sla', { days }),
  assets: (params: PortalAssetListParams) => get<Paginated<PortalAsset>>('/portal/assets', params),
  /** Headline counts, breakdowns and soonest expiries for the portal assets Overview. */
  assetsOverview: () => get<PortalAssetsOverview>('/portal/assets/overview'),
  cis: (params: Record<string, unknown>) => get<Paginated<PortalCi>>('/portal/cis', params),
  maintenance: () => get<PortalMaintenance>('/portal/maintenance'),
  changes: (params: PortalChangesParams = {}) => get<PortalChanges>('/portal/changes', params as Record<string, unknown>),
  acknowledge: (visitId: string, body: { name: string; title?: string | null; notes?: string | null; rating?: number | null }) => post<PortalVisit>(`/portal/visits/${visitId}/acknowledge`, body),
  users: (params: Record<string, unknown>) => get<Paginated<PortalUser>>('/portal/users', params),
  createUser: (body: PortalUserInvite) => post<{ user: PortalUser; temporaryPassword: string | null }>('/portal/users', body),
  updateUser: (id: string, body: PortalUserPatch) => patch<PortalUser>(`/portal/users/${id}`, body),
  resetPassword: (id: string) => post<{ temporaryPassword: string | null }>(`/portal/users/${id}/reset-password`),
  /** Published known errors of the organisation (customer wording only). */
  knownErrors: (params: Record<string, unknown>) => get<PortalKnownErrorList>('/portal/known-errors', params),
  knownError: (id: string) => get<PortalKnownError>(`/portal/known-errors/${id}`),
  knownErrorSuggest: (params: Record<string, unknown>) => get<{ items: PortalKnownError[] }>('/portal/known-errors/suggest', params),
  /** Software titles and their licence position for customer administrators (portal:software); MSP staff may preview with customerId. */
  software: (customerId?: string) => get<PortalSoftware>('/portal/software', { customerId: customerId || undefined }),
  softwareLicences: (params: Record<string, unknown>) => get<Paginated<PortalLicence> & { preview: boolean }>('/portal/software/licences', params),
  softwareInstallations: (params: Record<string, unknown>) => get<Paginated<PortalInstallation> & { preview: boolean }>('/portal/software/installations', params),
};

/** Plain-language status for an SLA metric shown to customers. */
export function slaPhrase(sla: SlaCompact | null | undefined, status?: OptionLabel | null) {
  const cat = status?.category ?? '';
  if (cat === 'resolved') return { text: 'Resolved', tone: 'good' as const };
  if (cat === 'closed') return { text: 'Closed', tone: 'neutral' as const };
  if (cat === 'cancelled') return { text: 'Cancelled', tone: 'neutral' as const };
  if (!sla) return { text: '—', tone: 'neutral' as const };
  if (sla.state === 'met') return { text: 'On track', tone: 'good' as const };
  if (sla.breached) return { text: 'Target missed', tone: 'bad' as const };
  if (sla.paused) return { text: 'Waiting on you', tone: 'warn' as const };
  return { text: null, tone: sla.pctConsumed >= 75 ? ('warn' as const) : ('good' as const) };
}
