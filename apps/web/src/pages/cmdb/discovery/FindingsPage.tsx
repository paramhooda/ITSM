import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Sparkles, RefreshCw, CheckCircle2 } from 'lucide-react';
import { PageHeader, ListShell, FilterGroup, FilterOptions, FilterSelect, type AppliedFilter } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtNumber } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { CMDB_MODULES } from '@/layouts/modules';
import { DiscoveryNav } from '@/components/cmdb/CmdbNav';
import { FindingsTable } from './FindingsTable';
import { discoveryApi, discoveryKeys, DIFF_COLORS, FINDING_STATUS_COLORS } from '@/components/cmdb/api';

const DEFAULT_STATUS = 'pending';
const STATUS_OPTIONS = [
  { value: 'pending', label: 'To review' },
  { value: 'applied', label: 'Applied' },
  { value: 'ignored', label: 'Ignored' },
];
const DIFF_OPTIONS = [
  { value: 'new', label: 'New devices' },
  { value: 'changed', label: 'Changed' },
  { value: 'unchanged', label: 'Unchanged' },
];

/** The review queue across every source: what discovery found, and what to do with it. */
export default function FindingsPage() {
  const navigate = useNavigate();
  const { state, set } = useListState({ status: DEFAULT_STATUS });
  const customers = useCustomersLookup();
  const sources = useQuery({ queryKey: discoveryKeys.sources(state.customerId), queryFn: () => discoveryApi.sources(state.customerId), staleTime: 60_000 });
  const statsParams = useMemo(() => ({ customerId: state.customerId || undefined, sourceId: state.sourceId || undefined }), [state.customerId, state.sourceId]);
  const stats = useQuery({ queryKey: discoveryKeys.findingStats(statsParams), queryFn: () => discoveryApi.findingStats(statsParams), staleTime: 30_000 });
  const [total, setTotal] = useState<number>();
  const s = stats.data;
  const pending = s?.byStatus.pending ?? 0;
  const customerItems = customers.data?.items ?? [];
  const sourceItems = sources.data?.items ?? [];

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode, keys: string[] = [key]) => applied.push({ key, label, onRemove: () => set(Object.fromEntries(keys.map((k) => [k, undefined]))) });
  if (state.q) addApplied('q', `Search: “${state.q}”`);
  if (state.status && state.status !== DEFAULT_STATUS) addApplied('status', `Status: ${STATUS_OPTIONS.find((o) => o.value === state.status)?.label ?? state.status}`);
  if (state.diffStatus) addApplied('diffStatus', `Diff: ${DIFF_OPTIONS.find((o) => o.value === state.diffStatus)?.label ?? state.diffStatus}`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`, ['customerId', 'sourceId']);
  if (state.sourceId) addApplied('sourceId', `Source: ${sourceItems.find((x) => x.id === state.sourceId)?.name ?? '…'}`);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Discovery findings" subtitle="Every device a scan has seen, matched against the CMDB. Apply to create or update items, ignore what does not belong." />
      <ListShell
        id="discovery-findings"
        modules={CMDB_MODULES}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'IP, hostname, serial…' }}
        filters={
          <>
            <FilterGroup label="Status">
              <FilterOptions options={STATUS_OPTIONS.map((o) => ({ ...o, dot: dotClass(FINDING_STATUS_COLORS[o.value]), count: s ? s.byStatus[o.value] ?? 0 : undefined }))} value={state.status} onChange={(v) => set({ status: v as string | undefined })} />
            </FilterGroup>
            <FilterGroup label="Diff">
              <FilterOptions options={DIFF_OPTIONS.map((o) => ({ ...o, dot: dotClass(DIFF_COLORS[o.value]), count: s ? s.byDiff[o.value] ?? 0 : undefined }))} value={state.diffStatus} onChange={(v) => set({ diffStatus: v as string | undefined })} />
            </FilterGroup>
            <FilterGroup label="Customer">
              <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value, sourceId: undefined })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
            </FilterGroup>
            <FilterGroup label="Source">
              <FilterSelect value={state.sourceId ?? ''} onChange={(e) => set({ sourceId: e.target.value })} placeholder="All sources" options={sourceItems.map((x) => ({ value: x.id, label: x.name }))} />
            </FilterGroup>
          </>
        }
        applied={applied}
        activeCount={applied.length}
        onClear={() => set({ q: undefined, status: undefined, diffStatus: undefined, customerId: undefined, sourceId: undefined })}
        count={total !== undefined ? `${fmtNumber(total)} ${total === 1 ? 'finding' : 'findings'}` : undefined}
        quick={<DiscoveryNav />}
        insights={
          <InsightBand
            id="discovery-findings"
            loading={stats.isLoading}
            summary={s ? `${fmtNumber(s.total)} findings` : undefined}
            kpis={
              s
                ? [
                    { label: 'To review', value: fmtNumber(pending), tone: pending ? 'warn' : 'good', icon: <ClipboardList className="h-4 w-4" />, hint: 'pending your decision', onClick: () => set({ status: 'pending', diffStatus: undefined }), scrollTo: true, active: state.status === 'pending' && !state.diffStatus },
                    { label: 'New devices', value: fmtNumber(s.byDiff.new ?? 0), tone: (s.byDiff.new ?? 0) ? 'accent' : 'default', icon: <Sparkles className="h-4 w-4" />, hint: 'no matching CI yet', onClick: () => set({ status: 'pending', diffStatus: 'new' }), scrollTo: true, active: state.status === 'pending' && state.diffStatus === 'new' },
                    { label: 'Changed', value: fmtNumber(s.byDiff.changed ?? 0), tone: (s.byDiff.changed ?? 0) ? 'warn' : 'default', icon: <RefreshCw className="h-4 w-4" />, hint: 'differs from the CI on record', onClick: () => set({ status: 'pending', diffStatus: 'changed' }), scrollTo: true, active: state.status === 'pending' && state.diffStatus === 'changed' },
                    { label: 'Applied', value: fmtNumber(s.byStatus.applied ?? 0), tone: 'good', icon: <CheckCircle2 className="h-4 w-4" />, hint: `${fmtNumber(s.byStatus.ignored ?? 0)} ignored`, onClick: () => set({ status: 'applied', diffStatus: undefined }), scrollTo: true, active: state.status === 'applied' },
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
        }
      >
        <FindingsTable showSource controls={false} onTotal={setTotal} />
      </ListShell>
    </div>
  );
}
