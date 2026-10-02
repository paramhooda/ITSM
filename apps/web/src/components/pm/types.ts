/** API shapes of the preventive maintenance module (mirrors apps/api/src/modules/pm). */
export type PmStatus = 'planned' | 'scheduled' | 'completed' | 'missed' | 'rescheduled' | 'cancelled';
export const PM_STATUSES: PmStatus[] = ['planned', 'scheduled', 'rescheduled', 'completed', 'missed', 'cancelled'];
export const PM_STATUS_LABELS: Record<PmStatus, string> = { planned: 'Planned', scheduled: 'Scheduled', rescheduled: 'Rescheduled', completed: 'Completed', missed: 'Missed', cancelled: 'Cancelled' };
export const PM_STATUS_COLORS: Record<PmStatus, string> = { planned: 'slate', scheduled: 'blue', rescheduled: 'indigo', completed: 'green', missed: 'red', cancelled: 'gray' };
export type PmFrequency = 'weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'annual' | 'custom';
export const FREQUENCY_LABELS: Record<PmFrequency, string> = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', half_yearly: 'Half-yearly', annual: 'Annual', custom: 'Custom interval' };

export interface ProgramChecklistItem {
  item: string;
  required?: boolean;
}

export interface ProgramRow {
  id: string;
  customerId: string;
  customerName: string | null;
  siteId: string | null;
  siteName: string | null;
  contractId: string | null;
  contractNumber: string | null;
  contractName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  entitlementId: string | null;
  entitlementName: string | null;
  name: string;
  description: string | null;
  frequency: PmFrequency;
  intervalDays: number | null;
  startDate: string;
  endDate: string | null;
  leadDays: number;
  graceDays: number;
  checklist: ProgramChecklistItem[];
  checklistCount?: number;
  assignedTeamId: string | null;
  teamName: string | null;
  assignedEngineerId: string | null;
  engineerName: string | null;
  ciIds: string[];
  assetIds: string[];
  requiresSiteVisit: boolean;
  isActive: boolean;
  nextDue: string | null;
  open: number;
  overdue: number;
  completed12m: number;
  missed12m: number;
  total: number;
  createdAt: string;
  updatedAt: string;
}

export interface OccurrenceRow {
  id: string;
  programId: string;
  programName: string;
  customerId: string;
  customerName: string | null;
  siteId: string | null;
  siteName: string | null;
  frequency: PmFrequency;
  requiresSiteVisit: boolean;
  graceDays: number;
  leadDays: number;
  programActive: boolean;
  plannedDate: string;
  scheduledDate: string | null;
  effectiveDate: string;
  status: PmStatus;
  fieldVisitId: string | null;
  fieldVisitNumber: string | null;
  fieldVisitStatus: string | null;
  ticketId: string | null;
  ticketNumber: string | null;
  engineerId: string | null;
  engineerName: string | null;
  teamId: string | null;
  teamName: string | null;
  completedAt: string | null;
  checklistResults: Record<string, unknown>[];
  notes: string | null;
  rescheduleReason: string | null;
  daysUntil: number;
  overdue: boolean;
  dueSoon: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProgramDetail extends ProgramRow {
  occurrences: (Omit<OccurrenceRow, 'programName' | 'customerName' | 'siteName' | 'frequency' | 'requiresSiteVisit' | 'graceDays' | 'leadDays' | 'programActive' | 'effectiveDate' | 'overdue' | 'dueSoon' | 'teamId' | 'teamName' | 'siteId'> & { fieldVisitNumber: string | null; fieldVisitStatus: string | null; ticketNumber: string | null; engineerName: string | null; daysUntil: number })[];
  cis: { id: string; name: string; hostname: string | null; ipAddress: string | null; typeKey: string; typeName: string; typeColor: string | null; status: string; customerId: string }[];
  assets: { id: string; tag: string; name: string; serialNumber: string | null }[];
  entitlement: { id: string; name: string; unit: string; period: string; quantity: number; typeKey: string | null; utilization: { quantity: number; used: number; remaining: number; pct: number; periodStart: string; periodEnd: string; exhausted: boolean } } | null;
  permissions: { canManage: boolean; canCreateVisit: boolean };
}

export interface PmSummary {
  range: { from: string; to: string };
  counts: { planned: number; scheduled: number; rescheduled: number; completed: number; missed: number; cancelled: number; total: number };
  onTimePct: number | null;
  completionPct: number | null;
  perCustomer: { customerId: string; customerName: string | null; programs: number; planned: number; completed: number; missed: number; onTime: number; onTimePct: number | null }[];
  upcoming: OccurrenceRow[];
  overdue: OccurrenceRow[];
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
