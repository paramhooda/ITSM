import { useQuery } from '@tanstack/react-query';
import { get } from '@/api/client';

/** SLA policy types + query hooks shared by the Service levels browse page and the admin editor. */

export interface SlaTarget {
  id?: string;
  ticketType: string;
  priorityId: string | null;
  priorityLabel?: string | null;
  priorityLevel?: number | null;
  metric: string;
  minutes: number;
  warnPct: number;
  calendarTime: boolean;
}

export interface SlaPolicyUsage {
  contracts: number;
  contractServices: number;
  catalogItems: number;
  services: number;
  tickets: number;
}

export interface SlaPolicy {
  id: string;
  name: string;
  description: string | null;
  calendarId: string | null;
  calendarName: string | null;
  calendarIs24x7: boolean | null;
  calendarTimezone?: string | null;
  holidayCalendarId: string | null;
  holidayCalendarName: string | null;
  isDefault: boolean;
  isActive: boolean;
  targets: SlaTarget[];
  pauseStatusIds: string[];
  pauseStatuses: { id: string; label: string }[];
  usage: SlaPolicyUsage;
  /** Incident targets per priority (response / resolution minutes), provided by the list endpoint. */
  targetSummary?: { priorityLabel: string; priorityLevel: number | null; response: number | null; resolution: number | null }[];
  updatedAt?: string;
}

export interface PolicyContract {
  contractId: string;
  number: string;
  name: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  status: string;
  statusLabel: string;
  statusColor: string;
  startDate: string;
  endDate: string;
  level: 'contract' | 'service';
  serviceNames: string[];
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
  completed: number;
  compliancePct: number | null;
  avgElapsedMinutes: number | null;
  avgTargetMinutes: number | null;
}

export interface Compliance {
  totals: { met: number; breached: number; running: number; paused: number; cancelled: number; overdueRunning: number; completed: number; compliancePct: number | null; avgElapsedMinutes: number | null };
  groups: ComplianceGroup[];
}

export function usageSummary(u: SlaPolicyUsage) {
  const parts: string[] = [];
  if (u.contracts) parts.push(`${u.contracts} contract${u.contracts > 1 ? 's' : ''}`);
  if (u.contractServices) parts.push(`${u.contractServices} contract service${u.contractServices > 1 ? 's' : ''}`);
  if (u.services) parts.push(`${u.services} service${u.services > 1 ? 's' : ''}`);
  if (u.catalogItems) parts.push(`${u.catalogItems} catalog item${u.catalogItems > 1 ? 's' : ''}`);
  if (u.tickets) parts.push(`${u.tickets} ticket${u.tickets > 1 ? 's' : ''}`);
  return parts.length ? parts.join(', ') : 'Not referenced yet';
}

export const METRIC_LABEL: Record<string, string> = { acknowledgement: 'Acknowledge', response: 'Respond', restoration: 'Restore', resolution: 'Resolve' };

export const useSlaPolicies = () => useQuery({ queryKey: ['sla', 'policies'], queryFn: () => get<{ items: SlaPolicy[] }>('/sla/policies') });
export const useSlaPolicy = (id: string | null) => useQuery({ queryKey: ['sla', 'policy', id], queryFn: () => get<SlaPolicy>(`/sla/policies/${id}`), enabled: !!id });

/** Where a policy is edited: the admin list opens its drawer from these query params. */
export const slaAdminPath = (id?: string | null, tab?: string) => (id ? `/admin/sla?edit=${id}${tab ? `&tab=${tab}` : ''}` : '/admin/sla?new=1');
