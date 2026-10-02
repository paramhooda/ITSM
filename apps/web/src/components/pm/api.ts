import { get, post, patch, del } from '@/api/client';
import type { ProgramRow, ProgramDetail, OccurrenceRow, PmSummary, Paginated } from './types';

/** Query keys: ['pm', ...] so mutations can invalidate the module. */
export const pmKeys = {
  all: ['pm'] as const,
  programs: (params: Record<string, unknown>) => ['pm', 'programs', params] as const,
  program: (id: string) => ['pm', 'program', id] as const,
  occurrences: (params: Record<string, unknown>) => ['pm', 'occurrences', params] as const,
  occurrence: (id: string) => ['pm', 'occurrence', id] as const,
  summary: (params: Record<string, unknown>) => ['pm', 'summary', params] as const,
  calendar: (params: Record<string, unknown>) => ['pm', 'calendar', params] as const,
};

export const pmApi = {
  programs: (params: Record<string, unknown>) => get<Paginated<ProgramRow>>('/pm/programs', params),
  program: (id: string) => get<ProgramDetail>(`/pm/programs/${id}`),
  createProgram: (body: Record<string, unknown>) => post<ProgramDetail>('/pm/programs', body),
  updateProgram: (id: string, body: Record<string, unknown>) => patch<ProgramDetail>(`/pm/programs/${id}`, body),
  regenerate: (id: string) => post<{ removed: number; created: number; program: ProgramDetail }>(`/pm/programs/${id}/regenerate`, {}),
  deleteProgram: (id: string) => del<{ deleted?: boolean; deactivated?: boolean }>(`/pm/programs/${id}`),
  occurrences: (params: Record<string, unknown>) => get<Paginated<OccurrenceRow>>('/pm/occurrences', params),
  occurrence: (id: string) => get<OccurrenceRow & { checklist: { item: string; required?: boolean }[] }>(`/pm/occurrences/${id}`),
  schedule: (id: string, body: Record<string, unknown>) => post<OccurrenceRow>(`/pm/occurrences/${id}/schedule`, body),
  complete: (id: string, body: Record<string, unknown>) => post<OccurrenceRow>(`/pm/occurrences/${id}/complete`, body),
  reschedule: (id: string, body: Record<string, unknown>) => post<OccurrenceRow>(`/pm/occurrences/${id}/reschedule`, body),
  cancel: (id: string, reason: string) => post<OccurrenceRow>(`/pm/occurrences/${id}/cancel`, { reason }),
  createTicket: (id: string, body: Record<string, unknown> = {}) => post<{ ticket: { id: string; number: string; title: string }; occurrence: OccurrenceRow }>(`/pm/occurrences/${id}/create-ticket`, body),
  summary: (params: Record<string, unknown>) => get<PmSummary>('/pm/summary', params),
  calendar: (params: Record<string, unknown>) => get<{ items: OccurrenceRow[] }>('/pm/calendar', params),
};
