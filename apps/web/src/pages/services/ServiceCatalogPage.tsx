import { useMemo, useState, type ComponentType } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Layers, Users, Ticket, Activity, Server, ShieldCheck, Wrench, Headset, Briefcase, Cloud, Network, Database, FolderTree, Settings2, Pencil } from 'lucide-react';
import { PageHeader, Button, Badge, Card, Drawer, LoadingBlock, ErrorBlock, EmptyState, SearchInput, Select, Checkbox, KeyValue, FilterBar } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { Stat } from '@/components/dashboards/Panel';
import { get } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { cn, colorClass } from '@/lib/utils';
import { DOMAIN_COLORS } from '@/lib/statusColors';
import { fmtDate, fmtNumber } from '@/lib/format';
import { ContractStatusBadge } from '@/components/contracts/ContractBits';
import { DOMAIN_LABEL, type Catalog, type Category, type Service, type ServiceDetail } from '@/components/admin/ServiceForm';
import { DOMAINS } from '@itsm/shared';

const ICONS: Record<string, ComponentType<{ className?: string; strokeWidth?: number }>> = { server: Server, 'shield-check': ShieldCheck, wrench: Wrench, headset: Headset, briefcase: Briefcase, cloud: Cloud, network: Network, database: Database, layers: Layers };
const categoryCount = (c: Category) => c.services.length + c.subcategories.reduce((n, s) => n + s.services.length, 0);

/**
 * Service catalog: a browse view of everything we deliver, by service line and
 * offering. Services are managed under Administration → Service catalog.
 */
export default function ServiceCatalogPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const canManage = can('services:manage');
  const canConfig = can('admin:config');
  const [q, setQ] = useState('');
  const [domain, setDomain] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const catalog = useQuery({ queryKey: ['services', 'catalog', { q, domain, showInactive }], queryFn: () => get<Catalog>('/services/catalog', { q: q || undefined, domain: domain || undefined, includeInactive: showInactive ? 'true' : undefined }), placeholderData: (p) => p });

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
            {canConfig && <Button variant="outline" icon={<FolderTree className="h-4 w-4" />} onClick={() => navigate('/admin/options/service_category')}>Service lines</Button>}
            {canManage && <Button variant="outline" icon={<Settings2 className="h-4 w-4" />} onClick={() => navigate('/admin/services')}>Manage in Administration</Button>}
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
            { label: 'Subscribed customers', value: fmtNumber(data.totals.subscribedCustomers), hint: 'customers with an active contract', icon: <Users className="h-4 w-4" />, onClick: () => navigate('/contracts') },
            { label: 'Open tickets', value: fmtNumber(data.totals.openTickets), hint: 'across all services', icon: <Ticket className="h-4 w-4" />, onClick: () => navigate('/tickets') },
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
        <Card><EmptyState icon={<Layers className="h-5 w-5" />} title={filtering ? 'No services match' : 'No services yet'} description={filtering ? 'Try a different search or domain.' : 'Define the services you deliver; contracts reference them for coverage, SLA and scope.'} action={canManage && !filtering && <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/admin/services?new=1')}>New service</Button>} /></Card>
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
        {selected && <ServicePanel id={selected} canManage={canManage} />}
      </Drawer>
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

/** Read-only service detail; editing happens in Administration. */
function ServicePanel({ id, canManage }: { id: string; canManage: boolean }) {
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
          <Link to={`/admin/services?edit=${s.id}`} className="shrink-0 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-default hover:underline"><Pencil className="h-3.5 w-3.5" /> Edit in Administration</Link>
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
        { label: 'Default SLA policy', value: s.defaultSlaPolicyId ? <Link to={`/sla?policy=${s.defaultSlaPolicyId}`} className="hover:underline">{s.defaultSlaPolicyName}</Link> : 'Platform default' },
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
