import { useQuery } from '@tanstack/react-query';
import { get } from '@/api/client';
import type { Delta } from './types';
import type { ExpiringContract } from './ExpiringContracts';
import type { EntitlementAlert } from './EntitlementAlerts';

/**
 * `GET /dashboards/overview` (mirrors apps/api/src/modules/dashboards/overview.ts).
 * One payload scoped to the caller's permissions: `me` for everyone, the desk
 * only with tickets:read, the operations strips only with their dashboard
 * permission, the management extras only with dashboards:management. Every
 * number that links is counted live with the predicates its link carries.
 */

export interface OverviewShift {
  id: string;
  name: string;
  timezone: string;
  shiftDate: string;
  startsAt: string;
  endsAt: string;
}

export interface OverviewMe {
  name: string;
  shift: { teamId: string; teamName: string; current: OverviewShift | null; next: OverviewShift | null } | null;
  assigned: number;
  breached: number;
  atRisk: number;
  dueToday: number;
  resolvedToday: number;
  approvals: number;
  byType: { type: string; count: number }[];
}

export interface OverviewAnnouncement {
  id: string;
  title: string;
  body: string;
  type: string;
  pinned: boolean;
  startsAt: string | null;
  endsAt: string | null;
  sourceTicket: { id: string; number: string; title: string } | null;
}

export type UpcomingKind = 'visit' | 'maintenance' | 'cab' | 'change';

export interface UpcomingItem {
  kind: UpcomingKind;
  id: string;
  title: string;
  subtitle: string | null;
  customerName: string | null;
  status: string | null;
  startsAt: string | null;
  endsAt: string | null;
  /** YYYY-MM-DD for items without a time (a maintenance occurrence). */
  day: string | null;
  href: string;
}

/** A type alias (not an interface) so the rows feed `TrendChart` as plain records. */
export type DeskSeriesDay = {
  day: string;
  opened: number;
  resolved: number;
  breaches: number;
  resolutionMet: number;
  resolutionBreached: number;
  compliancePct: number | null;
};

/** Backlog age bucket with the created window each bar drills down with (exact timestamps, inclusive). */
export interface AgeBucket {
  bucket: string;
  count: number;
  breached: number;
  createdFrom: string | null;
  createdTo: string | null;
}

export interface PatternCell {
  row: string;
  col: string;
  value: number;
}

/** One hour of the trailing week: the exact window the cell drills down with. */
export interface WeekCell extends PatternCell {
  day: string;
  createdFrom: string;
  createdTo: string;
}

export interface Arrivals {
  timezone: string;
  week: { from: string; to: string; cells: WeekCell[] };
  pattern: { from: string; to: string; cells: PatternCell[] };
}

export interface LoadRow {
  id: string | null;
  label: string;
  open: number;
  breached: number;
  atRisk: number;
}

export type LoadDimension = 'team' | 'engineer' | 'service' | 'customer' | 'category';

export interface ResponsivenessRow {
  id: string | null;
  priority: string;
  level: number;
  opened: number;
  resolved: number;
  mttaMinutes: number | null;
  mttrMinutes: number | null;
  fcrPct: number | null;
  reopenPct: number | null;
}

export interface ChangeOutcomes {
  total: number;
  implemented: number;
  failed: number;
  backedOut: number;
  emergency: number;
  standard: number;
  successPct: number | null;
  failedList: { number: string; title: string; changeType: string; outcome: string; scheduledStart: string | null; assignee: string | null }[];
}

export interface DeskKpis {
  open: number;
  breached: number;
  atRisk: number;
  unassigned: number;
  major: number;
  openedInPeriod: number;
  resolvedInPeriod: number;
  openedToday: number;
  slaCompliancePct: number | null;
  resolutionMet: number;
  resolutionBreached: number;
}

export interface OverviewDesk {
  kpis: DeskKpis;
  /** Open against the backlog at the start of the period; the period counts against the previous period. */
  deltas: { open: Delta; openedInPeriod: Delta; resolvedInPeriod: Delta; slaCompliancePct: Delta; breaches: Delta };
  /** Live and fenced; draws sparklines and charts only (the tiles are counted live). */
  series: DeskSeriesDay[];
  byType: { type: string; count: number; breached: number }[];
  ageing: AgeBucket[];
  arrivals: Arrivals;
  breakdowns: Record<LoadDimension, LoadRow[]>;
  byPriority: ResponsivenessRow[];
  changes: { open: number; outcomes: ChangeOutcomes };
}

/** The NOC dashboard's tile numbers (identical to its `totals`). */
export interface NocStrip {
  open: number;
  openIncidents: number;
  breached: number;
  atRisk: number;
  unassigned: number;
  major: number;
  escalated: number;
  openedToday: number;
  highRisk: number;
  mediumRisk: number;
  unhappy: number;
  resolvedToday: number;
  mttrTodayMinutes: number | null;
  knownErrorsOpen: number;
}

/** The SOC dashboard's tile numbers (identical to its `totals`). */
export interface SocStrip {
  open: number;
  breached: number;
  atRisk: number;
  escalated: number;
  unassigned: number;
  openedToday: number;
  criticalHigh: number;
  criticalHighSeverityIds: string[];
}

/** The AMC dashboard's tile numbers (identical to its `kpis`). */
export interface AmcStrip {
  open: number;
  unassigned: number;
  breached: number;
  atRisk: number;
  dueToday: number;
  awaitingCustomer: number;
  openedToday: number;
  resolvedThisWeek: number;
  resolvedToday: number;
  visitsThisWeek: number;
}

export interface AttentionRow {
  id: string;
  name: string;
  code: string;
  tickets: number;
  resolved: number;
  out_of_scope: number;
  major: number;
  slaMet: number;
  slaBreached: number;
  compliancePct: number | null;
}

export interface OverviewManagement {
  kpis: { customersActive: number; contractsActive: number; contractsExpiring90d: number; contractsExpired30d: number; entitlementsOverThreshold: number; entitlementsExhausted: number; expiringContracts: number };
  needsAttention: AttentionRow[];
  expiringContracts: ExpiringContract[];
  entitlementAlerts: EntitlementAlert[];
  csat: { avg: number | null; satisfiedPct: number | null; responseRate: number | null; responses: number; low: number; series: { week: string; responses: number; avg: number | null }[]; trendAvg: Delta | null };
}

export interface Overview {
  generatedAt: string;
  period: { days: number; from: string; to: string; previousFrom: string; previousTo: string };
  customerId: string | null;
  timezone: string;
  me: OverviewMe;
  announcements: OverviewAnnouncement[];
  upcoming: { counts: { visits: number; maintenance: number; cab: number; changes: number }; items: UpcomingItem[] };
  desk: OverviewDesk | null;
  strips: { noc?: NocStrip; soc?: SocStrip; amc?: AmcStrip };
  management: OverviewManagement | null;
}

export const overviewKeys = {
  overview: (days: number, customerId: string) => ['dashboards', 'overview', days, customerId] as const,
};

/** The Overview payload for the scope; one query per scope, shared by the page and its sections. */
export function useOverview({ days, customerId }: { days: number; customerId: string }) {
  return useQuery({ queryKey: overviewKeys.overview(days, customerId), queryFn: () => get<Overview>('/dashboards/overview', { days, customerId: customerId || undefined }), refetchInterval: 60_000, placeholderData: (p) => p });
}
