import { get } from '@/api/client';
import type { AssetsOverview, CustomersOverview, ContractsOverview, EntitlementRow, FieldOverview, KnowledgeOverview, SoftwareOverview } from './types';

export type { AssetsOverview, CustomersOverview, ContractsOverview, EntitlementRow, FieldOverview, KnowledgeOverview, SoftwareOverview, Bucket, CoverageBuckets, SeriesPoint } from './types';

/** Filters of the paged entitlements list (`GET /contracts/entitlements`). */
export interface EntitlementListParams {
  page?: number;
  pageSize?: number;
  q?: string;
  customerId?: string;
  /** ok · over_threshold · exhausted */
  status?: string;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface EntitlementList {
  items: EntitlementRow[];
  total: number;
  page: number;
  pageSize: number;
}

const clean = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/** Query keys: ['overview', <module>, …] so a module can be invalidated as a whole. */
export const ovKeys = {
  all: ['overview'] as const,
  assets: (customerId?: string) => ['overview', 'assets', customerId ?? ''] as const,
  customers: ['overview', 'customers'] as const,
  contracts: (customerId?: string) => ['overview', 'contracts', customerId ?? ''] as const,
  entitlements: (params: EntitlementListParams) => ['overview', 'entitlements', clean(params as Record<string, unknown>)] as const,
  field: (customerId?: string) => ['overview', 'field', customerId ?? ''] as const,
  knowledge: ['overview', 'knowledge'] as const,
  software: (customerId?: string) => ['overview', 'software', customerId ?? ''] as const,
};

export const overviewApi = {
  assets: (customerId?: string) => get<AssetsOverview>('/assets/overview', { customerId: customerId || undefined }),
  customers: () => get<CustomersOverview>('/customers/overview'),
  contracts: (customerId?: string) => get<ContractsOverview>('/contracts/overview', { customerId: customerId || undefined }),
  entitlements: (params: EntitlementListParams) => get<EntitlementList>('/contracts/entitlements', clean(params as Record<string, unknown>)),
  field: (customerId?: string) => get<FieldOverview>('/field/overview', { customerId: customerId || undefined }),
  knowledge: () => get<KnowledgeOverview>('/knowledge/overview'),
  software: (customerId?: string) => get<SoftwareOverview>('/software/overview', { customerId: customerId || undefined }),
};

/** Links built from a bucket key: option ids go straight into list filters, anything else falls back to the plain list. */
export const isUuid = (v: string | null | undefined) => !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Appends a querystring fragment, keeping the URL valid whether or not it already has one. */
export const withQuery = (path: string, params: Record<string, string | number | undefined | null>) => {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
};

/** Days until an ISO date (negative when past), measured from local midnight. */
export const daysUntil = (iso: string) => Math.round((new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);

export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
