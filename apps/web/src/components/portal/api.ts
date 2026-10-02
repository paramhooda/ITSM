import { get, post, patch } from '@/api/client';
import type { OptionLabel, SlaCompact, SlaMetricSummary, TimelineEntry, CatalogField } from '@/components/tickets/types';
import type { PortalAssetsOverview } from '@/components/overview/types';

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
  counts: { open: number; awaiting: number; resolved: number; closed: number; all: number; pendingApprovals: number; upcomingVisits: number };
  preview: boolean;
}

export type StatusChip = 'open' | 'awaiting' | 'resolved' | 'closed' | 'all';

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
  awaitingCustomer: boolean;
  dueAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  sla: SlaCompact | null;
}

export interface PortalTicketList extends Paginated<PortalTicketRow> {
  counts: { open: number; awaiting: number; resolved: number; closed: number; all: number };
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

export interface PortalTicket {
  id: string;
  number: string;
  type: 'incident' | 'request';
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
  actions: { comment: boolean; reopen: boolean; confirmClose: boolean; approve: boolean; reopenWindowDays: number };
}

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
  title: string | null;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  role: PortalRole | null;
  roleName: string | null;
  isSelf: boolean;
}

export const ROLE_LABELS: Record<PortalRole, string> = { customer_user: 'User', customer_admin: 'Administrator' };

/** Query keys start with 'portal' so pages can invalidate the module. */
export const pk = {
  me: ['portal', 'me'] as const,
  catalog: ['portal', 'catalog'] as const,
  tickets: (params: Record<string, unknown>) => ['portal', 'tickets', params] as const,
  ticket: (id: string) => ['portal', 'ticket', id] as const,
  approvals: ['portal', 'approvals'] as const,
  services: ['portal', 'services'] as const,
  sla: (days: number) => ['portal', 'sla', days] as const,
  assets: (params: Record<string, unknown>) => ['portal', 'assets', params] as const,
  assetsOverview: ['portal', 'assets', 'overview'] as const,
  cis: (params: Record<string, unknown>) => ['portal', 'cis', params] as const,
  maintenance: ['portal', 'maintenance'] as const,
  users: (params: Record<string, unknown>) => ['portal', 'users', params] as const,
};

export const portalApi = {
  me: () => get<PortalMe>('/portal/me'),
  catalog: () => get<{ items: PortalCatalogItem[] }>('/portal/catalog'),
  tickets: (params: Record<string, unknown>) => get<PortalTicketList>('/portal/tickets', params),
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
  acknowledge: (visitId: string, body: { name: string; title?: string | null; notes?: string | null; rating?: number | null }) => post<PortalVisit>(`/portal/visits/${visitId}/acknowledge`, body),
  users: (params: Record<string, unknown>) => get<Paginated<PortalUser>>('/portal/users', params),
  createUser: (body: Record<string, unknown>) => post<{ user: PortalUser; temporaryPassword: string | null }>('/portal/users', body),
  updateUser: (id: string, body: Record<string, unknown>) => patch<PortalUser>(`/portal/users/${id}`, body),
  resetPassword: (id: string) => post<{ temporaryPassword: string | null }>(`/portal/users/${id}/reset-password`),
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
