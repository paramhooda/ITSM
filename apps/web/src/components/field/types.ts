/** API shapes of the field service module (mirrors apps/api/src/modules/field). */
export type VisitStatus = 'requested' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
export const VISIT_STATUSES: VisitStatus[] = ['requested', 'scheduled', 'in_progress', 'completed', 'cancelled'];

export interface ChecklistItem {
  item: string;
  required?: boolean;
  done?: boolean;
  result?: 'ok' | 'issue' | 'na' | null;
  notes?: string | null;
}

export interface VisitListRow {
  id: string;
  number: string;
  customerId: string;
  customerName: string | null;
  siteId: string | null;
  siteName: string | null;
  ticketId: string | null;
  ticketNumber: string | null;
  contractId?: string | null;
  contractNumber?: string | null;
  serviceId?: string | null;
  serviceName?: string | null;
  typeId: string | null;
  typeLabel: string | null;
  typeKey: string | null;
  title: string;
  purpose: string | null;
  status: VisitStatus;
  engineerId: string | null;
  engineerName: string | null;
  teamId?: string | null;
  teamName: string | null;
  additionalEngineerIds?: string[];
  additionalEngineers?: { id: string; name: string }[];
  scheduledStart: string | null;
  scheduledEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  workMinutes: number | null;
  travelMinutes: number | null;
  workSummary: string | null;
  findings: string | null;
  recommendations: string | null;
  checklist: ChecklistItem[];
  customerAckName: string | null;
  customerAckTitle: string | null;
  customerAckAt: string | null;
  customerAckNotes: string | null;
  customerRating: number | null;
  reportGeneratedAt: string | null;
  pmProgramId?: string | null;
  pmProgramName: string | null;
  entitlementId?: string | null;
  entitlementName?: string | null;
  consumptionId?: string | null;
  billable?: boolean;
  cancelReason: string | null;
  acknowledged?: boolean;
  requestedBy?: string | null;
  requestedByName?: string | null;
  customFields?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Part {
  id: string;
  visitId: string;
  name: string;
  partNumber: string | null;
  serialNumber: string | null;
  quantity: number;
  unitCost: number | null;
  assetId: string | null;
  assetTag?: string | null;
  assetName?: string | null;
  billable: boolean;
  notes: string | null;
  createdAt: string;
}

export interface VisitNote {
  id: string;
  visitId: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  isInternal: boolean;
  createdAt: string;
}

export interface VisitTimeEntry {
  id: string;
  userId: string;
  userName: string | null;
  minutes: number;
  workType: string;
  billable: boolean;
  startedAt: string | null;
  description: string | null;
  entitlementId: string | null;
  consumptionId: string | null;
  createdAt: string;
}

export interface VisitEntitlement {
  id: string;
  name: string;
  unit: string;
  period: string;
  quantity: number;
  typeKey: string | null;
  typeLabel: string | null;
  contractId: string;
  utilization: { period: string; periodStart: string; periodEnd: string; quantity: number; used: number; remaining: number; pct: number; warnThresholdPct: number; overThreshold: boolean; exhausted: boolean };
}

export interface VisitPermissions {
  canManage: boolean;
  canExecute: boolean;
  canEdit?: boolean;
  canSchedule?: boolean;
  canStart?: boolean;
  canComplete?: boolean;
  canReschedule?: boolean;
  canCancel?: boolean;
  canAcknowledge: boolean;
  canNote: boolean;
  canParts?: boolean;
  canReport?: boolean;
  isAssigned?: boolean;
}

export interface VisitDetail extends VisitListRow {
  parts: Part[];
  notes: VisitNote[];
  attachmentCount: number;
  timeEntries?: VisitTimeEntry[];
  ticket: { id: string; number: string; title: string; type: string; status: string | null; statusColor?: string | null; assigneeName?: string | null } | null;
  pmOccurrence: { id: string; programId: string; programName: string; plannedDate: string; scheduledDate: string | null; status: string; frequency: string } | null;
  entitlement?: VisitEntitlement | null;
  consumption?: { id: string; quantity: number; consumedAt: string; entitlementId: string } | null;
  permissions: VisitPermissions;
}

export interface CalendarVisit {
  id: string;
  number: string;
  title: string;
  status: VisitStatus;
  customerId: string;
  customerName: string | null;
  siteName: string | null;
  engineerId: string | null;
  engineerName: string | null;
  teamId: string | null;
  additionalEngineerIds: string[];
  typeLabel: string | null;
  typeKey: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  acknowledged: boolean;
}

export interface VisitSummary {
  range: { from: string | null; to: string | null };
  total: number;
  byStatus: Record<string, number>;
  byType: { typeId: string | null; label: string; count: number }[];
  completed: number;
  avgWorkMinutes: number;
  totalWorkMinutes: number;
  avgRating: number | null;
  tiles: { scheduledThisWeek: number; inProgress: number; requested: number; completedThisMonth: number; pendingAcknowledgement: number; overdue: number };
  entitlements: { entitled: number; used: number; remaining: number; items: { id: string; name: string; contractId: string; contractNumber: string; customerId: string; customerName: string | null; quantity: number; used: number; remaining: number; pct: number; typeKey: string | null }[] };
  topEngineers: { engineerId: string | null; engineerName: string | null; count: number; workMinutes: number }[];
}

export interface Workload {
  from: string;
  to: string;
  items: { engineerId: string | null; engineerName: string | null; date: string; count: number; minutes: number }[];
  engineers: { engineerId: string; engineerName: string | null; total: number; days: Record<string, number> }[];
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const STATUS_LABELS: Record<VisitStatus, string> = { requested: 'Requested', scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
export const STATUS_COLORS: Record<VisitStatus, string> = { requested: 'slate', scheduled: 'blue', in_progress: 'amber', completed: 'green', cancelled: 'gray' };
