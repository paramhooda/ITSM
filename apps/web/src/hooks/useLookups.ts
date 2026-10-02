import { useQuery } from '@tanstack/react-query';
import { get } from '@/api/client';

export interface ConfigOption {
  id: string;
  type: string;
  key: string;
  label: string;
  description?: string | null;
  parentId?: string | null;
  domain: string;
  statusCategory?: string | null;
  pausesSla: boolean;
  level?: number | null;
  color?: string | null;
  icon?: string | null;
  sortOrder: number;
  isDefault: boolean;
  isSystem: boolean;
  isActive: boolean;
  appliesTo: string[];
  metadata: Record<string, unknown>;
}

export interface Lookups {
  options: Record<string, ConfigOption[]>;
  teams: { id: string; key: string; name: string; teamType: string }[];
  ciTypes: { id: string; key: string; name: string; icon?: string | null; color?: string | null; attributeSchema: Record<string, unknown>[] }[];
  relationshipTypes: { id: string; key: string; name: string; inverseName: string }[];
  slaPolicies: { id: string; name: string; isDefault: boolean }[];
  calendars: { id: string; name: string; timezone: string; is24x7: boolean }[];
  services: { id: string; key: string; name: string; domain: string; categoryId?: string | null }[];
  settings: Record<string, unknown>;
}

/** All configurable option lists in one cached call (used by forms, filters and badges). */
export function useLookups() {
  const q = useQuery({ queryKey: ['lookups'], queryFn: () => get<Lookups>('/config/lookups'), staleTime: 5 * 60_000 });
  const options = (type: string, opts?: { ticketType?: string; domain?: string; parentId?: string | null; includeInactive?: boolean }) => {
    const list = q.data?.options[type] ?? [];
    return list.filter((o) => {
      if (!opts?.includeInactive && !o.isActive) return false;
      if (opts?.ticketType && o.appliesTo.length && !o.appliesTo.includes(opts.ticketType)) return false;
      if (opts?.domain && o.domain !== 'general' && o.domain !== opts.domain) return false;
      if (opts?.parentId !== undefined && o.parentId !== opts.parentId) return false;
      return true;
    });
  };
  const byId = (id?: string | null) => {
    if (!id || !q.data) return undefined;
    for (const list of Object.values(q.data.options)) {
      const hit = list.find((o) => o.id === id);
      if (hit) return hit;
    }
    return undefined;
  };
  const byKey = (type: string, key: string) => q.data?.options[type]?.find((o) => o.key === key);
  const team = (id?: string | null) => q.data?.teams.find((t) => t.id === id);
  const service = (id?: string | null) => q.data?.services.find((s) => s.id === id);
  const ciType = (id?: string | null) => q.data?.ciTypes.find((t) => t.id === id);
  return { ...q, lookups: q.data, options, byId, byKey, team, service, ciType };
}

export function useEngineers() {
  return useQuery({ queryKey: ['engineers'], queryFn: () => get<{ id: string; name: string; email: string; title?: string | null; teamIds: string[] }[]>('/iam/directory/engineers'), staleTime: 60_000 });
}

export function useCustomersLookup() {
  return useQuery({ queryKey: ['customers', 'lookup'], queryFn: () => get<{ items: { id: string; code: string; name: string }[] }>('/customers', { pageSize: 500, sort: 'name', order: 'asc', fields: 'min' }), staleTime: 60_000 });
}
