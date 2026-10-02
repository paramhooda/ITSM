import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PageHeader, ModuleNav, ErrorBlock, DataTable, type Column } from '@/components/ui';
import { PORTAL_ASSET_MODULES } from '@/layouts/modules';
import { Panel, Skeleton } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { fmtNumber } from '@/lib/format';
import { withQuery } from '@/components/overview/api';
import { CoverageBadge } from '@/components/assets/CoverageBadge';
import { portalApi, pk, type PortalAsset, type AssetExpiring } from '@/components/portal/api';
import { portalCoverageItems, portalAssetLink, coverageTotal, COVER_LABEL, PORTAL_INVENTORY, type CoverKind } from '@/components/portal/coverage';

const NEXT = 8;

/** One kind of cover: the time buckets as bars, then the assets whose cover ends soonest. */
function CoverColumn({ kind, buckets, loading }: { kind: CoverKind; buckets: { expired: number; d30: number; d90: number; ok: number; none: number } | undefined; loading: boolean }) {
  const navigate = useNavigate();
  const expiring: AssetExpiring = `${kind}90`;
  const params = { expiring, sort: kind === 'warranty' ? 'warrantyEnd' : 'amcEnd', order: 'asc', page: 1, pageSize: NEXT };
  const next = useQuery({ queryKey: pk.assets(params), queryFn: () => portalApi.assets(params), placeholderData: (p) => p });
  const rows = next.data?.items ?? [];
  const columns: Column<PortalAsset>[] = [
    { key: 'tag', header: 'Tag', width: '110px', render: (a) => <span className="font-mono text-[12.5px] font-medium">{a.tag}</span> },
    { key: 'name', header: 'Name', render: (a) => <div className="min-w-0"><div className="font-medium truncate">{a.name}</div><div className="text-[11.5px] text-muted truncate">{a.siteName ?? '—'}</div></div> },
    { key: 'end', header: `${COVER_LABEL[kind]} ends`, render: (a) => <CoverageBadge coverage={kind === 'warranty' ? a.warranty : a.amc} /> },
  ];
  const all = withQuery(PORTAL_INVENTORY, { expiring });
  return (
    <div className="flex flex-col gap-4 min-w-0">
      <Panel title={COVER_LABEL[kind]} subtitle={buckets ? `${fmtNumber(coverageTotal(buckets))} assets · ${fmtNumber(buckets.expired)} expired · ${fmtNumber(buckets.d30 + buckets.d90)} ending within 90 days` : 'By how soon cover ends'} to={all} toLabel="Ending ≤ 90 d">
        {buckets ? <BreakdownBar dense items={portalCoverageItems(kind, buckets)} /> : loading ? <Skeleton rows={5} /> : <div className="text-[13px] text-subtle py-4 text-center">No cover information</div>}
      </Panel>
      <Panel title="Ending next" subtitle={`${COVER_LABEL[kind]} cover ending within 90 days, soonest first`} padded={false} to={all} toLabel="View all">
        {next.isError ? (
          <ErrorBlock error={next.error} retry={() => next.refetch()} />
        ) : (
          <>
            <DataTable columns={columns} rows={rows} loading={next.isLoading} dense onRowClick={(a) => navigate(portalAssetLink(a, { expiring }))} rowClassName={(a) => { const c = kind === 'warranty' ? a.warranty : a.amc; return c.status === 'expired' ? 'row-rail-bad' : c.status === 'expiring' && (c.days ?? 99) <= 30 ? 'row-rail-warn' : undefined; }} empty={<div className="text-[13px] text-subtle py-8 text-center">No {COVER_LABEL[kind]} cover ends within 90 days</div>} />
            {next.data && next.data.total > rows.length && <div className="text-[12.5px] text-muted px-4 py-2.5 border-t border-default">Showing the first {rows.length} of {fmtNumber(next.data.total)}</div>}
          </>
        )}
      </Panel>
    </div>
  );
}

/** Warranty & AMC module for customers: how cover is distributed in time, and which assets lose it next. */
export default function PortalAssetsCoveragePage() {
  const ov = useQuery({ queryKey: pk.assetsOverview, queryFn: portalApi.assetsOverview, refetchInterval: 60_000, placeholderData: (p) => p });
  const d = ov.data;
  return (
    <div className="max-w-6xl flex flex-col gap-4">
      <PageHeader title="Warranty & AMC" subtitle="Which of your assets lose cover next, and which already have" />
      <ModuleNav items={PORTAL_ASSET_MODULES} />
      {ov.isError && <ErrorBlock error={ov.error} retry={() => ov.refetch()} />}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {(['warranty', 'amc'] as const).map((kind) => (
          <CoverColumn key={kind} kind={kind} buckets={d?.[kind]} loading={ov.isLoading} />
        ))}
      </div>
    </div>
  );
}
