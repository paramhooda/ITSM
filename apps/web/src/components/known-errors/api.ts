import { KNOWN_ERROR_STATUSES, KNOWN_ERROR_STATUS_LABELS, type KnownErrorStatus } from '@itsm/shared';
import { get, post, patch } from '@/api/client';
import type { OptionLabel } from '@/components/tickets/types';
import type { Paginated } from '@/components/tickets/api';

/** API shapes of the known error database (apps/api/src/modules/known-errors). Dates arrive as ISO strings. */

export type { KnownErrorStatus };

export interface KnownErrorRow {
  id: string;
  number: string;
  title: string;
  customerId: string;
  customerName: string;
  serviceId: string | null;
  serviceName: string | null;
  ticketStatus: OptionLabel | null;
  keStatus: KnownErrorStatus;
  keStatusLabel: string;
  workaround: string | null;
  rootCause: string | null;
  fixChange: { id: string; number: string; title: string; status: OptionLabel | null } | null;
  /** Incidents linked through an inbound `problem_of` link. */
  incidents: number;
  portalVisible: boolean;
  publishedAt: string | null;
  identifiedAt: string | null;
  keStatusAt: string | null;
  updatedAt: string;
  assigneeName: string | null;
  kbArticleId: string | null;
}

export interface KnownErrorDetail extends KnownErrorRow {
  symptoms: string | null;
  impactSummary: string | null;
  investigation: string | null;
  permanentFix: string | null;
  customerSummary: string | null;
  customerWorkaround: string | null;
  publishedByName: string | null;
  teamName: string | null;
  cis: { id: string; name: string; hostname: string | null; role: string }[];
  linkedIncidents: { id: string; number: string; title: string; status: OptionLabel | null; createdAt: string; linkId: string }[];
  article: { id: string; number: string; title: string; status: string } | null;
  permissions: { manage: boolean; publish: boolean };
}

export interface KnownErrorStats {
  total: number;
  open: number;
  fixInProgress: number;
  resolved: number;
  retired: number;
  published: number;
  incidentsLinked30d: number;
  byService: { id: string | null; name: string; count: number }[];
  mostLinked: { id: string; number: string; title: string; incidents: number }[];
}

export type KnownErrorSuggestion = KnownErrorRow & { score: number };

/** What a customer sees: the customer wording only, never the internal fields. */
export interface PortalKnownError {
  id: string;
  number: string;
  title: string;
  keStatus: KnownErrorStatus;
  summary: string | null;
  workaround: string | null;
  service: { id: string; name: string } | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface PortalKnownErrorList extends Paginated<PortalKnownError> {
  /** The distinct services of the organisation's published entries, for the Service filter. */
  services: { id: string; name: string }[];
}

export const KE_STATUS_OPTIONS = KNOWN_ERROR_STATUSES.map((value) => ({ value, label: KNOWN_ERROR_STATUS_LABELS[value] }));
/** Customer-facing labels of the same lifecycle. */
export const PORTAL_KE_STATUS_LABELS: Record<string, string> = { open: 'Open issue', fix_in_progress: 'Fix in progress', resolved: 'Resolved', retired: 'Retired' };

export const kedbKeys = {
  all: ['known-errors'] as const,
  list: (p: Record<string, unknown>) => ['known-errors', 'list', p] as const,
  stats: (customerId?: string | null) => ['known-errors', 'stats', customerId ?? 'all'] as const,
  detail: (id: string) => ['known-errors', id] as const,
  suggest: (p: Record<string, unknown>) => ['known-errors', 'suggest', p] as const,
};

export const kedbApi = {
  list: (p: Record<string, unknown>) => get<Paginated<KnownErrorRow>>('/known-errors', p),
  stats: (customerId?: string | null) => get<KnownErrorStats>('/known-errors/stats', { customerId: customerId ?? undefined }),
  get: (id: string) => get<KnownErrorDetail>(`/known-errors/${id}`),
  suggest: (p: Record<string, unknown>) => get<{ items: KnownErrorSuggestion[] }>('/known-errors/suggest', p),
  update: (id: string, body: Record<string, unknown>) => patch<KnownErrorDetail>(`/known-errors/${id}`, body),
  setStatus: (id: string, status: KnownErrorStatus) => post<KnownErrorDetail>(`/known-errors/${id}/status`, { status }),
  publish: (id: string, body: { customerSummary: string; customerWorkaround: string; notify?: boolean }) => post<KnownErrorDetail & { notified: number; first: boolean }>(`/known-errors/${id}/publish`, body),
  unpublish: (id: string) => post<KnownErrorDetail>(`/known-errors/${id}/unpublish`),
};
