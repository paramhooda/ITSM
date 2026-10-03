import { get, post, patch, del } from '@/api/client';

/** Shift handover: team shifts, the live digest and the handover notes. */

export interface TeamShift {
  id: string;
  teamId: string;
  name: string;
  startTime: string;
  endTime: string;
  days: number[];
  timezone: string;
  sortOrder: number;
  isActive: boolean;
}

export interface DigestTicket {
  id: string;
  number: string;
  title: string;
  priority: string | null;
  status: string | null;
  customer: string | null;
  assignee: string | null;
  slaDueAt: string | null;
  breachRisk: string | null;
}

export interface HandoverFacts {
  generatedAt: string;
  team: { id: string; name: string };
  counts: { open: number; p1p2: number; breached: number; atRisk: number; unassigned: number; awaitingCustomer: number; major: number; changesNext: number; openedInShift: number; resolvedInShift: number };
  tickets: { key: 'p1p2' | 'breached' | 'atRisk' | 'awaitingCustomer' | 'unassigned'; title: string; items: DigestTicket[] }[];
  major: { id: string; number: string; title: string; status: string | null; customer: string | null; commander: string | null; nextUpdateAt: string | null }[];
  changes: { id: string; number: string; title: string; customer: string | null; scheduledStart: string | null; scheduledEnd: string | null; changeType: string | null }[];
  onCall: { now: { userId: string; name: string; rota: string | null; until: string | null }[]; next: { userId: string; name: string; rota: string | null; from: string | null }[] };
  window: { from: string; to: string };
}

export type HandoverStatus = 'draft' | 'final' | 'acknowledged';

export interface Handover {
  id: string;
  teamId: string;
  teamName: string | null;
  shiftId: string | null;
  shiftName: string | null;
  shiftDate: string;
  authorId: string | null;
  authorName: string | null;
  status: HandoverStatus;
  aiDraft: string | null;
  body: string;
  facts: HandoverFacts | null;
  publishedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  acknowledgementNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HandoverTeam {
  id: string;
  key: string;
  name: string;
  teamType: string;
  /** Whether the person may write a handover for this team (member, or handover:write across teams). */
  canWrite: boolean;
  shifts: TeamShift[];
  /** The shift running now in its timezone, and the one after it. */
  current: (TeamShift & { shiftDate: string; endsAt: string }) | null;
  next: (TeamShift & { shiftDate: string; startsAt: string }) | null;
  latest: Pick<Handover, 'id' | 'status' | 'shiftDate' | 'shiftName' | 'authorName' | 'publishedAt' | 'acknowledgedAt'> | null;
  /** Published handovers nobody has acknowledged yet. */
  unacknowledged: number;
}

export interface HandoverDraft {
  body: string;
  facts: HandoverFacts;
  /** True when the assistant wrote the text; false for the deterministic draft. */
  ai: boolean;
}

export const handoverKeys = {
  teams: ['handover', 'teams'] as const,
  shifts: (teamId?: string) => ['handover', 'shifts', teamId ?? 'all'] as const,
  digest: (teamId: string) => ['handover', 'digest', teamId] as const,
  list: (params: Record<string, unknown>) => ['handover', 'list', params] as const,
  one: (id: string) => ['handover', 'one', id] as const,
};

export const handoverApi = {
  teams: () => get<{ items: HandoverTeam[] }>('/handover/teams'),
  shifts: (teamId?: string) => get<{ items: TeamShift[] }>(`/handover/shifts${teamId ? `?teamId=${teamId}` : ''}`),
  createShift: (body: Partial<TeamShift> & { teamId: string; name: string; startTime: string; endTime: string }) => post<TeamShift>('/handover/shifts', body),
  updateShift: (id: string, body: Partial<TeamShift>) => patch<TeamShift>(`/handover/shifts/${id}`, body),
  deleteShift: (id: string) => del<{ ok: true }>(`/handover/shifts/${id}`),
  digest: (teamId: string) => get<HandoverFacts>(`/handover/digest?teamId=${teamId}`),
  draft: (body: { teamId: string; notes?: string }) => post<HandoverDraft>('/handover/draft', body),
  list: (params: { teamId?: string; status?: string; page?: number; pageSize?: number }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    const s = q.toString();
    return get<{ items: Handover[]; total: number; page: number; pageSize: number }>(`/handover${s ? `?${s}` : ''}`);
  },
  one: (id: string) => get<Handover>(`/handover/${id}`),
  create: (body: { teamId: string; shiftId?: string | null; shiftDate?: string; body: string; aiDraft?: string | null; facts?: HandoverFacts | null; publish?: boolean }) => post<Handover>('/handover', body),
  update: (id: string, body: { body?: string; shiftId?: string | null; shiftDate?: string }) => patch<Handover>(`/handover/${id}`, body),
  publish: (id: string) => post<Handover>(`/handover/${id}/publish`, {}),
  acknowledge: (id: string, body: { note?: string } = {}) => post<Handover>(`/handover/${id}/acknowledge`, body),
  remove: (id: string) => del<{ ok: true }>(`/handover/${id}`),
};
