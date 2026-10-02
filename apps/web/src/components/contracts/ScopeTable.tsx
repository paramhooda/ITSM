import { useMemo, useState, type FormEvent } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button, Field, Input, Select, Textarea, EmptyState, Badge } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { ScopeBadge } from './ContractBits';
import type { ScopeGroup, ScopeItem } from './types';
import type { Site } from '@/components/customers/types';

/** Scope items grouped by header with in/out badges, filters and row actions. */
export function ScopeTable({ groups, canManage, onEdit, onDelete, filterable = true }: { groups: ScopeGroup[]; canManage?: boolean; onEdit?: (item: ScopeItem) => void; onDelete?: (item: ScopeItem) => void; filterable?: boolean }) {
  const [q, setQ] = useState('');
  const [cls, setCls] = useState('');
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return groups
      .map((g) => ({ ...g, items: g.items.filter((i) => (!cls || i.classification === cls) && (!term || [i.name, i.description, i.serviceName, i.siteName, i.ticketCategoryLabel, i.ciTypeName, i.categoryLabel].some((v) => v?.toLowerCase().includes(term)))) }))
      .filter((g) => g.items.length);
  }, [groups, q, cls]);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) return <EmptyState title="No scope items" description="Define what is in and out of scope: services, sites, device types, ticket categories." />;
  return (
    <div className="space-y-3">
      {filterable && (
        <div className="flex flex-wrap items-center gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter scope…" className="max-w-xs" />
          <Select value={cls} onChange={(e) => setCls(e.target.value)} placeholder="In & out of scope" options={[{ value: 'in_scope', label: 'In scope' }, { value: 'out_of_scope', label: 'Out of scope' }]} className="w-44" />
          <span className="text-xs text-muted ml-auto">{total} items</span>
        </div>
      )}
      {filtered.map((g) => (
        <div key={g.headerId ?? 'none'} className="card overflow-hidden">
          <div className="px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted bg-surface-2 border-b border-default flex items-center justify-between">
            <span>{g.headerLabel}</span>
            <span className="font-normal normal-case tracking-normal">{g.items.length}</span>
          </div>
          <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
            <thead>
              <tr>
                <th>Item</th>
                <th>Classification</th>
                <th>Applies to</th>
                <th>Category / Type</th>
                <th>Status</th>
                {canManage && <th className="w-20"></th>}
              </tr>
            </thead>
            <tbody>
              {g.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div className="font-medium text-[13px]">{i.name}</div>
                    {i.description && <div className="text-xs text-muted line-clamp-2">{i.description}</div>}
                  </td>
                  <td>
                    <ScopeBadge classification={i.classification} />
                  </td>
                  <td className="text-[12.5px]">
                    <div className="flex flex-wrap gap-1">
                      <Badge color={i.serviceName ? 'blue' : 'slate'}>{i.serviceName ?? 'Any service'}</Badge>
                      <Badge color={i.siteName ? 'indigo' : 'slate'}>{i.siteName ?? 'Any site'}</Badge>
                      {i.ticketCategoryLabel && <Badge color="violet">Cat: {i.ticketCategoryLabel}</Badge>}
                      {i.ciTypeName && <Badge color="teal">CI: {i.ciTypeName}</Badge>}
                      {i.assetCategoryLabel && <Badge color="cyan">Asset: {i.assetCategoryLabel}</Badge>}
                    </div>
                  </td>
                  <td className="text-[12.5px] text-muted">
                    {i.categoryLabel ?? '—'}
                    {i.typeLabel && <span className="text-subtle"> · {i.typeLabel}</span>}
                  </td>
                  <td>{i.statusLabel ? <Badge color="slate" dot>{i.statusLabel}</Badge> : <span className="text-subtle">—</span>}</td>
                  {canManage && (
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" onClick={() => onEdit?.(i)} title="Edit">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => onDelete?.(i)} title="Delete">
                          <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {filtered.length === 0 && <div className="text-[13px] text-muted">No scope items match the filter.</div>}
    </div>
  );
}

export interface ScopeItemPayload {
  name: string;
  description: string | null;
  classification: 'in_scope' | 'out_of_scope';
  headerId: string | null;
  categoryId: string | null;
  typeId: string | null;
  statusId: string | null;
  serviceId: string | null;
  siteId: string | null;
  ticketCategoryId: string | null;
  ciTypeKey: string | null;
  assetCategoryId: string | null;
}

/** Shared dimension/classification selects used by the single and bulk forms. */
function ScopeDimensionFields({ f, set, sites, contractServiceIds }: { f: Record<string, string>; set: (k: string, v: string) => void; sites: Pick<Site, 'id' | 'name' | 'code'>[]; contractServiceIds?: string[] }) {
  const { options, lookups } = useLookups();
  const opt = (type: string) => options(type).map((o) => ({ value: o.id, label: o.label }));
  const services = (lookups?.services ?? []).filter((s) => !contractServiceIds?.length || contractServiceIds.includes(s.id));
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <Field label="Classification" required>
        <Select value={f.classification} onChange={(e) => set('classification', e.target.value)} options={[{ value: 'in_scope', label: 'In scope' }, { value: 'out_of_scope', label: 'Out of scope' }]} />
      </Field>
      <Field label="Header">
        <Select value={f.headerId} onChange={(e) => set('headerId', e.target.value)} placeholder="General" options={opt('scope_header')} />
      </Field>
      <Field label="Category">
        <Select value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)} placeholder="—" options={opt('scope_category')} />
      </Field>
      <Field label="Type">
        <Select value={f.typeId} onChange={(e) => set('typeId', e.target.value)} placeholder="—" options={opt('scope_type')} />
      </Field>
      <Field label="Status">
        <Select value={f.statusId} onChange={(e) => set('statusId', e.target.value)} placeholder="—" options={opt('scope_status')} />
      </Field>
      <Field label="Service" hint="Blank = any covered service">
        <Select value={f.serviceId} onChange={(e) => set('serviceId', e.target.value)} placeholder="Any service" options={services.map((s) => ({ value: s.id, label: s.name }))} />
      </Field>
      <Field label="Site" hint="Blank = any covered site">
        <Select value={f.siteId} onChange={(e) => set('siteId', e.target.value)} placeholder="Any site" options={sites.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }))} />
      </Field>
      <Field label="Ticket category">
        <Select value={f.ticketCategoryId} onChange={(e) => set('ticketCategoryId', e.target.value)} placeholder="Any category" options={opt('ticket_category')} />
      </Field>
      <Field label="CI type">
        <Select value={f.ciTypeKey} onChange={(e) => set('ciTypeKey', e.target.value)} placeholder="Any CI type" options={(lookups?.ciTypes ?? []).map((c) => ({ value: c.key, label: c.name }))} />
      </Field>
      <Field label="Asset category">
        <Select value={f.assetCategoryId} onChange={(e) => set('assetCategoryId', e.target.value)} placeholder="Any asset category" options={opt('asset_category')} />
      </Field>
    </div>
  );
}

const initialDims = (initial?: Partial<ScopeItem>) => ({
  classification: (initial?.classification === 'out_of_scope' ? 'out_of_scope' : 'in_scope') as string,
  headerId: initial?.headerId ?? '',
  categoryId: initial?.categoryId ?? '',
  typeId: initial?.typeId ?? '',
  statusId: initial?.statusId ?? '',
  serviceId: initial?.serviceId ?? '',
  siteId: initial?.siteId ?? '',
  ticketCategoryId: initial?.ticketCategoryId ?? '',
  ciTypeKey: initial?.ciTypeKey ?? '',
  assetCategoryId: initial?.assetCategoryId ?? '',
});

const toPayload = (name: string, description: string, d: Record<string, string>): ScopeItemPayload => ({
  name: name.trim(),
  description: description.trim() || null,
  classification: d.classification === 'out_of_scope' ? 'out_of_scope' : 'in_scope',
  headerId: d.headerId || null,
  categoryId: d.categoryId || null,
  typeId: d.typeId || null,
  statusId: d.statusId || null,
  serviceId: d.serviceId || null,
  siteId: d.siteId || null,
  ticketCategoryId: d.ticketCategoryId || null,
  ciTypeKey: d.ciTypeKey || null,
  assetCategoryId: d.assetCategoryId || null,
});

export function ScopeItemForm({ initial, sites, contractServiceIds, onSubmit, onCancel, submitting }: { initial?: Partial<ScopeItem>; sites: Pick<Site, 'id' | 'name' | 'code'>[]; contractServiceIds?: string[]; onSubmit: (body: ScopeItemPayload) => void; onCancel: () => void; submitting?: boolean }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [d, setD] = useState<Record<string, string>>(initialDims(initial));
  const set = (k: string, v: string) => setD((s) => ({ ...s, [k]: v }));
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(toPayload(name, description, d));
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Name" required>
        <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="e.g. Firewall policy management" />
      </Field>
      <ScopeDimensionFields f={d} set={set} sites={sites} contractServiceIds={contractServiceIds} />
      <Field label="Description">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting} disabled={!name.trim()}>
          {initial?.id ? 'Save item' : 'Add item'}
        </Button>
      </div>
    </form>
  );
}

/** One item per line; dimensions apply to all of them. */
export function BulkScopeForm({ sites, contractServiceIds, onSubmit, onCancel, submitting }: { sites: Pick<Site, 'id' | 'name' | 'code'>[]; contractServiceIds?: string[]; onSubmit: (items: ScopeItemPayload[]) => void; onCancel: () => void; submitting?: boolean }) {
  const [text, setText] = useState('');
  const [d, setD] = useState<Record<string, string>>(initialDims());
  const set = (k: string, v: string) => setD((s) => ({ ...s, [k]: v }));
  const names = text.split('\n').map((l) => l.trim()).filter(Boolean);
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(names.map((n) => toPayload(n, '', d)));
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Items (one per line)" required hint={`${names.length} items`}>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} autoFocus placeholder={'Core switches (2)\nEdge routers\nWireless controllers'} />
      </Field>
      <ScopeDimensionFields f={d} set={set} sites={sites} contractServiceIds={contractServiceIds} />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting} disabled={!names.length}>
          Add {names.length || ''} items
        </Button>
      </div>
    </form>
  );
}
