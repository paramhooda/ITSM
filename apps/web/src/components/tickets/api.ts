import { get, post, put, patch, del } from '@/api/client';
import type { TicketDetail, TicketListRow, TicketStats, TimelineEntry, SimilarTicket, SavedView, TimeEntry, Task, Approval, SlaMetricSummary, ProblemDetails, ChangeDetails } from './types';

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Query keys: ['tickets', ...] so mutations can invalidate the module. */
export const qk = {
  list: (params: Record<string, unknown>) => ['tickets', 'list', params] as const,
  stats: (params: Record<string, unknown>) => ['tickets', 'stats', params] as const,
  detail: (id: string) => ['tickets', id] as const,
  timeline: (id: string) => ['tickets', id, 'timeline'] as const,
  time: (id: string) => ['tickets', id, 'time'] as const,
  similar: (id: string) => ['tickets', id, 'similar'] as const,
  approvals: (id: string) => ['tickets', id, 'approvals'] as const,
  views: ['tickets', 'saved-views'] as const,
  mine: ['approvals', 'mine'] as const,
};

/** Accepts `{ items }` or a bare array from cross-module endpoints. */
export const itemsOf = <T>(d: unknown): T[] => (Array.isArray(d) ? (d as T[]) : ((d as { items?: T[] } | undefined)?.items ?? []));

export const ticketsApi = {
  list: (params: Record<string, unknown>) => get<Paginated<TicketListRow>>('/tickets', params),
  stats: (params: Record<string, unknown>) => get<TicketStats>('/tickets/stats', params),
  get: (id: string) => get<TicketDetail>(`/tickets/${id}`),
  create: (body: Record<string, unknown>) => post<TicketDetail>('/tickets', body),
  update: (id: string, body: Record<string, unknown>) => patch<TicketDetail>(`/tickets/${id}`, body),
  status: (id: string, body: Record<string, unknown>) => post<TicketDetail>(`/tickets/${id}/status`, body),
  resolve: (id: string, body: Record<string, unknown>) => post<TicketDetail>(`/tickets/${id}/resolve`, body),
  close: (id: string, body: Record<string, unknown> = {}) => post<TicketDetail>(`/tickets/${id}/close`, body),
  reopen: (id: string, body: Record<string, unknown> = {}) => post<TicketDetail>(`/tickets/${id}/reopen`, body),
  cancel: (id: string, body: Record<string, unknown> = {}) => post<TicketDetail>(`/tickets/${id}/cancel`, body),
  assign: (id: string, body: Record<string, unknown>) => post<TicketDetail>(`/tickets/${id}/assign`, body),
  escalate: (id: string, body: Record<string, unknown>) => post<TicketDetail>(`/tickets/${id}/escalate`, body),
  scope: (id: string, body: Record<string, unknown>) => post<TicketDetail>(`/tickets/${id}/scope`, body),
  scopePreview: (body: Record<string, unknown>) => post<{ status: string; reason: string; contract: { id: string; number: string; name: string; slaPolicyName: string | null } | null }>('/tickets/scope-preview', body),
  timeline: (id: string) => get<{ items: TimelineEntry[] }>(`/tickets/${id}/timeline`),
  comment: (id: string, body: Record<string, unknown>) => post(`/tickets/${id}/comments`, body),
  slas: (id: string) => get<{ items: SlaMetricSummary[] }>(`/tickets/${id}/slas`),
  similar: (id: string) => get<{ items: SimilarTicket[] }>(`/tickets/${id}/similar`),
  lookup: (q: string, customerId?: string | null, excludeId?: string | null) => get<{ items: { id: string; number: string; title: string; type: string; status: { label: string; color: string | null } | null }[] }>('/tickets/lookup', { q, customerId: customerId ?? undefined, excludeId: excludeId ?? undefined }),
  addLink: (id: string, body: Record<string, unknown>) => post<TicketDetail>(`/tickets/${id}/links`, body),
  removeLink: (id: string, linkId: string) => del<TicketDetail>(`/tickets/${id}/links/${linkId}`),
  setCis: (id: string, ids: string[]) => put(`/tickets/${id}/cis`, { ids }),
  setAssets: (id: string, ids: string[]) => put(`/tickets/${id}/assets`, { ids }),
  tasks: (id: string) => get<{ items: Task[] }>(`/tickets/${id}/tasks`),
  addTask: (id: string, body: Record<string, unknown>) => post<Task>(`/tickets/${id}/tasks`, body),
  updateTask: (id: string, taskId: string, body: Record<string, unknown>) => patch<Task>(`/tickets/${id}/tasks/${taskId}`, body),
  deleteTask: (id: string, taskId: string) => del(`/tickets/${id}/tasks/${taskId}`),
  time: (id: string) => get<{ items: TimeEntry[]; totalMinutes: number; billableMinutes: number }>(`/tickets/${id}/time`),
  addTime: (id: string, body: Record<string, unknown>) => post<TimeEntry>(`/tickets/${id}/time`, body),
  deleteTime: (id: string, entryId: string) => del(`/tickets/${id}/time/${entryId}`),
  watch: (id: string, userId?: string) => post(`/tickets/${id}/watchers`, userId ? { userId } : {}),
  unwatch: (id: string, userId?: string) => del(`/tickets/${id}/watchers${userId ? `/${userId}` : ''}`),
  approvals: (id: string) => get<{ items: Approval[]; approvalStatus: string | null }>(`/tickets/${id}/approvals`),
  decide: (id: string, approvalId: string, body: Record<string, unknown>) => post<{ items: Approval[]; approvalStatus: string | null }>(`/tickets/${id}/approvals/${approvalId}/decide`, body),
  requestApproval: (id: string, body: Record<string, unknown> = {}) => post(`/tickets/${id}/request-approval`, body),
  problem: (id: string, body: Record<string, unknown>) => patch<ProblemDetails>(`/tickets/${id}/problem`, body),
  change: (id: string, body: Record<string, unknown>) => patch<ChangeDetails>(`/tickets/${id}/change`, body),
  bulk: (body: Record<string, unknown>) => post<{ succeeded: number; failed: number }>('/tickets/bulk', body),
  views: () => get<{ items: SavedView[] }>('/saved-views', { entity: 'ticket' }),
  createView: (body: Record<string, unknown>) => post<SavedView>('/saved-views', body),
  updateView: (id: string, body: Record<string, unknown>) => patch<SavedView>(`/saved-views/${id}`, body),
  deleteView: (id: string) => del(`/saved-views/${id}`),
};
