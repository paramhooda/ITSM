/**
 * Shapes of the module Overview endpoints (kept in sync with apps/api/src/modules/<module>/service.ts).
 *
 *   GET /assets/overview?customerId        → AssetsOverview
 *   GET /customers/overview                → CustomersOverview
 *   GET /contracts/overview?customerId     → ContractsOverview
 *   GET /contracts/entitlements?…          → EntitlementRow list (paged)
 *   GET /field/overview?customerId         → FieldOverview
 *   GET /knowledge/overview                → KnowledgeOverview
 *   GET /portal/assets/overview            → PortalAssetsOverview
 *
 * Every count is a whole number; every breakdown is an array in display order.
 */

export interface Bucket {
  key: string;
  label: string;
  count: number;
  /** Optional colour key from statusColors (lifecycle stage, status, severity …). */
  color?: string | null;
}

export interface SeriesPoint {
  day: string;
  [metric: string]: string | number;
}

export interface CoverageBuckets {
  /** Past the end date. */
  expired: number;
  /** Ends within 30 days. */
  d30: number;
  /** Ends in 31 to 90 days. */
  d90: number;
  /** Ends later than 90 days. */
  ok: number;
  /** No end date recorded. */
  none: number;
}

export interface AssetsOverview {
  total: number;
  withCi: number;
  withoutCi: number;
  addedLast30d: number;
  byLifecycle: Bucket[];
  byCategory: Bucket[];
  byCustomer: Bucket[];
  bySite: Bucket[];
  warranty: CoverageBuckets;
  amc: CoverageBuckets;
  eol: { past: number; d90: number; d365: number };
  /** Soonest expiries, for the "due next" list: warranty and AMC together. */
  expiringSoon: { id: string; tag: string; name: string; customerName: string | null; kind: 'warranty' | 'amc'; endDate: string; daysLeft: number }[];
}

export interface CustomersOverview {
  total: number;
  active: number;
  inactive: number;
  newLast90d: number;
  byStatus: Bucket[];
  byType: Bucket[];
  byIndustry: Bucket[];
  /** Customers with the most open P1/P2 work, worst first. */
  attention: { id: string; name: string; code: string; openTickets: number; openP1: number; breached: number; slaCompliance30d: number | null; contractsExpiring60d: number; entitlementsOverThreshold: number }[];
  /** 30-day SLA compliance per customer, lowest first (null when nothing measured). */
  slaByCustomer: { id: string; name: string; met: number; breached: number; compliancePct: number | null }[];
  contractsExpiring60d: number;
  entitlementsOverThreshold: number;
}

export interface ContractsOverview {
  total: number;
  byStatus: Bucket[];
  byType: Bucket[];
  expiring: { d30: number; d60: number; d90: number; expired: number };
  /** Expiries per month for the next 12 months. */
  expiryTimeline: { month: string; count: number }[];
  entitlements: { total: number; ok: number; overThreshold: number; exhausted: number; byType: Bucket[] };
  scope: { contractsWithoutScope: number; outOfScopeTickets30d: number };
  health: { missingAgreement: number; noSlaPolicy: number; noServices: number };
  /** Soonest expiries. */
  expiringSoon: { id: string; number: string; name: string; customerName: string; endDate: string; daysLeft: number; status: string }[];
}

export interface EntitlementRow {
  id: string;
  name: string;
  type: string | null;
  unit: string;
  contractId: string;
  contractNumber: string;
  customerId: string;
  customerName: string;
  period: string;
  periodStart: string | null;
  periodEnd: string | null;
  quantity: number;
  used: number;
  remaining: number;
  pct: number;
  overThreshold: boolean;
  exhausted: boolean;
}

export interface FieldOverview {
  today: { scheduled: number; inProgress: number; completed: number };
  week: { scheduled: number; completed: number; cancelled: number };
  byStatus: Bucket[];
  overdue: number;
  unassigned: number;
  awaitingAcknowledgement: number;
  /** Load for the next 7 days per engineer, busiest first. */
  byEngineer: { id: string; name: string; scheduled: number; inProgress: number }[];
  pm: { dueThisMonth: number; overdue: number; completedThisMonth: number; byStatus: Bucket[] };
  /** Visits completed and maintenance completed per day, last 30 days. */
  series: SeriesPoint[];
  /** Next visits, soonest first. */
  upcoming: { id: string; number: string; title: string; customerName: string; siteName: string | null; engineerName: string | null; scheduledStart: string; status: string }[];
}

export interface KnowledgeOverview {
  total: number;
  byStatus: Bucket[];
  byType: Bucket[];
  byVisibility: Bucket[];
  byCategory: Bucket[];
  drafts: number;
  expiringSoon30d: number;
  expired: number;
  /** Published and not updated in 180 days. */
  stale: number;
  withoutCategory: number;
  viewsLast30d: number;
  topViewed: { id: string; number: string; title: string; viewCount: number; visibility: string }[];
  recentlyUpdated: { id: string; number: string; title: string; updatedAt: string; status: string }[];
}

export interface PortalAssetsOverview {
  total: number;
  byCategory: Bucket[];
  byLifecycle: Bucket[];
  bySite: Bucket[];
  warranty: CoverageBuckets;
  amc: CoverageBuckets;
  expiringSoon: { id: string; tag: string; name: string; siteName: string | null; kind: 'warranty' | 'amc'; endDate: string; daysLeft: number }[];
}
