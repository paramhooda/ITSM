import { get, post, patch, del } from '@/api/client';

/** API shapes of the status module (apps/api/src/modules/status). */

export type AnnouncementType = 'info' | 'maintenance' | 'outage';
export type AnnouncementAudience = 'all' | 'customers' | 'staff';
export type ServiceHealth = 'good' | 'degraded' | 'maintenance' | 'down';

export interface Announcement {
  id: string;
  title: string;
  body: string;
  type: AnnouncementType;
  audience: AnnouncementAudience;
  customerIds: string[];
  pinned: boolean;
  isActive: boolean;
  startsAt: string;
  endsAt: string | null;
  sourceTicket: { id: string; number: string; title: string } | null;
  createdAt: string;
  updatedAt: string;
}
export interface AnnouncementRow extends Announcement {
  customers: { id: string; name: string }[];
  state: 'live' | 'scheduled' | 'ended';
}
export interface AnnouncementInput {
  title: string;
  body: string;
  type?: AnnouncementType;
  audience?: AnnouncementAudience;
  customerIds?: string[];
  startsAt?: string;
  endsAt?: string | null;
  pinned?: boolean;
  isActive?: boolean;
  sourceTicketId?: string | null;
}
export interface AnnouncementDraft {
  title: string;
  body: string;
  type: AnnouncementType;
  audience: AnnouncementAudience;
  aiGenerated: boolean;
  sourceTicketId: string | null;
}

export interface HealthReason {
  kind: 'major_incident' | 'event' | 'maintenance' | 'change';
  ref: string;
  label: string;
  text: string;
  until?: string | null;
}
export interface StatusService {
  id: string;
  name: string;
  criticality: string;
  health: ServiceHealth;
  reasons: HealthReason[];
  computedAt: string | null;
}
export interface MaintenanceItem {
  kind: 'pm' | 'change';
  id: string;
  number: string | null;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  day: string | null;
  status: string;
}
export interface StatusIncident {
  ticketId: string;
  number: string;
  title: string;
  declaredAt: string;
  nextUpdateDueAt: string | null;
  latestUpdate: { body: string; at: string } | null;
}
export interface PortalStatus {
  customerId: string;
  generatedAt: string;
  overall: ServiceHealth;
  overallLabel: string;
  counts: { services: number; down: number; degraded: number; maintenance: number };
  services: StatusService[];
  maintenance: MaintenanceItem[];
  announcements: Announcement[];
  incidents: StatusIncident[];
}
/** The public, token-only page: words, not records. */
export interface PublicStatus {
  customer: { name: string };
  page: { label: string };
  generatedAt: string;
  overall: ServiceHealth;
  overallLabel: string;
  counts: { services: number; down: number; degraded: number; maintenance: number };
  services: { name: string; health: ServiceHealth; label: string; reasons: string[]; until: string | null }[];
  maintenance: { kind: 'pm' | 'change'; title: string; startsAt: string | null; endsAt: string | null; day: string | null; status: string }[];
  announcements: { id: string; title: string; body: string; type: AnnouncementType; pinned: boolean; startsAt: string; endsAt: string | null }[];
  incidents: { title: string; declaredAt: string; latestUpdate: { body: string; at: string } | null; nextUpdateDueAt: string | null }[];
}
export interface StatusToken {
  id: string;
  customerId: string;
  label: string;
  tokenPrefix: string;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export const announcementKeys = {
  all: ['announcements'] as const,
  active: ['announcements', 'active'] as const,
  list: (params: Record<string, unknown>) => ['announcements', 'list', params] as const,
  tokens: (customerId: string) => ['announcements', 'tokens', customerId] as const,
};

export const announcementsApi = {
  active: () => get<{ items: Announcement[] }>('/announcements/active'),
  list: (params: Record<string, unknown>) => get<{ items: AnnouncementRow[]; total: number; page: number; pageSize: number }>('/announcements', params),
  create: (body: AnnouncementInput) => post<Announcement>('/announcements', body),
  update: (id: string, body: Partial<AnnouncementInput>) => patch<Announcement>(`/announcements/${id}`, body),
  remove: (id: string) => del(`/announcements/${id}`),
  draft: (body: { ticketId?: string; type?: AnnouncementType; audience?: AnnouncementAudience; notes?: string }) => post<AnnouncementDraft>('/ai/announcements/draft', body),
  portalStatus: (customerId?: string) => get<PortalStatus>('/portal/status', customerId ? { customerId } : undefined),
  tokens: (customerId: string) => get<{ items: StatusToken[] }>(`/customers/${customerId}/status-tokens`),
  createToken: (body: { customerId: string; label: string }) => post<StatusToken & { token: string; url: string }>('/status-tokens', body),
  revokeToken: (id: string) => post<StatusToken>(`/status-tokens/${id}/revoke`, {}),
  deleteToken: (id: string) => del(`/status-tokens/${id}`),
};

/** The public page needs no session: a plain fetch against the API. */
export async function fetchPublicStatus(token: string): Promise<PublicStatus | null> {
  const res = await fetch(`/api/public/status/${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Status page unavailable (${res.status})`);
  return (await res.json()) as PublicStatus;
}
