import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Sparkles, RefreshCw, CheckCircle2 } from 'lucide-react';
import { PageHeader, Select } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtNumber } from '@/lib/format';
import { CmdbNav, DiscoveryNav } from '@/components/cmdb/CmdbNav';
import { FindingsTable } from './FindingsTable';
import { discoveryApi, discoveryKeys } from '@/components/cmdb/api';

/** The review queue across every source: what discovery found, and what to do with it. */
export default function FindingsPage() {
  const navigate = useNavigate();
  const { state, set } = useListState({ status: 'pending' });
  const customers = useCustomersLookup();
  const sources = useQuery({ queryKey: discoveryKeys.sources(state.customerId), queryFn: () => discoveryApi.sources(state.customerId), staleTime: 60_000 });
  const statsParams = useMemo(() => ({ customerId: state.customerId || undefined, sourceId: state.sourceId || undefined }), [state.customerId, state.sourceId]);
  const stats = useQuery({ queryKey: discoveryKeys.findingStats(statsParams), queryFn: () => discoveryApi.findingStats(statsParams), staleTime: 30_000 });
  const s = stats.data;
  const pending = s?.byStatus.pending ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Discovery findings" subtitle="Every device a scan has seen, matched against the CMDB. Apply to create or update items, ignore what does not belong." />
      <CmdbNav />
      <div className="flex flex-wrap items-center gap-2">
        <DiscoveryNav />
        <div className="ml-auto flex items-center gap-2">
          <Select className="w-44 h-9 py-0 text-[13px]" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value, sourceId: undefined })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          <Select className="w-52 h-9 py-0 text-[13px]" value={state.sourceId ?? ''} onChange={(e) => set({ sourceId: e.target.value })} placeholder="All sources" options={(sources.data?.items ?? []).map((x) => ({ value: x.id, label: x.name }))} />
        </div>
      </div>
      <InsightBand
        id="discovery-findings"
        loading={stats.isLoading}
        summary={s ? `${fmtNumber(s.total)} findings` : undefined}
        kpis={
          s
            ? [
                { label: 'To review', value: fmtNumber(pending), tone: pending ? 'warn' : 'good', icon: <ClipboardList className="h-4 w-4" />, hint: 'pending your decision', onClick: () => set({ status: 'pending', diffStatus: undefined }) },
                { label: 'New devices', value: fmtNumber(s.byDiff.new ?? 0), tone: (s.byDiff.new ?? 0) ? 'accent' : 'default', icon: <Sparkles className="h-4 w-4" />, hint: 'no matching CI yet', onClick: () => set({ status: 'pending', diffStatus: 'new' }) },
                { label: 'Changed', value: fmtNumber(s.byDiff.changed ?? 0), tone: (s.byDiff.changed ?? 0) ? 'warn' : 'default', icon: <RefreshCw className="h-4 w-4" />, hint: 'differs from the CI on record', onClick: () => set({ status: 'pending', diffStatus: 'changed' }) },
                { label: 'Applied', value: fmtNumber(s.byStatus.applied ?? 0), tone: 'good', icon: <CheckCircle2 className="h-4 w-4" />, hint: `${fmtNumber(s.byStatus.ignored ?? 0)} ignored`, onClick: () => set({ status: 'applied', diffStatus: undefined }) },
              ]
            : []
        }
        panels={
          s && (
            <>
              <Panel title="By suggested class" subtitle="What kind of devices the scans found">
                <BreakdownBar dense items={s.bySuggestedType.slice(0, 10).map((t) => ({ label: t.name, value: t.count, href: `/cmdb/classes` }))} emptyText="No findings yet" />
              </Panel>
              <Panel title="Where to start" subtitle="Suggested order of review">
                <ol className="text-[12.5px] text-secondary flex flex-col gap-1.5 list-decimal pl-4">
                  <li><button className="hover:underline text-left" onClick={() => set({ status: 'pending', diffStatus: 'new' })}>New devices</button> — create the CI or ignore printers, phones and guests.</li>
                  <li><button className="hover:underline text-left" onClick={() => set({ status: 'pending', diffStatus: 'changed' })}>Changed</button> — compare side by side, then update the CI.</li>
                  <li><button className="hover:underline text-left" onClick={() => set({ status: 'pending', diffStatus: 'unchanged' })}>Unchanged</button> — apply in bulk to refresh "last seen".</li>
                  <li><button className="hover:underline text-left" onClick={() => navigate('/cmdb/discovery/sources')}>Sources</button> — turn on auto-apply once a source is trusted.</li>
                </ol>
              </Panel>
            </>
          )
        }
      />
      <FindingsTable showSource />
    </div>
  );
}
