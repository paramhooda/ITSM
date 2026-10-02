import { api, get, post, patch, del } from '@/api/client';
import type { VisitListRow, VisitDetail, Part, VisitNote, CalendarVisit, VisitSummary, Workload, Paginated } from './types';

/** Query keys: ['field', ...] so mutations can invalidate the module. */
export const fieldKeys = {
  all: ['field'] as const,
  list: (params: Record<string, unknown>) => ['field', 'list', params] as const,
  calendar: (params: Record<string, unknown>) => ['field', 'calendar', params] as const,
  summary: (params: Record<string, unknown>) => ['field', 'summary', params] as const,
  workload: (params: Record<string, unknown>) => ['field', 'workload', params] as const,
  detail: (id: string) => ['field', 'visit', id] as const,
};

export const fieldApi = {
  list: (params: Record<string, unknown>) => get<Paginated<VisitListRow>>('/field/visits', params),
  calendar: (params: Record<string, unknown>) => get<{ items: CalendarVisit[] }>('/field/visits/calendar', params),
  summary: (params: Record<string, unknown>) => get<VisitSummary>('/field/summary', params),
  workload: (params: Record<string, unknown>) => get<Workload>('/field/engineers/workload', params),
  get: (id: string) => get<VisitDetail>(`/field/visits/${id}`),
  create: (body: Record<string, unknown>) => post<VisitDetail>('/field/visits', body),
  update: (id: string, body: Record<string, unknown>) => patch<VisitDetail>(`/field/visits/${id}`, body),
  schedule: (id: string, body: Record<string, unknown>) => post<VisitDetail>(`/field/visits/${id}/schedule`, body),
  start: (id: string) => post<VisitDetail>(`/field/visits/${id}/start`, {}),
  complete: (id: string, body: Record<string, unknown>) => post<VisitDetail>(`/field/visits/${id}/complete`, body),
  cancel: (id: string, reason: string) => post<VisitDetail>(`/field/visits/${id}/cancel`, { reason }),
  reschedule: (id: string, body: Record<string, unknown>) => post<VisitDetail>(`/field/visits/${id}/reschedule`, body),
  acknowledge: (id: string, body: Record<string, unknown>) => post<VisitDetail>(`/field/visits/${id}/acknowledge`, body),
  parts: (id: string) => get<{ items: Part[] }>(`/field/visits/${id}/parts`),
  addPart: (id: string, body: Record<string, unknown>) => post<Part>(`/field/visits/${id}/parts`, body),
  updatePart: (partId: string, body: Record<string, unknown>) => patch<Part>(`/field/parts/${partId}`, body),
  deletePart: (partId: string) => del(`/field/parts/${partId}`),
  notes: (id: string) => get<{ items: VisitNote[] }>(`/field/visits/${id}/notes`),
  addNote: (id: string, body: { body: string; isInternal?: boolean }) => post<VisitNote>(`/field/visits/${id}/notes`, body),
  generateReport: (id: string) => post<{ attachment: { id: string; filename: string }; reportGeneratedAt: string; visit: VisitDetail }>(`/field/visits/${id}/report`, {}),
  reportUrl: (id: string) => `/api/field/visits/${id}/report.html`,
};

/** Opens the printable report in a new tab (fetched with the bearer token, then shown from a blob URL). */
export async function openVisitReport(id: string) {
  const res = await api<Response>(`/field/visits/${id}/report.html`, { raw: true });
  if (!res.ok) throw new Error('Could not load the report');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank', 'noopener');
  if (!w) window.location.assign(url);
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
