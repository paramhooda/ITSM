import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Radar, Play, ClipboardList, CheckCircle2, Plus, ArrowRight, Server } from 'lucide-react';
import { PageHeader, Button, Select, ErrorBlock, Badge } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel, RowList } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber, relativeTime } from '@/lib/format';
import { CmdbNav, DiscoveryNav } from '@/components/cmdb/CmdbNav';
import { SourceDrawer } from '@/components/cmdb/SourceDrawer';
import { RunStatusBadge, runSummary, runWhen } from '@/components/cmdb/DiscoveryBits';
import { discoveryApi, discoveryKeys } from '@/components/cmdb/api';

const STEPS = [
  { key: 'sources', title: 'Sources', text: 'Subnets and SNMP credentials per customer site.', to: '/cmdb/discovery/sources', icon: Radar },
  { key: 'runs', title: 'Runs', text: 'Scheduled or on-demand scans; each run keeps its log.', to: '/cmdb/discovery/runs', icon: Play },
  { key: 'findings', title: 'Findings', text: 'Devices seen, matched to CIs, flagged new or changed.', to: '/cmdb/discovery/findings', icon: ClipboardList },
  { key: 'cmdb', title: 'CMDB', text: 'Apply to create or update CIs, interfaces and links.', to: '/cmdb/cis?discovered=true', icon: Server },
];

/** Discovery home: where scanning stands and what is waiting for review. */
export default function DiscoveryOverviewPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const { state, set } = useListState();
  const customers = useCustomersLookup();
  const [drawer, setDrawer] = useState(false);
  const providers = useQuery({ queryKey: discoveryKeys.providers, queryFn: () => discoveryApi.providers(), staleTime: 300_000 });
  const q = useQuery({ queryKey: discoveryKeys.overview(state.customerId), queryFn: () => discoveryApi.overview(state.customerId), refetchInterval: 15_000, placeholderData: (p) => p });
  const d = q.data;
  const active = (d?.runs.running ?? 0) + (d?.runs.queued ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Discovery" subtitle="Scan customer networks, review what was found and keep the CMDB current" actions={can('discovery:manage') ? <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setDrawer(true)}>New source</Button> : undefined} />
      <CmdbNav />
      <div className="flex flex-wrap items-center gap-2">
        <DiscoveryNav />
        <Select className="w-48 h-9 py-0 text-[13px] ml-auto" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value }, false)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
      </div>
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}

      <InsightBand
        id="discovery"
        loading={q.isLoading}
        summary={d ? `${fmtNumber(d.sources.total)} sources · ${fmtNumber(d.findings.pending)} findings to review` : undefined}
        kpis={
          d
            ? [
                { label: 'Sources', value: `${fmtNumber(d.sources.active)}/${fmtNumber(d.sources.total)}`, icon: <Radar className="h-4 w-4" />, hint: `${fmtNumber(d.sources.scheduled)} on a schedule`, onClick: () => navigate('/cmdb/discovery/sources') },
                { label: 'Runs in progress', value: fmtNumber(active), tone: active ? 'accent' : 'default', icon: <Play className="h-4 w-4" />, hint: `${fmtNumber(d.runs.completed7d)} completed · ${fmtNumber(d.runs.failed7d)} failed in 7 days`, onClick: () => navigate('/cmdb/discovery/runs') },
                { label: 'To review', value: fmtNumber(d.findings.pending), tone: d.findings.pending ? 'warn' : 'good', icon: <ClipboardList className="h-4 w-4" />, hint: `${fmtNumber(d.findings.pendingNew)} new devices · ${fmtNumber(d.findings.pendingChanged)} changed`, onClick: () => navigate('/cmdb/discovery/findings?status=pending') },
                { label: 'Applied · 7 days', value: fmtNumber(d.findings.applied7d), tone: 'good', icon: <CheckCircle2 className="h-4 w-4" />, hint: `${fmtNumber(d.findings.ignored7d)} ignored`, onClick: () => navigate('/cmdb/discovery/findings?status=applied') },
              ]
            : []
        }
        panels={
          d && (
            <>
              <Panel title="Recent runs" subtitle="Latest scans across all sources" to="/cmdb/discovery/runs" toLabel="All runs">
                <RowList dense empty="No runs yet. Create a source and press Run now." items={d.lastRuns.slice(0, 7).map((r) => ({ key: r.id, leading: <RunStatusBadge status={r.status} />, primary: `${r.sourceName ?? 'Source'}${r.customerName ? ` · ${r.customerName}` : ''}`, secondary: runSummary(r), right: runWhen(r), href: `/cmdb/discovery/runs/${r.id}` }))} />
              </Panel>
              <Panel title="Review backlog by customer" subtitle="Pending findings">
                <BreakdownBar dense items={[...d.byCustomer].sort((a, b) => b.pendingFindings - a.pendingFindings).filter((c) => c.pendingFindings > 0).slice(0, 8).map((c) => ({ label: c.customerName, value: c.pendingFindings, color: 'amber', href: `/cmdb/discovery/findings?status=pending&customerId=${c.customerId}` }))} emptyText="Nothing waiting for review" />
              </Panel>
            </>
          )
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        {STEPS.map((s, i) => (
          <button key={s.key} onClick={() => navigate(s.to)} className="card p-4 text-left hover:border-strong hover:shadow-raised transition-[box-shadow,border-color] group">
            <div className="flex items-center justify-between">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-600 border border-brand-600/10"><s.icon className="h-4 w-4" /></span>
              <span className="text-[11px] text-subtle">Step {i + 1}</span>
            </div>
            <div className="mt-2 text-[13.5px] font-semibold flex items-center gap-1.5">{s.title}<ArrowRight className="h-3.5 w-3.5 text-subtle opacity-0 group-hover:opacity-100 transition-opacity" /></div>
            <div className="text-[12.5px] text-muted mt-0.5">{s.text}</div>
            {d && (
              <div className="mt-2 text-[12px] text-subtle">
                {s.key === 'sources' && <>{fmtNumber(d.sources.active)} active</>}
                {s.key === 'runs' && (active ? <Badge color="amber">{active} running</Badge> : <>{fmtNumber(d.runs.completed7d)} this week</>)}
                {s.key === 'findings' && (d.findings.pending ? <Badge color="blue">{d.findings.pending} to review</Badge> : <>queue is empty</>)}
                {s.key === 'cmdb' && <>{fmtNumber(d.findings.applied7d)} applied this week</>}
              </div>
            )}
          </button>
        ))}
      </div>
      {d?.byCustomer.length ? (
        <div className="text-[12px] text-subtle">Last activity: {[...d.byCustomer].filter((c) => c.lastRunAt).sort((a, b) => new Date(b.lastRunAt!).getTime() - new Date(a.lastRunAt!).getTime()).slice(0, 3).map((c) => `${c.customerName} ${relativeTime(c.lastRunAt!)}`).join(' · ') || 'no runs yet'}</div>
      ) : null}
      <SourceDrawer open={drawer} onClose={() => setDrawer(false)} source={null} providers={providers.data?.items ?? [{ type: 'network_scan', label: 'Network scan' }]} />
    </div>
  );
}
