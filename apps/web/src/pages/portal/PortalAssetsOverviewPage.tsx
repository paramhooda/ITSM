import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Boxes, ShieldCheck, FileSignature, ShieldOff } from 'lucide-react';
import { PageHeader, ModuleNav, ErrorBlock, Badge } from '@/components/ui';
import { PORTAL_ASSET_MODULES } from '@/layouts/modules';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { Panel, RowList, KpiSkeleton, Skeleton } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useForwardListParams } from '@/hooks/useForwardListParams';
import { fmtDate, fmtNumber, titleCase } from '@/lib/format';
import { LIFECYCLE_COLORS } from '@/lib/statusColors';
import { ASSET_LIFECYCLE } from '@itsm/shared';
import { isUuid, withQuery } from '@/components/overview/api';
import { portalApi, pk } from '@/components/portal/api';
import { portalCoverageItems, portalAssetLink, COVER_LABEL, PORTAL_INVENTORY } from '@/components/portal/coverage';

/**
 * Assets home for customers: how much equipment we look after, where cover is
 * running out, and what sits at each site and lifecycle stage. Every number
 * opens the inventory with the matching filter.
 */
export default function PortalAssetsOverviewPage() {
  const forwarding = useForwardListParams(PORTAL_INVENTORY);
  const navigate = useNavigate();
  const q = useQuery({ queryKey: pk.assetsOverview, queryFn: portalApi.assetsOverview, refetchInterval: 60_000, placeholderData: (p) => p, enabled: !forwarding });
  const d = q.data;
  if (forwarding) return null;
  const inventory = (params: Record<string, string | undefined> = {}) => withQuery(PORTAL_INVENTORY, params);
  const lifecycleOrder = new Map<string, number>(ASSET_LIFECYCLE.map((s, i) => [s, i]));
  const byLifecycle = d ? [...d.byLifecycle].filter((b) => b.count > 0).sort((a, b) => (lifecycleOrder.get(a.key) ?? 99) - (lifecycleOrder.get(b.key) ?? 99)) : [];
  const warrantyEnding = d ? d.warranty.d30 + d.warranty.d90 : 0;
  const amcEnding = d ? d.amc.d30 + d.amc.d90 : 0;
  const expired = d ? d.warranty.expired + d.amc.expired : 0;

  return (
    <div className="max-w-6xl flex flex-col gap-4">
      <PageHeader title="Assets" subtitle="Your equipment and its cover at a glance" />
      <ModuleNav items={PORTAL_ASSET_MODULES} />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}

      {!d && q.isLoading && <KpiSkeleton count={4} />}
      {d && (
        <KpiGrid
          items={[
            { label: 'Total assets', value: fmtNumber(d.total), icon: <Boxes className="h-4 w-4" />, hint: `across ${fmtNumber(d.bySite.length)} ${d.bySite.length === 1 ? 'site' : 'sites'}`, to: inventory() },
            { label: 'Warranty ending · 90 d', value: fmtNumber(warrantyEnding), tone: warrantyEnding ? 'warn' : 'good', icon: <ShieldCheck className="h-4 w-4" />, hint: `${fmtNumber(d.warranty.d30)} within 30 days`, to: inventory({ expiring: 'warranty90' }) },
            { label: 'AMC ending · 90 d', value: fmtNumber(amcEnding), tone: amcEnding ? 'warn' : 'good', icon: <FileSignature className="h-4 w-4" />, hint: `${fmtNumber(d.amc.d30)} within 30 days`, to: inventory({ expiring: 'amc90' }) },
            { label: 'Expired cover', value: fmtNumber(expired), tone: expired ? 'bad' : 'good', icon: <ShieldOff className="h-4 w-4" />, hint: `${fmtNumber(d.warranty.expired)} warranty · ${fmtNumber(d.amc.expired)} AMC`, to: inventory({ expiring: 'expired' }) },
          ]}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="By category" subtitle="What kind of equipment we look after" to={inventory()} toLabel="Inventory">
          {d ? <BreakdownBar dense items={d.byCategory.slice(0, 8).map((b) => ({ label: b.label, value: b.count, href: isUuid(b.key) ? inventory({ categoryId: b.key }) : inventory() }))} emptyText="No assets on record" /> : <Skeleton rows={5} />}
        </Panel>
        <Panel title="By site" subtitle="Where it is" to={inventory()} toLabel="Inventory">
          {d ? <BreakdownBar dense items={d.bySite.slice(0, 8).map((b) => ({ label: b.label, value: b.count, href: isUuid(b.key) ? inventory({ siteId: b.key }) : inventory() }))} emptyText="No assets on record" /> : <Skeleton rows={5} />}
        </Panel>
        <Panel title="By lifecycle" subtitle="Deployed, in stock, in repair…" to={inventory()} toLabel="Inventory">
          {d ? <BreakdownBar dense items={byLifecycle.map((b) => ({ label: b.label || titleCase(b.key), value: b.count, color: b.color ?? LIFECYCLE_COLORS[b.key] ?? 'slate', href: inventory({ lifecycleStage: b.key }) }))} emptyText="No assets on record" /> : <Skeleton rows={5} />}
        </Panel>
        <Panel title="Cover ending next" subtitle="Soonest warranty and AMC end dates" className="lg:col-span-2" to="/portal/assets/coverage" toLabel="Warranty & AMC">
          {d ? (
            <RowList
              dense
              empty="Nothing ends in the next 90 days"
              items={d.expiringSoon.slice(0, 8).map((a) => ({
                key: `${a.id}-${a.kind}`,
                primary: (
                  <span className="inline-flex items-center gap-2 min-w-0">
                    <span className="truncate">{a.name}</span>
                    <Badge color={a.kind === 'warranty' ? 'blue' : 'violet'}>{COVER_LABEL[a.kind]}</Badge>
                  </span>
                ),
                secondary: `${a.tag}${a.siteName ? ` · ${a.siteName}` : ''} · ends ${fmtDate(a.endDate)}`,
                right: <span className={a.daysLeft < 0 ? 'text-red-600' : a.daysLeft <= 30 ? 'text-amber-600' : undefined}>{a.daysLeft < 0 ? `${Math.abs(a.daysLeft)}d ago` : a.daysLeft === 0 ? 'today' : `${a.daysLeft}d left`}</span>,
                href: portalAssetLink(a, { expiring: a.daysLeft < 0 ? 'expired' : `${a.kind}90` }),
              }))}
            />
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
        <Panel title="Cover health" subtitle="Warranty and AMC end dates, by how soon" to="/portal/assets/coverage" toLabel="Warranty & AMC">
          {d ? (
            <div className="flex flex-col gap-4">
              {(['warranty', 'amc'] as const).map((kind) => (
                <div key={kind}>
                  <div className="text-[12px] font-medium text-muted mb-1.5">{COVER_LABEL[kind]}</div>
                  <BreakdownBar dense items={portalCoverageItems(kind, d[kind])} />
                </div>
              ))}
            </div>
          ) : (
            <Skeleton rows={5} />
          )}
        </Panel>
      </div>
    </div>
  );
}
