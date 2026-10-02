import { useMemo, useState, type FormEvent, type ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Layers, Users, Ticket, Activity, Server, ShieldCheck, Wrench, Headset, Briefcase, Cloud, Network, Database, Settings2, FolderTree } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Button, Badge, Card, Drawer, ConfirmDialog, LoadingBlock, ErrorBlock, EmptyState, SearchInput, Select, Checkbox, Field, Input, Textarea, KeyValue, FilterBar } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { Stat } from '@/components/dashboards/Panel';
import { get, post, patch, del, ApiError } from '@/api/client';
import { useLookups, useEngineers } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { cn, colorClass } from '@/lib/utils';
import { DOMAIN_COLORS } from '@/lib/statusColors';
import { fmtDate, fmtNumber } from '@/lib/format';
import { ContractStatusBadge } from '@/components/contracts/ContractBits';
import { DOMAINS } from '@itsm/shared';

interface Service {
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
interface ServiceDetail extends Service {
  subscribedCustomers: { customerId: string; customerName: string; customerCode: string; contractId: string; contractNumber: string; contractName: string; status: string; statusLabel: string; statusColor: string; endDate: string }[];
}
interface Subcategory { id: string; key: string; label: string; description: string | null; sortOrder: number; isActive: boolean; services: Service[] }
interface Category { id: string; key: string; label: string; description: string | null; icon: string | null; color: string | null; sortOrder: number; isActive: boolean; subcategories: Subcategory[]; services: Service[] }
interface Catalog { categories: Category[]; uncategorised: Service[]; totals: { services: number; subscribedCustomers: number; openTickets: number; incidents30d: number } }
interface ServicePayload {
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
const errMsg = (e: unknown) => (e as ApiError)?.message ?? 'Request failed';
const DOMAIN_LABEL: Record<string, string> = { noc: 'NOC', soc: 'SOC', amc: 'AMC', service_desk: 'Service desk', general: 'General' };
const ICONS: Record<string, ComponentType<{ className?: string; strokeWidth?: number }>> = { server: Server, 'shield-check': ShieldCheck, wrench: Wrench, headset: Headset, briefcase: Briefcase, cloud: Cloud, network: Network, database: Database, layers: Layers };
const categoryCount = (c: Category) => c.services.length + c.subcategories.reduce((n, s) => n + s.services.length, 0);

export default function ServiceCatalogPage() {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canManage = can('services:manage');
  const canConfig = can('admin:config');
  const { options } = useLookups();
  const [q, setQ] = useState('');
  const [domain, setDomain] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Service | null>(null);

  const catalog = useQuery({ queryKey: ['services', 'catalog', { q, domain, showInactive }], queryFn: () => get<Catalog>('/services/catalog', { q: q || undefined, domain: domain || undefined, includeInactive: showInactive ? 'true' : undefined }), placeholderData: (p) => p });
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

  const data = catalog.data;
  const categories = useMemo(() => (data?.categories ?? []).filter((c) => categoryCount(c) > 0), [data]);
  const filtering = !!(q || domain);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Service catalog"
        subtitle="Everything we deliver, organised by service line and offering. Contracts reference these for coverage, SLA and scope."
        actions={
          <>
            {canConfig && <Button variant="outline" icon={<FolderTree className="h-4 w-4" />} onClick={() => (window.location.href = '/admin/options/service_category')}>Categories</Button>}
            {canManage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>New service</Button>}
          </>
        }
      />
      <FilterBar activeCount={(q ? 1 : 0) + (domain ? 1 : 0) + (showInactive ? 1 : 0)} onClear={() => { setQ(''); setDomain(''); setShowInactive(false); }}>
        <SearchInput value={q} onChange={setQ} placeholder="Search services…" className="w-64" />
        <Select value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="All domains" options={DOMAINS.map((d) => ({ value: d, label: DOMAIN_LABEL[d] ?? d }))} className="w-40 h-8 py-0 text-[13px]" />
        <Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
      </FilterBar>

      {data && (
        <InsightBand
          id="catalog"
          summary={`${fmtNumber(data.totals.services)} offerings in ${fmtNumber(categories.length)} service lines`}
          kpis={[
            { label: 'Service offerings', value: fmtNumber(data.totals.services), hint: `${fmtNumber(categories.length)} service lines`, icon: <Layers className="h-4 w-4" /> },
            { label: 'Subscribed customers', value: fmtNumber(data.totals.subscribedCustomers), hint: 'customers with an active contract', icon: <Users className="h-4 w-4" />, onClick: () => (window.location.href = '/contracts') },
            { label: 'Open tickets', value: fmtNumber(data.totals.openTickets), hint: 'across all services', icon: <Ticket className="h-4 w-4" />, onClick: () => (window.location.href = '/tickets') },
            { label: 'Incidents · 30 days', value: fmtNumber(data.totals.incidents30d), tone: data.totals.incidents30d > 0 ? 'warn' : 'default', hint: 'incidents raised against a service', icon: <Activity className="h-4 w-4" /> },
          ]}
          panels={
            <>
              <Panel title="Offerings by service line" subtitle="Where the catalog is deepest">
                <BreakdownBar dense items={[...categories].sort((a, b) => categoryCount(b) - categoryCount(a)).map((c) => ({ label: c.label, value: categoryCount(c), color: c.color ?? null, href: `#cat-${c.key}` }))} emptyText="No service lines" />
              </Panel>
              <Panel title="By domain" subtitle="Click to filter">
                <BreakdownBar dense items={DOMAINS.map((d) => ({ label: DOMAIN_LABEL[d] ?? d, value: [...categories.flatMap((c) => [...c.services, ...c.subcategories.flatMap((sc) => sc.services)]), ...data.uncategorised].filter((sv) => sv.domain === d).length, color: DOMAIN_COLORS[d] ?? null, active: domain === d })).filter((i) => i.value > 0)} onSelect={(i) => { const d = DOMAINS.find((x) => (DOMAIN_LABEL[x] ?? x) === i.label); if (d) setDomain(domain === d ? '' : d); }} />
              </Panel>
            </>
          }
        />
      )}
      {catalog.isLoading && <LoadingBlock />}
      {catalog.isError && <ErrorBlock error={catalog.error} retry={() => catalog.refetch()} />}
      {data && categories.length === 0 && data.uncategorised.length === 0 && (
        <Card><EmptyState icon={<Layers className="h-5 w-5" />} title={filtering ? 'No services match' : 'No services yet'} description={filtering ? 'Try a different search or domain.' : 'Define the services you deliver; contracts reference them for coverage, SLA and scope.'} action={canManage && !filtering && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>New service</Button>} /></Card>
      )}
      {data && (categories.length > 0 || data.uncategorised.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-[220px_1fr] gap-6 items-start">
          <nav className="hidden xl:block sticky top-0">
            <div className="text-[11px] uppercase tracking-[0.08em] text-subtle font-medium px-2.5 pb-2">Service lines</div>
            {categories.map((c) => (
              <a key={c.id} href={`#cat-${c.key}`} className="flex items-center gap-2.5 rounded-lg px-2.5 h-8.5 text-[13px] text-secondary hover:bg-white hover:text-default border border-transparent hover:border-default transition-colors">
                <CategoryIcon icon={c.icon} color={c.color} size="sm" />
                <span className="truncate flex-1">{c.label}</span>
                <span className="text-[11.5px] text-subtle tnum">{categoryCount(c)}</span>
              </a>
            ))}
            {data.uncategorised.length > 0 && (
              <a href="#cat-uncategorised" className="flex items-center gap-2.5 rounded-lg px-2.5 h-8.5 text-[13px] text-secondary hover:bg-white hover:text-default border border-transparent hover:border-default transition-colors">
                <CategoryIcon icon={null} color={null} size="sm" />
                <span className="truncate flex-1">Uncategorised</span>
                <span className="text-[11.5px] text-subtle tnum">{data.uncategorised.length}</span>
              </a>
            )}
          </nav>
          <div className="flex flex-col gap-8 min-w-0">
            {categories.map((c, i) => (
              <section key={c.id} id={`cat-${c.key}`} className={cn('scroll-mt-6 rise-in', `rise-in-${Math.min(4, i + 1)}`)}>
                <header className="flex items-start gap-3.5 mb-4">
                  <CategoryIcon icon={c.icon} color={c.color} />
                  <div className="min-w-0">
                    <h2 className="text-[18px] font-semibold tracking-[-0.02em] leading-tight flex items-center gap-2">
                      {c.label}
                      <span className="text-[12.5px] font-medium text-subtle tnum">{categoryCount(c)}</span>
                      {!c.isActive && <Badge color="gray">inactive</Badge>}
                    </h2>
                    {c.description && <p className="text-[13px] text-muted mt-0.5">{c.description}</p>}
                  </div>
                </header>
                <div className="flex flex-col gap-5">
                  {c.subcategories.map((s) => (
                    <div key={s.id}>
                      <div className="flex items-center gap-2 mb-2.5">
                        <h3 className="text-[12px] uppercase tracking-[0.08em] font-semibold text-muted">{s.label}</h3>
                        <span className="text-[11.5px] text-subtle tnum">{s.services.length}</span>
                        {s.description && <span className="text-[12px] text-subtle truncate">· {s.description}</span>}
                      </div>
                      <ServiceGrid services={s.services} selected={selected} onSelect={setSelected} />
                    </div>
                  ))}
                  {c.services.length > 0 && (
                    <div>
                      {c.subcategories.length > 0 && (
                        <div className="flex items-center gap-2 mb-2.5">
                          <h3 className="text-[12px] uppercase tracking-[0.08em] font-semibold text-muted">General</h3>
                          <span className="text-[11.5px] text-subtle tnum">{c.services.length}</span>
                        </div>
                      )}
                      <ServiceGrid services={c.services} selected={selected} onSelect={setSelected} />
                    </div>
                  )}
                </div>
              </section>
            ))}
            {data.uncategorised.length > 0 && (
              <section id="cat-uncategorised" className="scroll-mt-6">
                <header className="flex items-start gap-3.5 mb-4">
                  <CategoryIcon icon={null} color={null} />
                  <div>
                    <h2 className="text-[18px] font-semibold tracking-[-0.02em] leading-tight flex items-center gap-2">Uncategorised <span className="text-[12.5px] font-medium text-subtle tnum">{data.uncategorised.length}</span></h2>
                    <p className="text-[13px] text-muted mt-0.5">Assign these to a service line so they appear in the right place for customers and reports.</p>
                  </div>
                </header>
                <ServiceGrid services={data.uncategorised} selected={selected} onSelect={setSelected} />
              </section>
            )}
          </div>
        </div>
      )}

      <Drawer open={!!selected} onClose={() => setSelected(null)} title="Service" width="max-w-xl">
        {selected && <ServicePanel id={selected} canManage={canManage} onEdit={(s) => setEditing(s)} onDelete={(s) => setDeleting(s)} />}
      </Drawer>
      <Drawer open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'New service' : 'Edit service'} width="max-w-xl">
        {editing && <ServiceForm initial={editing === 'new' ? undefined : editing} statuses={options('service_status')} onSubmit={(b) => save.mutate(b)} onCancel={() => setEditing(null)} submitting={save.isPending} />}
      </Drawer>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)} loading={remove.isPending} danger title="Delete service?" confirmLabel="Delete" description={`${deleting?.name}: services referenced by contracts, tickets or catalog items are deactivated instead of removed.`} />
    </div>
  );
}

function CategoryIcon({ icon, color, size = 'md' }: { icon: string | null; color: string | null; size?: 'sm' | 'md' }) {
  const Icon = (icon && ICONS[icon]) || Layers;
  return (
    <span className={cn('inline-flex items-center justify-center rounded-lg shrink-0 border border-current/10', colorClass(color), size === 'sm' ? 'h-5.5 w-5.5' : 'h-10 w-10')}>
      <Icon className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5'} strokeWidth={1.8} />
    </span>
  );
}

function ServiceGrid({ services, selected, onSelect }: { services: Service[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
      {services.map((s) => (
        <button key={s.id} onClick={() => onSelect(s.id)} className={cn('card p-4 text-left flex flex-col gap-3 hover:border-strong hover:shadow-raised transition-[box-shadow,border-color]', selected === s.id && 'border-navy-900 ring-[3px] ring-navy-900/10', !s.isActive && 'opacity-60')}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-semibold text-[14px] tracking-[-0.01em] truncate">{s.name}</div>
              <div className="text-[11.5px] text-subtle font-mono truncate">{s.key}</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Badge color={DOMAIN_COLORS[s.domain] ?? 'slate'}>{DOMAIN_LABEL[s.domain] ?? s.domain}</Badge>
              {s.statusLabel && s.statusLabel !== 'Active' && <Badge color={s.statusColor ?? undefined}>{s.statusLabel}</Badge>}
            </div>
          </div>
          {s.description && <div className="text-[12.5px] text-muted line-clamp-2 leading-relaxed">{s.description}</div>}
          <div className="text-[12px] text-muted flex flex-wrap gap-x-3 gap-y-0.5">
            <span>Team <span className="text-default">{s.defaultTeamName ?? '—'}</span></span>
            <span>SLA <span className="text-default">{s.defaultSlaPolicyName ?? 'default'}</span></span>
          </div>
          <div className="mt-auto pt-3 border-t border-default flex items-center gap-4 text-[12px] tnum">
            <span className="inline-flex items-center gap-1.5 text-muted" title="Subscribed customers"><Users className="h-3.5 w-3.5" />{s.counts.subscribedCustomers}</span>
            <span className={cn('inline-flex items-center gap-1.5', s.counts.openTickets > 0 ? 'text-default' : 'text-muted')} title="Open tickets"><Ticket className="h-3.5 w-3.5" />{s.counts.openTickets} open</span>
            <span className={cn('inline-flex items-center gap-1.5', s.counts.incidents30d > 0 ? 'text-amber-600' : 'text-muted')} title="Incidents in the last 30 days"><Activity className="h-3.5 w-3.5" />{s.counts.incidents30d} inc/30d</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function ServicePanel({ id, canManage, onEdit, onDelete }: { id: string; canManage: boolean; onEdit: (s: Service) => void; onDelete: (s: Service) => void }) {
  const q = useQuery({ queryKey: ['services', id], queryFn: () => get<ServiceDetail>(`/services/${id}`) });
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError || !q.data) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  const s = q.data;
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] text-muted">{[s.categoryLabel, s.subcategoryLabel].filter(Boolean).join(' › ') || 'Uncategorised'}</div>
          <div className="text-[16px] font-semibold tracking-[-0.01em] flex items-center gap-2 flex-wrap">{s.name}<Badge color={DOMAIN_COLORS[s.domain] ?? 'slate'}>{DOMAIN_LABEL[s.domain] ?? s.domain}</Badge>{s.statusLabel && <Badge color={s.statusColor ?? undefined}>{s.statusLabel}</Badge>}{!s.isActive && <Badge color="gray">Inactive</Badge>}</div>
          <div className="text-xs text-subtle font-mono">{s.key}</div>
        </div>
        {canManage && (
          <div className="flex gap-1 shrink-0">
            <Button variant="outline" size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => onEdit(s)}>Edit</Button>
            <Button variant="ghost" size="icon" title="Delete" onClick={() => onDelete(s)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
          </div>
        )}
      </div>
      {s.description && <p className="text-[13px] text-secondary whitespace-pre-wrap leading-relaxed">{s.description}</p>}
      <div className="grid grid-cols-3 gap-4 py-3 border-y border-default">
        <Stat label="Customers" value={s.counts.subscribedCustomers} />
        <Stat label="Open tickets" value={s.counts.openTickets} />
        <Stat label="Incidents 30d" value={s.counts.incidents30d} tone={s.counts.incidents30d > 0 ? 'warn' : 'default'} />
      </div>
      <KeyValue columns={2} items={[
        { label: 'Service line', value: s.categoryLabel ?? '—' },
        { label: 'Offering group', value: s.subcategoryLabel ?? '—' },
        { label: 'Owner', value: s.ownerName ?? '—' },
        { label: 'Default team', value: s.defaultTeamName ?? '—' },
        { label: 'Default SLA policy', value: s.defaultSlaPolicyId ? <Link to={`/sla/${s.defaultSlaPolicyId}`} className="hover:underline">{s.defaultSlaPolicyName}</Link> : 'Platform default' },
        { label: 'Default ticket category', value: s.defaultTicketCategoryLabel ?? '—' },
        { label: 'Linked CIs', value: s.counts.cis },
      ]} />
      <div>
        <div className="text-[11.5px] uppercase tracking-[0.08em] text-subtle font-medium mb-1.5">CI types covered</div>
        {s.ciTypes.length ? <div className="flex flex-wrap gap-1">{s.ciTypes.map((t) => <Badge key={t.key} color="teal">{t.name}</Badge>)}</div> : <div className="text-[13px] text-muted">—</div>}
      </div>
      <div>
        <div className="text-[11.5px] uppercase tracking-[0.08em] text-subtle font-medium mb-1.5">Subscribed customers (active contracts)</div>
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

function ServiceForm({ initial, statuses, onSubmit, onCancel, submitting }: { initial?: Service; statuses: { id: string; label: string; isDefault: boolean }[]; onSubmit: (b: ServicePayload) => void; onCancel: () => void; submitting: boolean }) {
  const { lookups, options } = useLookups();
  const engineers = useEngineers();
  const [f, setF] = useState({
    name: initial?.name ?? '',
    key: initial?.key ?? '',
    description: initial?.description ?? '',
    categoryId: initial?.categoryId ?? '',
    subcategoryId: initial?.subcategoryId ?? '',
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
  const categories = options('service_category');
  const subcategories = options('service_subcategory', f.categoryId ? { parentId: f.categoryId } : undefined);
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ name: f.name.trim(), key: f.key.trim() || undefined, description: f.description.trim() || null, categoryId: f.categoryId || null, subcategoryId: f.subcategoryId || null, statusId: f.statusId || null, domain: f.domain, defaultTeamId: f.defaultTeamId || null, defaultSlaPolicyId: f.defaultSlaPolicyId || null, defaultTicketCategoryId: f.defaultTicketCategoryId || null, ciTypeKeys: f.ciTypeKeys, ownerUserId: f.ownerUserId || null, isActive: f.isActive });
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name" required className="sm:col-span-2"><Input value={f.name} onChange={(e) => set('name', e.target.value)} required autoFocus /></Field>
        <Field label="Key" hint="Generated from the name when blank"><Input value={f.key} onChange={(e) => set('key', e.target.value.toLowerCase())} placeholder="network_management" /></Field>
        <Field label="Domain"><Select value={f.domain} onChange={(e) => set('domain', e.target.value)} options={DOMAINS.map((d) => ({ value: d, label: DOMAIN_LABEL[d] ?? d }))} /></Field>
        <Field label="Service line" hint="Main header in the catalog"><Select value={f.categoryId} onChange={(e) => { set('categoryId', e.target.value); set('subcategoryId', ''); }} placeholder="—" options={categories.map((c) => ({ value: c.id, label: c.label }))} /></Field>
        <Field label="Offering group" hint={f.categoryId ? 'Sub-section under the service line' : 'Pick a service line first'}><Select value={f.subcategoryId} disabled={!f.categoryId} onChange={(e) => set('subcategoryId', e.target.value)} placeholder="—" options={subcategories.map((c) => ({ value: c.id, label: c.label }))} /></Field>
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
            return <button type="button" key={t.key} onClick={() => set('ciTypeKeys', on ? f.ciTypeKeys.filter((k) => k !== t.key) : [...f.ciTypeKeys, t.key])} className={cn('rounded-md border px-2 py-0.5 text-[12px] transition-colors', on ? 'border-navy-900 bg-navy-900 text-white' : 'border-default text-muted hover:text-default hover:border-strong')}>{t.name}</button>;
          })}
          {!(lookups?.ciTypes ?? []).length && <span className="text-xs text-muted">No CI types defined.</span>}
        </div>
      </Field>
      {initial && <Checkbox label="Active" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} />}
      <div className="flex justify-end gap-2 pt-1"><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button type="submit" loading={submitting} disabled={!f.name.trim()} icon={<Settings2 className="h-4 w-4" />}>{initial ? 'Save service' : 'Create service'}</Button></div>
    </form>
  );
}
