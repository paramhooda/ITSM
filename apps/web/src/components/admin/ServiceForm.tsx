import { DOMAINS } from '@itsm/shared';
import { useLookups, useEngineers } from '@/hooks/useLookups';
import type { FieldSpec, Values } from './FormDialog';

/** Service catalog types + the editor field spec shared by the admin list and the browse page. */

export interface Service {
  id: string;
  key: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryLabel: string | null;
  subcategoryId: string | null;
  subcategoryLabel: string | null;
  statusId: string | null;
  statusLabel: string | null;
  statusColor: string | null;
  domain: string;
  defaultTeamId: string | null;
  defaultTeamName: string | null;
  defaultSlaPolicyId: string | null;
  defaultSlaPolicyName: string | null;
  defaultTicketCategoryId: string | null;
  defaultTicketCategoryLabel: string | null;
  ciTypeKeys: string[];
  ciTypes: { key: string; name: string }[];
  ownerUserId: string | null;
  ownerName: string | null;
  isActive: boolean;
  counts: { subscribedCustomers: number; activeContracts: number; openTickets: number; incidents30d: number; cis: number };
}

export interface ServiceDetail extends Service {
  subscribedCustomers: { customerId: string; customerName: string; customerCode: string; contractId: string; contractNumber: string; contractName: string; status: string; statusLabel: string; statusColor: string; endDate: string }[];
}

export interface ServicePayload {
  name: string;
  key?: string;
  description: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
  statusId: string | null;
  domain: string;
  defaultTeamId: string | null;
  defaultSlaPolicyId: string | null;
  defaultTicketCategoryId: string | null;
  ciTypeKeys: string[];
  ownerUserId: string | null;
  isActive: boolean;
}

export interface Subcategory { id: string; key: string; label: string; description: string | null; sortOrder: number; isActive: boolean; services: Service[] }
export interface Category { id: string; key: string; label: string; description: string | null; icon: string | null; color: string | null; sortOrder: number; isActive: boolean; subcategories: Subcategory[]; services: Service[] }
export interface Catalog { categories: Category[]; uncategorised: Service[]; totals: { services: number; subscribedCustomers: number; openTickets: number; incidents30d: number } }

export const DOMAIN_LABEL: Record<string, string> = { noc: 'NOC', soc: 'SOC', amc: 'AMC', service_desk: 'Service desk', general: 'General' };

/** Every service in a catalog response, flattened in display order. */
export function flattenCatalog(c: Catalog | undefined): Service[] {
  if (!c) return [];
  return [...c.categories.flatMap((cat) => [...cat.subcategories.flatMap((s) => s.services), ...cat.services]), ...c.uncategorised];
}

/** Field spec for the service editor (same for create and edit). */
export function useServiceFields(): FieldSpec<Values>[] {
  const { lookups, options } = useLookups();
  const engineers = useEngineers();
  return [
    { key: 'name', label: 'Name', type: 'text', required: true, span: 2 },
    { key: 'key', label: 'Key', type: 'key', placeholder: 'network_management', hint: 'Generated from the name when blank', disabled: (v) => !!v.id },
    { key: 'domain', label: 'Domain', type: 'select', required: true, options: DOMAINS.map((d) => ({ value: d, label: DOMAIN_LABEL[d] ?? d })) },
    { key: 'categoryId', label: 'Service line', type: 'select', hint: 'Main header in the catalog', options: options('service_category').map((c) => ({ value: c.id, label: c.label })) },
    { key: 'subcategoryId', label: 'Offering group', type: 'select', hint: 'Sub-section under the service line', disabled: (v) => !v.categoryId, options: (v) => (v.categoryId ? options('service_subcategory', { parentId: v.categoryId as string }).map((c) => ({ value: c.id, label: c.label })) : []) },
    { key: 'statusId', label: 'Status', type: 'select', options: options('service_status').map((c) => ({ value: c.id, label: c.label })) },
    { key: 'defaultTeamId', label: 'Default team', type: 'select', options: (lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name })) },
    { key: 'defaultSlaPolicyId', label: 'Default SLA policy', type: 'select', placeholder: 'Platform default', options: (lookups?.slaPolicies ?? []).map((p) => ({ value: p.id, label: p.name })) },
    { key: 'defaultTicketCategoryId', label: 'Default ticket category', type: 'select', options: options('ticket_category').map((o) => ({ value: o.id, label: o.label })) },
    { key: 'ownerUserId', label: 'Owner', type: 'select', options: (engineers.data ?? []).map((u) => ({ value: u.id, label: u.name })) },
    { key: 'description', label: 'Description', type: 'textarea', rows: 3 },
    { key: 'ciTypeKeys', label: 'CI types covered', type: 'multiselect', options: (lookups?.ciTypes ?? []).map((t) => ({ value: t.key, label: t.name })) },
    { key: 'isActive', label: 'Active', type: 'boolean', visible: (v) => !!v.id, placeholder: 'Shown in the catalog and selectable on contracts' },
  ];
}

export function serviceInitial(s: Service | null, defaultStatusId: string | null): Values {
  return s
    ? { id: s.id, name: s.name, key: s.key, description: s.description ?? '', categoryId: s.categoryId, subcategoryId: s.subcategoryId, statusId: s.statusId, domain: s.domain, defaultTeamId: s.defaultTeamId, defaultSlaPolicyId: s.defaultSlaPolicyId, defaultTicketCategoryId: s.defaultTicketCategoryId, ciTypeKeys: s.ciTypeKeys, ownerUserId: s.ownerUserId, isActive: s.isActive }
    : { name: '', key: '', description: '', categoryId: null, subcategoryId: null, statusId: defaultStatusId, domain: 'general', defaultTeamId: null, defaultSlaPolicyId: null, defaultTicketCategoryId: null, ciTypeKeys: [], ownerUserId: null, isActive: true };
}

export function toServicePayload(v: Values, subcategoryIdsFor: (categoryId: string) => string[]): ServicePayload {
  const categoryId = (v.categoryId as string) || null;
  const subcategoryId = (v.subcategoryId as string) || null;
  return {
    name: String(v.name ?? '').trim(),
    key: String(v.key ?? '').trim() || undefined,
    description: String(v.description ?? '').trim() || null,
    categoryId,
    // A stale offering group from a previous service line is dropped rather than sent.
    subcategoryId: categoryId && subcategoryId && subcategoryIdsFor(categoryId).includes(subcategoryId) ? subcategoryId : null,
    statusId: (v.statusId as string) || null,
    domain: String(v.domain ?? 'general'),
    defaultTeamId: (v.defaultTeamId as string) || null,
    defaultSlaPolicyId: (v.defaultSlaPolicyId as string) || null,
    defaultTicketCategoryId: (v.defaultTicketCategoryId as string) || null,
    ciTypeKeys: (v.ciTypeKeys as string[]) ?? [],
    ownerUserId: (v.ownerUserId as string) || null,
    isActive: v.isActive === undefined ? true : !!v.isActive,
  };
}
