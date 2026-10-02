/** API view types for contracts, entitlements and scope (mirrors apps/api/src/modules/contracts). */

export type ContractStatus = 'draft' | 'active' | 'expiring' | 'expired' | 'terminated' | 'renewed';
export const CONTRACT_STATUSES: ContractStatus[] = ['draft', 'active', 'expiring', 'expired', 'terminated', 'renewed'];

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

export interface Entitlement {
  id: string;
  contractId: string;
  customerId: string;
  typeId: string | null;
  typeLabel: string | null;
  name: string;
  serviceId: string | null;
  serviceName: string | null;
  quantity: number;
  unit: string;
  period: string;
  warnThresholdPct: number;
  overageAllowed: boolean;
  notes: string | null;
  isActive: boolean;
  contractNumber: string | null;
  contractName: string | null;
  contractStatus: string | null;
  utilization: Utilization;
}

export interface Consumption {
  id: string;
  entitlementId: string;
  quantity: number;
  consumedAt: string;
  sourceType: string;
  sourceId: string | null;
  ticketId: string | null;
  ticketNumber: string | null;
  ticketTitle: string | null;
  notes: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface ScopeItem {
  id: string;
  contractId: string;
  customerId: string;
  name: string;
  description: string | null;
  classification: 'in_scope' | 'out_of_scope' | 'unknown';
  headerId: string | null;
  headerLabel: string | null;
  categoryId: string | null;
  categoryLabel: string | null;
  typeId: string | null;
  typeLabel: string | null;
  statusId: string | null;
  statusLabel: string | null;
  serviceId: string | null;
  serviceName: string | null;
  siteId: string | null;
  siteName: string | null;
  ticketCategoryId: string | null;
  ticketCategoryLabel: string | null;
  ciTypeKey: string | null;
  ciTypeName: string | null;
  assetCategoryId: string | null;
  assetCategoryLabel: string | null;
  sortOrder: number;
}

export interface ScopeGroup {
  headerId: string | null;
  headerLabel: string;
  items: ScopeItem[];
}

export interface ContractService {
  serviceId: string;
  serviceName: string;
  serviceKey: string;
  domain: string;
  slaPolicyId: string | null;
  slaPolicyName: string | null;
  effectiveSlaPolicyId: string | null;
  effectiveSlaPolicyName: string | null;
  teamId: string | null;
  teamName: string | null;
  supportHoursCalendarId: string | null;
  supportHoursCalendarName: string | null;
  notes: string | null;
}

export interface EscalationLevel {
  level: number;
  name?: string | null;
  contactId?: string | null;
  userId?: string | null;
  afterMinutes?: number | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  userName?: string | null;
  userEmail?: string | null;
}

export interface ContractListItem {
  id: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  number: string;
  name: string;
  typeId: string | null;
  typeLabel: string | null;
  status: ContractStatus;
  statusLabel: string;
  statusColor: string;
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  noticePeriodDays: number | null;
  autoRenew: boolean;
  ownerUserId: string | null;
  ownerName: string | null;
  daysToExpiry: number;
  services: { id: string; name: string }[];
  serviceNames: string[];
  entitlements: { count: number; anyOverThreshold: boolean; anyExhausted: boolean; maxPct: number };
  createdAt: string;
}

export interface ContractDetail extends Omit<ContractListItem, 'services' | 'entitlements'> {
  customer: { id: string; code: string; name: string; accountManagerId: string | null; accountManagerName: string | null } | null;
  supportHoursCalendarId: string | null;
  supportHoursCalendarName: string | null;
  holidayCalendarId: string | null;
  holidayCalendarName: string | null;
  slaPolicyId: string | null;
  slaPolicyName: string | null;
  escalationMatrix: EscalationLevel[];
  responseCommitment: string | null;
  resolutionCommitment: string | null;
  exclusions: string | null;
  description: string | null;
  signedAt: string | null;
  parentContractId: string | null;
  customFields: Record<string, unknown>;
  services: ContractService[];
  sites: { id: string; code: string; name: string; isPrimary: boolean; isActive: boolean }[];
  allSites: boolean;
  entitlements: Entitlement[];
  scopeItems: ScopeItem[];
  scopeGroups: ScopeGroup[];
  documents: { signedAgreement: boolean; sow: boolean; count: number; items: { id: string; docType: string; filename: string; title: string | null; createdAt: string }[] };
  parent: { id: string; number: string; name: string; status: string; startDate: string; endDate: string } | null;
  children: { id: string; number: string; name: string; status: string; startDate: string; endDate: string }[];
  tickets: { open: number; total: number };
  updatedAt: string;
}

export interface ServiceCoverageInput {
  serviceId: string;
  slaPolicyId?: string | null;
  teamId?: string | null;
  supportHoursCalendarId?: string | null;
  notes?: string | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
