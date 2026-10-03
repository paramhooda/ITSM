import { get, post, patch, put, del } from '@/api/client';

/** API shapes of the on-call module (mirrors apps/api/src/modules/oncall). */

export type Channel = 'email' | 'in_app' | 'whatsapp';
export const CHANNEL_LABELS: Record<Channel, string> = { email: 'Email', in_app: 'In-app', whatsapp: 'WhatsApp' };

export interface EscalationStep {
  target: 'oncall' | 'user' | 'team' | 'manager';
  userId?: string | null;
  teamId?: string | null;
  channels: Channel[];
  timeoutMinutes: number;
  userName?: string | null;
  teamName?: string | null;
}
export const STEP_TARGET_LABELS: Record<EscalationStep['target'], string> = { oncall: 'Whoever is on call', user: 'A named person', team: 'Every team member', manager: 'The team manager' };

export interface Participant {
  userId: string;
  position: number;
  name: string;
  email: string;
  phone: string | null;
}

export interface Rota {
  id: string;
  teamId: string;
  teamName?: string;
  name: string;
  description: string | null;
  timezone: string;
  rotation: 'weekly' | 'daily' | 'custom';
  rotationDays: number;
  periodDays: number;
  handoffTime: string;
  shiftStart: string | null;
  shiftEnd: string | null;
  startDate: string;
  sortOrder: number;
  isActive: boolean;
  participants: Participant[];
  createdAt: string;
  updatedAt: string;
}

export interface RotaBody {
  teamId: string;
  name: string;
  description?: string | null;
  timezone?: string;
  rotation?: Rota['rotation'];
  rotationDays?: number;
  handoffTime?: string;
  shiftStart?: string | null;
  shiftEnd?: string | null;
  startDate: string;
  sortOrder?: number;
  isActive?: boolean;
  participants?: string[];
}

export interface Override {
  id: string;
  rotaId: string;
  rotaName: string;
  teamId: string;
  userId: string;
  userName: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  mine: boolean;
}

export interface Policy {
  id: string;
  name: string;
  description: string | null;
  steps: EscalationStep[];
  repeatCount: number;
  assignOnAck: boolean;
  isActive: boolean;
  teams: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface PolicyBody {
  name: string;
  description?: string | null;
  steps: EscalationStep[];
  repeatCount?: number;
  assignOnAck?: boolean;
  isActive?: boolean;
}

export interface OnCallRota {
  id: string;
  name: string;
  timezone: string;
  user: { id: string; name: string; email: string; phone: string | null } | null;
  until: string | null;
  override: { id: string; reason: string | null } | null;
}

export interface OnCallTeam {
  id: string;
  name: string;
  teamType: string;
  managerUserId: string | null;
  managerName: string | null;
  escalationPolicyId: string | null;
  escalationPolicyName: string | null;
  rotas: OnCallRota[];
}

export interface OnCallNow {
  generatedAt: string;
  teams: OnCallTeam[];
}

export interface Shift {
  rotaId: string;
  userId: string | null;
  userName: string | null;
  start: string;
  end: string;
  overrideId: string | null;
  cycle: number | null;
}

export interface Schedule {
  team: { id: string; name: string; teamType: string; escalationPolicyId: string | null };
  from: string;
  to: string;
  rotas: Rota[];
  shifts: Shift[];
  overrides: Override[];
}

export type PageStatus = 'pending' | 'acked' | 'escalated' | 'expired' | 'cancelled';
export const PAGE_STATUS_LABELS: Record<PageStatus, string> = { pending: 'Waiting', acked: 'Acknowledged', escalated: 'Escalated', expired: 'Not acknowledged', cancelled: 'Cancelled' };
export const PAGE_STATUS_COLORS: Record<PageStatus, string> = { pending: 'amber', acked: 'emerald', escalated: 'slate', expired: 'red', cancelled: 'gray' };

export interface Page {
  id: string;
  ticketId: string;
  policyId: string | null;
  policyName: string | null;
  steps: number | null;
  rootPageId: string | null;
  step: number;
  cycle: number;
  targetKind: EscalationStep['target'];
  targetUserId: string | null;
  targetName: string | null;
  targetTeamId: string | null;
  targetTeamName: string | null;
  channels: Channel[];
  status: PageStatus;
  source: 'rule' | 'manual' | 'ai';
  reason: string | null;
  expiresAt: string | null;
  ackedBy: string | null;
  ackedByName: string | null;
  ackedAt: string | null;
  closedAt: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  ticket: { id: string; number: string; title: string } | null;
}

export const oncallKeys = {
  all: ['oncall'] as const,
  now: (teamId?: string | null) => ['oncall', 'now', teamId ?? 'all'] as const,
  schedule: (params: Record<string, unknown>) => ['oncall', 'schedule', params] as const,
  rotas: (teamId?: string | null) => ['oncall', 'rotas', teamId ?? 'all'] as const,
  overrides: (params: Record<string, unknown>) => ['oncall', 'overrides', params] as const,
  policies: ['oncall', 'policies'] as const,
  pages: (params: Record<string, unknown>) => ['oncall', 'pages', params] as const,
};

export const oncallApi = {
  now: (teamId?: string | null) => get<OnCallNow>('/oncall/now', teamId ? { teamId } : undefined),
  schedule: (params: { teamId: string; from: string; to: string }) => get<Schedule>('/oncall/schedule', params),
  rotas: (teamId?: string | null) => get<Rota[]>('/oncall/rotas', teamId ? { teamId } : undefined),
  createRota: (body: RotaBody) => post<Rota>('/oncall/rotas', body),
  updateRota: (id: string, body: Partial<RotaBody>) => patch<Rota>(`/oncall/rotas/${id}`, body),
  deleteRota: (id: string) => del(`/oncall/rotas/${id}`),
  overrides: (params: Record<string, unknown>) => get<Override[]>('/oncall/overrides', params),
  createOverride: (body: { rotaId: string; userId: string; startsAt: string; endsAt: string; reason?: string | null }) => post<Override>('/oncall/overrides', body),
  deleteOverride: (id: string) => del(`/oncall/overrides/${id}`),
  policies: () => get<Policy[]>('/oncall/policies'),
  createPolicy: (body: PolicyBody) => post<Policy>('/oncall/policies', body),
  updatePolicy: (id: string, body: Partial<PolicyBody>) => patch<Policy>(`/oncall/policies/${id}`, body),
  deletePolicy: (id: string) => del(`/oncall/policies/${id}`),
  setTeamPolicy: (teamId: string, policyId: string | null) => put(`/oncall/teams/${teamId}/policy`, { policyId }),
  pages: (params: Record<string, unknown>) => get<{ items: Page[] }>('/oncall/pages', params),
  page: (body: { ticketId: string; policyId?: string | null; reason?: string | null }) => post<Page>('/oncall/pages', body),
  ack: (id: string, note?: string | null) => post<Page>(`/oncall/pages/${id}/ack`, { note: note ?? null }),
  cancel: (id: string, reason?: string | null) => post<Page>(`/oncall/pages/${id}/cancel`, { reason: reason ?? null }),
};

/** "Hands over every Monday at 09:00" from a rota's fields. */
export function describeRotation(r: Pick<Rota, 'rotation' | 'rotationDays' | 'handoffTime' | 'startDate' | 'shiftStart' | 'shiftEnd'>) {
  const day = new Date(`${r.startDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long' });
  const cadence = r.rotation === 'daily' ? 'every day' : r.rotation === 'weekly' ? `every ${day}` : `every ${r.rotationDays} days`;
  const window = r.shiftStart && r.shiftEnd ? `, covering ${r.shiftStart}–${r.shiftEnd}` : ', around the clock';
  return `Hands over ${cadence} at ${r.handoffTime}${window}`;
}
