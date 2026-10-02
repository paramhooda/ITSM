/** API view types for customers, sites and contacts (mirrors apps/api/src/modules/customers). */

export interface CustomerListItem {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  industryId: string | null;
  industryLabel: string | null;
  typeId: string | null;
  typeLabel: string | null;
  statusId: string | null;
  statusLabel: string | null;
  statusColor: string | null;
  accountManagerId: string | null;
  accountManagerName: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: Record<string, string>;
  timezone: string;
  tags: string[];
  isActive: boolean;
  openTickets: number;
  activeContracts: number;
  sites: number;
  createdAt: string;
}

export interface CustomerCounts {
  sites: number;
  contacts: number;
  openTickets: number;
  totalTickets: number;
  activeContracts: number;
  contracts: number;
  assets: number;
  cis: number;
  users: number;
}

export interface CustomerDetail extends Omit<CustomerListItem, 'openTickets' | 'activeContracts' | 'sites'> {
  notes: string | null;
  customFields: Record<string, unknown>;
  accountManagerEmail: string | null;
  counts: CustomerCounts;
  teams: TeamRef[];
  updatedAt: string;
}

export interface TeamRef {
  id: string;
  key: string;
  name: string;
  teamType: string;
  isActive?: boolean;
  email?: string | null;
}

export interface Site {
  id: string;
  customerId: string;
  code: string;
  name: string;
  typeId: string | null;
  typeLabel: string | null;
  address: Record<string, string>;
  timezone: string | null;
  phone: string | null;
  isPrimary: boolean;
  isActive: boolean;
  businessHoursCalendarId: string | null;
  notes: string | null;
  counts: { assets: number; cis: number; contacts: number; openTickets: number };
}

export interface Contact {
  id: string;
  customerId: string;
  siteId: string | null;
  siteName: string | null;
  userId: string | null;
  portalUser: { id: string; email: string; status: string } | null;
  name: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  title: string | null;
  department: string | null;
  isPrimary: boolean;
  isEscalation: boolean;
  escalationLevel: number | null;
  notes: string | null;
  isActive: boolean;
}

export interface OverviewTicket {
  id: string;
  number: string;
  type: string;
  title: string;
  createdAt: string;
  statusLabel: string;
  statusColor: string | null;
  statusCategory: string;
  priorityLabel: string | null;
  priorityColor: string | null;
}

export interface CustomerOverview {
  customer: { id: string; code: string; name: string };
  counts: CustomerCounts;
  ticketsByStatusCategory: Record<string, number>;
  ticketsByPriority: { priorityId: string | null; label: string; color: string | null; level: number | null; count: number }[];
  recentTickets: OverviewTicket[];
  contracts: { id: string; number: string; name: string; status: string; statusLabel: string; statusColor: string; typeLabel: string | null; startDate: string; endDate: string; renewalDate: string | null; daysToExpiry: number; covering: boolean }[];
  entitlements: import('@/components/contracts/types').Entitlement[];
  sla30d: { met: number; breached: number; compliancePct: number | null };
  recentActivity: { id: string; occurredAt: string; userName: string | null; entityType: string; entityId: string | null; entityLabel: string | null; action: string }[];
  upcomingVisits: { id: string; number: string; title: string; status: string; scheduledStart: string | null; scheduledEnd: string | null; engineerName: string | null; siteName: string | null }[];
  upcomingPm: { id: string; programId: string; programName: string; plannedDate: string; scheduledDate: string | null; status: string; siteName: string | null }[];
  next: { visit: CustomerOverview['upcomingVisits'][number] | null; pm: CustomerOverview['upcomingPm'][number] | null };
}

export interface PortalUser {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  title: string | null;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  roles: { key: string; name: string }[];
}

export const ADDRESS_FIELDS: { key: string; label: string; span?: 2 }[] = [
  { key: 'line1', label: 'Address line 1', span: 2 },
  { key: 'line2', label: 'Address line 2', span: 2 },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State / Region' },
  { key: 'postalCode', label: 'Postal code' },
  { key: 'country', label: 'Country' },
];

export const formatAddress = (a?: Record<string, string> | null) => (a ? [a.line1, a.line2, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(', ') : '');

export const TIMEZONES = ['Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney'];
