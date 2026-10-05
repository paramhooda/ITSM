import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Package, HardDrive, AlertOctagon, CalendarClock, LifeBuoy, Search } from 'lucide-react';
import { PageHeader, ModuleNav, Button, DataTable, Pagination, Badge, EmptyState, ErrorBlock, Drawer, KeyValue, ProgressBar, type Column } from '@/components/ui';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { Segmented, KpiSkeleton } from '@/components/dashboards/Panel';
import { useListState } from '@/hooks/useListState';
import { PORTAL_ASSET_MODULES } from '@/layouts/modules';
import { fmtDate, fmtNumber, relativeTime } from '@/lib/format';
import { COMPLIANCE_COLORS, LICENCE_STATUS_COLORS } from '@/lib/statusColors';
import { portalApi, pk, type PortalPosition, type PortalLicence, type PortalInstallation } from '@/components/portal/api';

type View = 'titles' | 'licences' | 'installations';
const VIEW_RESET = { q: undefined, productId: undefined, page: undefined };
const POSITION_LABEL: Record<string, string> = { compliant: 'Compliant', under_deployed: 'Unused seats', over_deployed: 'Over-deployed', unlicensed: 'Unlicensed', unlimited: 'Site licence' };
const STATUS_LABEL: Record<string, string> = { active: 'Active', expiring: 'Ending soon', expired: 'Expired', future: 'Starts later', renewed: 'Renewed', inactive: 'Inactive' };
const METRIC_LABEL: Record<string, string> = { per_device: 'per device', per_user: 'per user', per_core: 'per core', site: 'site licence' };
const SOURCE_LABEL: Record<string, string> = { manual: 'recorded', csv: 'imported', discovery: 'discovered', agent: 'agent' };
const titleOf = (p: { publisher: string; name?: string; product?: string; versionFamily: string | null }) => { const n = p.name ?? p.product ?? ''; return `${n.toLowerCase().startsWith(`${p.publisher.toLowerCase()} `) ? n : `${p.publisher} ${n}`}${p.versionFamily ? ` ${p.versionFamily}` : ''}`; };
const countdown = (d: number | null) => (d === null ? '' : d < 0 ? `ended ${Math.abs(d)}d ago` : d === 0 ? 'ends today' : `${d}d left`);

/**
 * Software for customer administrators: the titles we track for the organisation
 * with their licence position, the licences behind them (no cost, key or paperwork)
 * and where each title is installed. Pinned to the signed-in organisation; MSP
 * staff with every customer may preview with ?customerId=.
 */
export default function PortalSoftwarePage() {
  const navigate = useNavigate();
  const { state, set, page, setPage } = useListState({ view: 'titles' });
  const view = (['titles', 'licences', 'installations'].includes(state.view) ? state.view : 'titles') as View;
  const customerId = state.customerId || undefined;
  const [selected, setSelected] = useState<PortalPosition | null>(null);
  const summary = useQuery({ queryKey: pk.software(customerId), queryFn: () => portalApi.software(customerId), refetchInterval: 60_000, placeholderData: (p) => p });
  const listParams = useMemo(() => ({ customerId, page, pageSize: 50, q: state.q || undefined, productId: state.productId || undefined }), [customerId, page, state.q, state.productId]);
  const licences = useQuery({ queryKey: pk.softwareLicences(listParams), queryFn: () => portalApi.softwareLicences(listParams), enabled: view === 'licences', placeholderData: (p) => p });
  const installations = useQuery({ queryKey: pk.softwareInstallations(listParams), queryFn: () => portalApi.softwareInstallations(listParams), enabled: view === 'installations', placeholderData: (p) => p });
  const drawerLicences = useQuery({ queryKey: pk.softwareLicences({ customerId, productId: selected?.productId, pageSize: 50 }), queryFn: () => portalApi.softwareLicences({ customerId, productId: selected?.productId, pageSize: 50 }), enabled: !!selected });
  const d = summary.data;
  const needle = (state.q ?? '').trim().toLowerCase();
  const positions = useMemo(() => (d?.positions ?? []).filter((p) => !needle || titleOf(p).toLowerCase().includes(needle) || (p.categoryLabel ?? '').toLowerCase().includes(needle)), [d, needle]);

  const titleCols: Column<PortalPosition>[] = [
    { key: 'title', header: 'Title', render: (p) => <div className="leading-tight min-w-0"><div className="font-medium truncate">{titleOf(p)}</div>{p.categoryLabel && <div className="text-[11.5px] text-subtle">{p.categoryLabel}</div>}</div> },
    { key: 'metric', header: 'Counted', width: '110px', render: (p) => <span className="text-muted">{METRIC_LABEL[p.metric] ?? p.metric}</span> },
    { key: 'installed', header: 'Installed', width: '90px', className: 'text-right tabular-nums', render: (p) => fmtNumber(p.installed) },
    { key: 'entitled', header: 'Licensed', width: '90px', className: 'text-right tabular-nums', render: (p) => (p.entitled === null ? 'Unlimited' : fmtNumber(p.entitled)) },
    { key: 'unused', header: 'Unused', width: '80px', className: 'text-right tabular-nums', render: (p) => (p.unused === null ? '—' : fmtNumber(p.unused)) },
    { key: 'utilisation', header: 'In use', width: '150px', render: (p) => (p.entitled === null ? <span className="text-subtle text-[12px]">site licence</span> : <div><div className="text-[11.5px] text-muted mb-1 tnum">{p.utilisationPct === null ? '—' : `${p.utilisationPct}%`}</div><ProgressBar pct={Math.min(100, p.utilisationPct ?? 0)} tone={p.position === 'over_deployed' || p.position === 'unlicensed' ? 'bad' : p.position === 'under_deployed' ? 'warn' : 'good'} /></div>) },
    { key: 'position', header: 'Position', width: '130px', render: (p) => <Badge color={COMPLIANCE_COLORS[p.position] ?? 'slate'} dot>{POSITION_LABEL[p.position] ?? p.position}</Badge> },
    { key: 'nextEndDate', header: 'Next end date', width: '120px', render: (p) => (p.nextEndDate ? fmtDate(p.nextEndDate) : <span className="text-subtle">—</span>) },
  ];
  const licenceCols: Column<PortalLicence>[] = [
    { key: 'name', header: 'Licence', render: (l) => <div className="leading-tight min-w-0"><div className="font-medium truncate">{l.name}</div><div className="text-[11.5px] text-subtle truncate">{titleOf(l)}</div></div> },
    { key: 'quantity', header: 'Seats', width: '110px', className: 'text-right tabular-nums', render: (l) => (l.metric === 'site' ? 'Unlimited' : `${fmtNumber(l.quantity)} ${METRIC_LABEL[l.metric] ?? ''}`) },
    { key: 'installed', header: 'In use', width: '80px', className: 'text-right tabular-nums', render: (l) => fmtNumber(l.installed) },
    { key: 'term', header: 'Term', width: '200px', render: (l) => (l.endDate ? <div className="leading-tight whitespace-nowrap"><div>{l.startDate ? `${fmtDate(l.startDate)} → ` : ''}{fmtDate(l.endDate)}</div><div className={`text-[11.5px] ${l.status === 'renewed' ? 'text-subtle' : l.daysLeft !== null && l.daysLeft < 0 ? 'text-red-600' : l.daysLeft !== null && l.daysLeft <= 30 ? 'text-amber-600' : 'text-muted'}`}>{l.status === 'renewed' ? 'renewed' : countdown(l.daysLeft)}</div></div> : <span className="text-muted">{l.startDate ? `${fmtDate(l.startDate)} → ` : ''}<span className="text-subtle">no end date</span></span>) },
    { key: 'renewalDate', header: 'Renewal date', width: '120px', render: (l) => (l.renewalDate ? <span className="whitespace-nowrap">{fmtDate(l.renewalDate)}{l.autoRenew ? <span className="text-subtle text-[11px]"> · auto</span> : null}</span> : <span className="text-subtle">—</span>) },
    { key: 'contract', header: 'Contract', width: '120px', render: (l) => (l.contractNumber ? <span className="font-mono text-xs">{l.contractNumber}</span> : <span className="text-subtle">—</span>) },
    { key: 'status', header: 'Status', width: '110px', render: (l) => <Badge color={LICENCE_STATUS_COLORS[l.status] ?? 'slate'} dot>{STATUS_LABEL[l.status] ?? l.status}</Badge> },
  ];
  const installCols: Column<PortalInstallation>[] = [
    { key: 'title', header: 'Title', render: (i) => <div className="leading-tight min-w-0"><div className="font-medium truncate">{titleOf(i)}</div>{i.edition && <div className="text-[11.5px] text-subtle">{i.edition}</div>}</div> },
    { key: 'version', header: 'Version', width: '130px', render: (i) => <span className="font-mono text-xs">{i.version ?? '—'}</span> },
    { key: 'host', header: 'Host', render: (i) => i.host ?? <span className="text-subtle">—</span> },
    { key: 'user', header: 'User', render: (i) => i.assignedUser ?? <span className="text-subtle">—</span> },
    { key: 'source', header: 'How', width: '100px', render: (i) => <span className="text-muted">{SOURCE_LABEL[i.source] ?? i.source}</span> },
    { key: 'lastSeenAt', header: 'Last seen', width: '120px', render: (i) => <span className="text-muted">{i.lastSeenAt ? relativeTime(i.lastSeenAt) : '—'}</span> },
  ];

  const listTotal = view === 'licences' ? licences.data?.total : view === 'installations' ? installations.data?.total : positions.length;
  const loading = view === 'licences' ? licences.isLoading : view === 'installations' ? installations.isLoading : summary.isLoading;

  return (
    <div className="max-w-6xl flex flex-col gap-4">
      <PageHeader
        title="Software"
        subtitle={`The titles we track for your organisation and how their licences are used${d?.preview ? ' · preview' : ''}`}
        actions={<Button size="sm" variant="outline" icon={<LifeBuoy className="h-4 w-4" />} onClick={() => navigate('/portal/tickets/new')}>Report an issue</Button>}
      />
      <ModuleNav items={PORTAL_ASSET_MODULES} />
      {summary.isError && <ErrorBlock error={summary.error} retry={() => summary.refetch()} />}

      {!d && summary.isLoading && <KpiSkeleton count={4} />}
      {d && (
        <KpiGrid
          items={[
            { label: 'Titles in use', value: fmtNumber(d.totals.titles), icon: <Package className="h-4 w-4" />, hint: 'with an installation or a licence', onClick: () => set({ ...VIEW_RESET, view: 'titles' }), active: view === 'titles' },
            { label: 'Installations', value: fmtNumber(d.totals.installations), icon: <HardDrive className="h-4 w-4" />, hint: 'on your devices and for your users', onClick: () => set({ ...VIEW_RESET, view: 'installations' }), active: view === 'installations' },
            { label: 'Over-deployed', value: fmtNumber(d.totals.overDeployed + d.totals.unlicensed), tone: d.totals.overDeployed + d.totals.unlicensed ? 'bad' : 'good', icon: <AlertOctagon className="h-4 w-4" />, hint: `${fmtNumber(d.totals.unlicensed)} without a licence in term`, onClick: () => set({ ...VIEW_RESET, view: 'titles' }) },
            { label: 'Licences ending · 90 d', value: fmtNumber(d.totals.expiring90), tone: d.totals.expiring90 ? 'warn' : 'good', icon: <CalendarClock className="h-4 w-4" />, hint: 'renewal decisions coming up', onClick: () => set({ ...VIEW_RESET, view: 'licences' }), active: view === 'licences' },
          ]}
        />
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <Segmented
          size="sm"
          options={[
            { value: 'titles' as View, label: 'Titles & position', count: d?.totals.titles },
            { value: 'licences' as View, label: 'Licences', count: view === 'licences' ? licences.data?.total : undefined },
            { value: 'installations' as View, label: 'Installations', count: view === 'installations' ? installations.data?.total : undefined },
          ]}
          value={view}
          onChange={(v) => set({ ...VIEW_RESET, view: v })}
        />
        <label className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="h-4 w-4 text-subtle absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input className="input pl-8 h-9" placeholder={view === 'titles' ? 'Search titles…' : view === 'licences' ? 'Search licences or titles…' : 'Search titles, hosts or users…'} value={state.q ?? ''} onChange={(e) => set({ q: e.target.value })} aria-label="Search" />
        </label>
        {listTotal !== undefined && <span className="text-[12.5px] text-muted">{fmtNumber(listTotal)} {view === 'titles' ? (listTotal === 1 ? 'title' : 'titles') : view === 'licences' ? (listTotal === 1 ? 'licence' : 'licences') : listTotal === 1 ? 'installation' : 'installations'}</span>}
      </div>

      <div className="card overflow-hidden">
        {view === 'titles' && <DataTable columns={titleCols} rows={positions} loading={loading} dense rowKey={(p) => p.productId} onRowClick={(p) => setSelected(p)} rowClassName={(p) => (p.position === 'over_deployed' || p.position === 'unlicensed' ? 'row-rail-bad' : p.position === 'under_deployed' ? 'row-rail-warn' : undefined)} empty={<EmptyState icon={<Package className="h-5 w-5" />} title="No software on record" description="Titles appear here once we record installations or licences for your organisation." />} />}
        {view === 'licences' && (
          <>
            <DataTable columns={licenceCols} rows={licences.data?.items ?? []} loading={loading} dense rowClassName={(l) => (l.status === 'expired' ? 'row-rail-bad' : l.status === 'expiring' ? 'row-rail-warn' : undefined)} empty={<EmptyState icon={<CalendarClock className="h-5 w-5" />} title="No licences on record" description="Licence entitlements we manage for you appear here with their term and renewal date." />} />
            <Pagination page={page} pageSize={50} total={licences.data?.total ?? 0} onPage={setPage} />
          </>
        )}
        {view === 'installations' && (
          <>
            <DataTable columns={installCols} rows={installations.data?.items ?? []} loading={loading} dense empty={<EmptyState icon={<HardDrive className="h-5 w-5" />} title="No installations on record" description="Installations appear here as we record or discover them on your devices." />} />
            <Pagination page={page} pageSize={50} total={installations.data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </div>

      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected ? titleOf(selected) : ''} footer={<Button variant="outline" size="sm" icon={<LifeBuoy className="h-4 w-4" />} onClick={() => navigate('/portal/tickets/new')}>Report an issue</Button>}>
        {selected && (
          <div className="flex flex-col gap-4">
            <KeyValue
              items={[
                { label: 'Category', value: selected.categoryLabel ?? '—' },
                { label: 'Counted', value: METRIC_LABEL[selected.metric] ?? selected.metric },
                { label: 'Installed', value: fmtNumber(selected.installed) },
                { label: 'Licensed', value: selected.entitled === null ? 'Unlimited' : fmtNumber(selected.entitled) },
                { label: 'Unused', value: selected.unused === null ? '—' : fmtNumber(selected.unused) },
                { label: 'Position', value: <Badge color={COMPLIANCE_COLORS[selected.position] ?? 'slate'} dot>{POSITION_LABEL[selected.position] ?? selected.position}</Badge> },
                { label: 'Next end date', value: selected.nextEndDate ? fmtDate(selected.nextEndDate) : '—' },
                { label: 'In use', value: selected.utilisationPct === null ? '—' : `${selected.utilisationPct}%` },
              ]}
            />
            <div>
              <div className="text-[12px] font-medium text-muted mb-2">Licences behind this title</div>
              {drawerLicences.isLoading && <div className="text-[12.5px] text-subtle">Loading…</div>}
              {drawerLicences.data && (drawerLicences.data.items.length ? (
                <ul className="flex flex-col divide-y divide-default border border-default rounded-lg">
                  {drawerLicences.data.items.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                      <div className="min-w-0"><div className="font-medium truncate">{l.name}</div><div className="text-[11.5px] text-subtle">{l.metric === 'site' ? 'Unlimited' : `${fmtNumber(l.quantity)} ${METRIC_LABEL[l.metric] ?? ''}`}{l.endDate ? ` · ends ${fmtDate(l.endDate)}` : ' · no end date'}</div></div>
                      <Badge color={LICENCE_STATUS_COLORS[l.status] ?? 'slate'} dot>{STATUS_LABEL[l.status] ?? l.status}</Badge>
                    </li>
                  ))}
                </ul>
              ) : <div className="text-[12.5px] text-subtle">No licence recorded for this title.</div>)}
            </div>
            <Button variant="ghost" size="sm" className="self-start" onClick={() => { setSelected(null); set({ ...VIEW_RESET, view: 'installations', productId: selected.productId }); }}>See where it is installed</Button>
          </div>
        )}
      </Drawer>
    </div>
  );
}
