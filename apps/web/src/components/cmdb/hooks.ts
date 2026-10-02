import { useQuery } from '@tanstack/react-query';
import { get } from '@/api/client';

export interface SiteMin { id: string; code: string; name: string; isPrimary?: boolean }

/** Sites of a customer for filters/forms. Degrades to an empty list if the customers API is not available. */
export function useSites(customerId?: string | null) {
  return useQuery({
    queryKey: ['customers', customerId, 'sites'],
    queryFn: async () => {
      try {
        const res = await get<{ items?: SiteMin[] } | SiteMin[]>(`/customers/${customerId}/sites`, { pageSize: 500 });
        return Array.isArray(res) ? res : res.items ?? [];
      } catch {
        return [] as SiteMin[];
      }
    },
    enabled: !!customerId,
    staleTime: 60_000,
    retry: false,
  });
}

export interface ContractMin { id: string; number: string; name: string; endDate?: string | null; status?: string }

export function useContracts(customerId?: string | null) {
  return useQuery({
    queryKey: ['contracts', 'lookup', customerId],
    queryFn: async () => {
      try {
        const res = await get<{ items?: ContractMin[] } | ContractMin[]>('/contracts', { customerId, pageSize: 200, fields: 'min' });
        return Array.isArray(res) ? res : res.items ?? [];
      } catch {
        return [] as ContractMin[];
      }
    },
    enabled: !!customerId,
    staleTime: 60_000,
    retry: false,
  });
}

/** Tailwind colour name → hex, for SVG rendering. */
export const COLOR_HEX: Record<string, string> = {
  red: '#ef4444', orange: '#f97316', amber: '#f59e0b', yellow: '#eab308', green: '#10b981', emerald: '#10b981', teal: '#14b8a6', cyan: '#06b6d4', sky: '#0ea5e9', blue: '#3b82f6', indigo: '#6366f1', violet: '#8b5cf6', purple: '#a855f7', rose: '#f43f5e', lime: '#84cc16', slate: '#64748b', gray: '#6b7280',
};
export const colorHex = (c?: string | null) => COLOR_HEX[c ?? ''] ?? COLOR_HEX.slate;

export const CRON_PRESETS = [
  { label: 'Manual only', value: '' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at 02:00', value: '0 2 * * *' },
  { label: 'Weekdays at 06:00', value: '0 6 * * 1-5' },
  { label: 'Weekly (Sunday 03:00)', value: '0 3 * * 0' },
  { label: 'Monthly (1st, 04:00)', value: '0 4 1 * *' },
];

export function errorMessage(err: unknown, fallback = 'Something went wrong') {
  const e = err as { message?: string; details?: { message?: string }[] };
  if (Array.isArray(e?.details) && e.details[0]?.message) return `${e.message}: ${e.details.map((d) => d.message).join('; ')}`;
  return e?.message ?? fallback;
}
