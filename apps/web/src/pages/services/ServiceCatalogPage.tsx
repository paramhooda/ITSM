import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Layers, Users, Ticket, Activity } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Button, Badge, Card, Drawer, ConfirmDialog, LoadingBlock, ErrorBlock, EmptyState, SearchInput, Select, Checkbox, Field, Input, Textarea, KeyValue, StatTile } from '@/components/ui';
import { get, post, patch, del, ApiError } from '@/api/client';
import { useLookups, useEngineers } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { fmtDate } from '@/lib/format';
import { ContractStatusBadge } from '@/components/contracts/ContractBits';
import { DOMAINS } from '@itsm/shared';

interface Service {
  id: string;
  key: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryLabel: string | null;
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
interface ServiceDetail extends Service {
  subscribedCustomers: { customerId: string; customerName: string; customerCode: string; contractId: string; contractNumber: string; contractName: string; status: string; statusLabel: string; statusColor: string; endDate: string }[];
}
interface ServicePayload {
  name: string;
  key?: string;
  description: string | null;
  categoryId: string | null;
  statusId: string | null;
  domain: string;
  defaultTeamId: string | null;
  defaultSlaPolicyId: string | null;
  defaultTicketCategoryId: string | null;
  ciTypeKeys: string[];
  ownerUserId: string | null;
  isActive: boolean;
}
const errMsg = (e: unknown) => (e as ApiError)?.message ?? 'Request failed';
const DOMAIN_COLORS: Record<string, string> = { noc: 'blue', soc: 'red', amc: 'amber', service_desk: 'teal', general: 'slate' };

export default function ServiceCatalogPage() {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canManage = can('services:manage');
  const { options } = useLookups();
  const [q, setQ] = useState('');
  const [domain, setDomain] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Service | null>(null);

  const list = useQuery({ queryKey: ['services', 'list', { q, domain, showInactive }], queryFn: () => get<{ items: Service[]; total: number }>('/services', { q, domain, includeInactive: showInactive }) });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['services'] }); qc.invalidateQueries({ queryKey: ['lookups'] }); };
  const save = useMutation({
    mutationFn: (body: ServicePayload) => (editing && editing !== 'new' ? patch<Service>(`/services/${editing.id}`, body) : post<Service>('/services', body)),
    onSuccess: (s) => { invalidate(); setEditing(null); toast.success('Service saved'); setSelected(s.id); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (s: Service) => del<{ deleted?: boolean; deactivated?: boolean }>(`/services/${s.id}`),
    onSuccess: (r) => { invalidate(); setDeleting(null); setSelected(null); toast.success(r.deactivated ? 'Service is referenced by contracts or tickets and was deactivated instead' : 'Service deleted'); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const grouped = useMemo(() => {
    const groups = new Map<string, Service[]>();
    for (const s of list.data?.items ?? []) {
      const k = s.categoryLabel ?? 'Uncategorised';
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list.data]);
  const totals = useMemo(() => {
    const items = list.data?.items ?? [];
    return { services: items.length, customers: items.reduce((n, s) => n + s.counts.subscribedCustomers, 0), open: items.reduce((n, s) => n + s.counts.openTickets, 0), incidents: items.reduce((n, s) => n + s.counts.incidents30d, 0) };
  }, [list.data]);

  return (
    <div>
      <PageHeader title="Service catalog" subtitle={list.data ? `${list.data.total} services` : undefined} actions={canManage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>New service</Button>} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatTile label="Services" value={totals.services} icon={<Layers className="h-4 w-4" />} />
        <StatTile label="Subscriptions" value={totals.customers} hint="customer × active contract" icon={<Users className="h-4 w-4" />} />
        <StatTile label="Open tickets" value={totals.open} icon={<Ticket className="h-4 w-4" />} />
        <StatTile label="Incidents (30d)" value={totals.incidents} icon={<Activity className="h-4 w-4" />} />
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search services…" className="w-64" />
        <Select value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="All domains" options={DOMAINS.map((d) => ({ value: d, label: d.replace('_', ' ').toUpperCase() }))} className="w-40" />
        <Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
      </div>
      {list.isLoading && <LoadingBlock />}
      {list.isError && <ErrorBlock error={list.error} retry={() => list.refetch()} />}
      {list.data && grouped.length === 0 && <Card><EmptyState icon={<Layers className="h-5 w-5" />} title="No services" description="Define the services you deliver; contracts reference them for coverage, SLA and scope." /></Card>}
      <div className="space-y-5">
        {grouped.map(([category, items]) => (
          <div key={category}>
            <div className="text-[11.5px] uppercase tracking-wide font-semibold text-muted mb-2">{category} <span className="font-normal text-subtle">· {items.length}</span></div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {items.map((s) => (
                <button key={s.id} onClick={() => setSelected(s.id)} className={cn('card p-3 text-left hover:border-brand-400 transition-colors', selected === s.id && 'border-brand-500 ring-2 ring-brand-500/20', !s.isActive && 'opacity-60')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{s.name}</div>
                      <div className="text-[11px] text-subtle font-mono truncate">{s.key}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Badge color={DOMAIN_COLORS[s.domain] ?? 'slate'}>{s.domain.replace('_', ' ').toUpperCase()}</Badge>
                      {s.statusLabel && s.statusLabel !== 'Active' && <Badge color={s.statusColor ?? undefined}>{s.statusLabel}</Badge>}
                    </div>
                  </div>
                  {s.description && <div className="text-xs text-muted mt-1 line-clamp-2">{s.description}</div>}
                  <div className="text-[12px] text-muted mt-2 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>Team: <span className="text-default">{s.defaultTeamName ?? '—'}</span></span>
                    <span>SLA: <span className="text-default">{s.defaultSlaPolicyName ?? 'default'}</span></span>
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-[12px] tabular-nums">
                    <span className="inline-flex items-center gap-1 text-muted"><Users className="h-3.5 w-3.5" />{s.counts.subscribedCustomers}</span>
                    <span className="inline-flex items-center gap-1 text-muted"><Ticket className="h-3.5 w-3.5" />{s.counts.openTickets} open</span>
                    <span className={cn('inline-flex items-center gap-1', s.counts.incidents30d > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted')}><Activity className="h-3.5 w-3.5" />{s.counts.incidents30d} inc/30d</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Drawer open={!!selected} onClose={() => setSelected(null)} title="Service" width="max-w-xl">
        {selected && <ServicePanel id={selected} canManage={canManage} onEdit={(s) => setEditing(s)} onDelete={(s) => setDeleting(s)} />}
      </Drawer>
      <Drawer open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'New service' : 'Edit service'} width="max-w-xl">
        {editing && <ServiceForm initial={editing === 'new' ? undefined : editing} categories={options('service_category')} statuses={options('service_status')} onSubmit={(b) => save.mutate(b)} onCancel={() => setEditing(null)} submitting={save.isPending} />}
      </Drawer>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)} loading={remove.isPending} danger title="Delete service?" confirmLabel="Delete" description={`${deleting?.name}: services referenced by contracts, tickets or catalog items are deactivated instead of removed.`} />
    </div>
  );
}

function ServicePanel({ id, canManage, onEdit, onDelete }: { id: string; canManage: boolean; onEdit: (s: Service) => void; onDelete: (s: Service) => void }) {
  const q = useQuery({ queryKey: ['services', id], queryFn: () => get<ServiceDetail>(`/services/${id}`) });
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError || !q.data) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  const s = q.data;
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold flex items-center gap-2">{s.name}<Badge color={DOMAIN_COLORS[s.domain] ?? 'slate'}>{s.domain.replace('_', ' ').toUpperCase()}</Badge>{s.statusLabel && <Badge color={s.statusColor ?? undefined}>{s.statusLabel}</Badge>}{!s.isActive && <Badge color="gray">Inactive</Badge>}</div>
          <div className="text-xs text-subtle font-mono">{s.key}</div>
        </div>
        {canManage && (
          <div className="flex gap-1 shrink-0">
            <Button variant="outline" size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => onEdit(s)}>Edit</Button>
            <Button variant="ghost" size="icon" title="Delete" onClick={() => onDelete(s)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
          </div>
        )}
      </div>
      {s.description && <p className="text-[13px] text-muted whitespace-pre-wrap">{s.description}</p>}
      <KeyValue columns={2} items={[
        { label: 'Category', value: s.categoryLabel ?? '—' },
        { label: 'Owner', value: s.ownerName ?? '—' },
        { label: 'Default team', value: s.defaultTeamName ?? '—' },
        { label: 'Default SLA policy', value: s.defaultSlaPolicyName ?? 'Platform default' },
        { label: 'Default ticket category', value: s.defaultTicketCategoryLabel ?? '—' },
        { label: 'Linked CIs', value: s.counts.cis },
      ]} />
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Customers" value={s.counts.subscribedCustomers} />
        <StatTile label="Open tickets" value={s.counts.openTickets} />
        <StatTile label="Incidents 30d" value={s.counts.incidents30d} tone={s.counts.incidents30d > 0 ? 'warn' : 'default'} />
      </div>
      <div>
        <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium mb-1.5">CI types covered</div>
        {s.ciTypes.length ? <div className="flex flex-wrap gap-1">{s.ciTypes.map((t) => <Badge key={t.key} color="teal">{t.name}</Badge>)}</div> : <div className="text-[13px] text-muted">—</div>}
      </div>
      <div>
        <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium mb-1.5">Subscribed customers (active contracts)</div>
        {s.subscribedCustomers.length === 0 ? <div className="text-[13px] text-muted">No active contract covers this service.</div> : (
          <ul className="divide-y divide-[var(--border)] text-[13px]">
            {s.subscribedCustomers.map((c) => (
              <li key={`${c.customerId}-${c.contractId}`} className="py-1.5 flex items-center gap-2">
                <Link to={`/customers/${c.customerId}`} className="font-medium hover:underline truncate">{c.customerName}</Link>
                <Link to={`/contracts/${c.contractId}`} className="font-mono text-[11.5px] text-muted hover:underline">{c.contractNumber}</Link>
                <span className="ml-auto flex items-center gap-2"><ContractStatusBadge status={c.status} label={c.statusLabel} color={c.statusColor} /><span className="text-subtle text-xs">{fmtDate(c.endDate)}</span></span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ServiceForm({ initial, categories, statuses, onSubmit, onCancel, submitting }: { initial?: Service; categories: { id: string; label: string }[]; statuses: { id: string; label: string; isDefault: boolean }[]; onSubmit: (b: ServicePayload) => void; onCancel: () => void; submitting: boolean }) {
  const { lookups, options } = useLookups();
  const engineers = useEngineers();
  const [f, setF] = useState({
    name: initial?.name ?? '',
    key: initial?.key ?? '',
    description: initial?.description ?? '',
    categoryId: initial?.categoryId ?? '',
    statusId: initial?.statusId ?? (statuses.find((s) => s.isDefault)?.id ?? ''),
    domain: initial?.domain ?? 'general',
    defaultTeamId: initial?.defaultTeamId ?? '',
    defaultSlaPolicyId: initial?.defaultSlaPolicyId ?? '',
    defaultTicketCategoryId: initial?.defaultTicketCategoryId ?? '',
    ciTypeKeys: initial?.ciTypeKeys ?? [],
    ownerUserId: initial?.ownerUserId ?? '',
    isActive: initial?.isActive ?? true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ name: f.name.trim(), key: f.key.trim() || undefined, description: f.description.trim() || null, categoryId: f.categoryId || null, statusId: f.statusId || null, domain: f.domain, defaultTeamId: f.defaultTeamId || null, defaultSlaPolicyId: f.defaultSlaPolicyId || null, defaultTicketCategoryId: f.defaultTicketCategoryId || null, ciTypeKeys: f.ciTypeKeys, ownerUserId: f.ownerUserId || null, isActive: f.isActive });
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name" required className="sm:col-span-2"><Input value={f.name} onChange={(e) => set('name', e.target.value)} required autoFocus /></Field>
        <Field label="Key" hint="Generated from the name when blank"><Input value={f.key} onChange={(e) => set('key', e.target.value.toLowerCase())} placeholder="network_management" /></Field>
        <Field label="Domain"><Select value={f.domain} onChange={(e) => set('domain', e.target.value)} options={DOMAINS.map((d) => ({ value: d, label: d.replace('_', ' ').toUpperCase() }))} /></Field>
        <Field label="Category"><Select value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)} placeholder="—" options={categories.map((c) => ({ value: c.id, label: c.label }))} /></Field>
        <Field label="Status"><Select value={f.statusId} onChange={(e) => set('statusId', e.target.value)} placeholder="—" options={statuses.map((c) => ({ value: c.id, label: c.label }))} /></Field>
        <Field label="Default team"><Select value={f.defaultTeamId} onChange={(e) => set('defaultTeamId', e.target.value)} placeholder="—" options={(lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))} /></Field>
        <Field label="Default SLA policy"><Select value={f.defaultSlaPolicyId} onChange={(e) => set('defaultSlaPolicyId', e.target.value)} placeholder="Platform default" options={(lookups?.slaPolicies ?? []).map((p) => ({ value: p.id, label: p.name }))} /></Field>
        <Field label="Default ticket category"><Select value={f.defaultTicketCategoryId} onChange={(e) => set('defaultTicketCategoryId', e.target.value)} placeholder="—" options={options('ticket_category').map((o) => ({ value: o.id, label: o.label }))} /></Field>
        <Field label="Owner"><Select value={f.ownerUserId} onChange={(e) => set('ownerUserId', e.target.value)} placeholder="—" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} /></Field>
      </div>
      <Field label="Description"><Textarea value={f.description} onChange={(e) => set('description', e.target.value)} rows={3} /></Field>
      <Field label="CI types covered">
        <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto border border-default rounded-lg p-2">
          {(lookups?.ciTypes ?? []).map((t) => {
            const on = f.ciTypeKeys.includes(t.key);
            return <button type="button" key={t.key} onClick={() => set('ciTypeKeys', on ? f.ciTypeKeys.filter((k) => k !== t.key) : [...f.ciTypeKeys, t.key])} className={cn('rounded-md border px-2 py-0.5 text-[12px]', on ? 'border-brand-500 bg-brand-600/10 text-brand-700 dark:text-brand-300' : 'border-default text-muted hover:text-default')}>{t.name}</button>;
          })}
          {!(lookups?.ciTypes ?? []).length && <span className="text-xs text-muted">No CI types defined.</span>}
        </div>
      </Field>
      {initial && <Checkbox label="Active" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} />}
      <div className="flex justify-end gap-2 pt-1"><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button type="submit" loading={submitting} disabled={!f.name.trim()}>{initial ? 'Save service' : 'Create service'}</Button></div>
    </form>
  );
}
