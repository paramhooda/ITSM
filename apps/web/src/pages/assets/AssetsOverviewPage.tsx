import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Boxes, Unlink, ShieldCheck, FileSignature, PackagePlus } from 'lucide-react';
import { PageHeader, ModuleNav, Select, ErrorBlock, Badge } from '@/components/ui';
import { ASSET_MODULES } from '@/layouts/modules';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { Panel, RowList, KpiSkeleton, Skeleton, Stat } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useForwardListParams } from '@/hooks/useForwardListParams';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtDate, fmtNumber, titleCase } from '@/lib/format';
import { LIFECYCLE_COLORS, COMPLIANCE_COLORS } from '@/lib/statusColors';
import { ASSET_LIFECYCLE } from '@itsm/shared';
import { overviewApi, ovKeys, isUuid, withQuery } from '@/components/overview/api';
import { coverageItems, COVER_LABEL } from '@/components/overview/coverage';

/** Assets home: how big the register is, where cover is running out, what sits in each lifecycle stage. */
export default function AssetsOverviewPage() {
  const forwarding = useForwardListParams('/assets/inventory');
  const navigate = useNavigate();
  const customers = useCustomersLookup();
  const can = useAuthStore((s) => s.can);
  const canSoftware = can('software:read');
  // Local, not in the URL: a query-bearing URL on the overview is forwarded to the list.
  const [customer, setCustomer] = useState<string>('');
  const customerId = customer || undefined;
  const q = useQuery({ queryKey: ovKeys.assets(customerId), queryFn: () => overviewApi.assets(customerId), refetchInterval: 60_000, placeholderData: (p) => p, enabled: !forwarding });
  const sw = useQuery({ queryKey: ovKeys.software(customerId), queryFn: () => overviewApi.software(customerId), refetchInterval: 60_000, placeholderData: (p) => p, enabled: !forwarding && canSoftware });
  const d = q.data;
  const s = sw.data;
  const software = (path: string, params: Record<string, string | undefined> = {}) => withQuery(path, { ...params, customerId });
  if (forwarding) return null;
  const inventory = (params: Record<string, string | undefined> = {}) => withQuery('/assets/inventory', { ...params, customerId });
  const coverage = (kind: 'warranty' | 'amc') => withQuery('/assets/coverage', { kind, customerId });
  const lifecycleOrder = new Map<string, number>(ASSET_LIFECYCLE.map((s, i) => [s, i]));
  const byLifecycle = d ? [...d.byLifecycle].sort((a, b) => (lifecycleOrder.get(a.key) ?? 99) - (lifecycleOrder.get(b.key) ?? 99)) : [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Assets"
        subtitle="Inventory, warranty and AMC coverage and lifecycle at a glance"
        actions={<Select className="w-48 h-8 py-0 text-[13px]" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />}
      />
      <ModuleNav items={ASSET_MODULES} />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}

      {!d && q.isLoading && <KpiSkeleton count={5} />}
      {d && (
        <KpiGrid
          columns={5}
          items={[
            { label: 'Total assets', value: fmtNumber(d.total), icon: <Boxes className="h-4 w-4" />, hint: `${fmtNumber(d.withCi)} linked to a CI`, to: inventory() },
            { label: 'Without CI', value: fmtNumber(d.withoutCi), tone: d.withoutCi ? 'warn' : 'good', icon: <Unlink className="h-4 w-4" />, hint: 'not tracked in the CMDB', to: inventory({ hasCi: 'false' }) },
            { label: 'Warranty ending · 90d', value: fmtNumber(d.warranty.d30 + d.warranty.d90), tone: d.warranty.d30 + d.warranty.d90 ? 'warn' : 'good', icon: <ShieldCheck className="h-4 w-4" />, hint: `${fmtNumber(d.warranty.expired)} already expired`, to: coverage('warranty') },
            { label: 'AMC ending · 90d', value: fmtNumber(d.amc.d30 + d.amc.d90), tone: d.amc.d30 + d.amc.d90 ? 'warn' : 'good', icon: <FileSignature className="h-4 w-4" />, hint: `${fmtNumber(d.amc.expired)} already expired`, to: coverage('amc') },
            { label: 'Added · 30d', value: fmtNumber(d.addedLast30d), icon: <PackagePlus className="h-4 w-4" />, hint: 'new in the register', to: inventory({ sort: 'createdAt', order: 'desc' }) },
          ]}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="By lifecycle" subtitle="Click a stage to open it" to={withQuery('/assets/lifecycle', { customerId })} toLabel="Lifecycle">
          {d ? <BreakdownBar dense items={byLifecycle.map((b) => ({ label: titleCase(b.key), value: b.count, color: b.color ?? LIFECYCLE_COLORS[b.key] ?? 'slate', href: withQuery('/assets/lifecycle', { stage: b.key, customerId }) }))} emptyText="No assets yet" /> : <Skeleton rows={5} />}
        </Panel>
        <Panel title="By category" subtitle="Where the equipment is" to={inventory()} toLabel="Inventory">
          {d ? <BreakdownBar dense items={d.byCategory.slice(0, 8).map((b) => ({ label: b.label, value: b.count, color: b.color ?? null, href: isUuid(b.key) ? inventory({ categoryId: b.key }) : inventory() }))} emptyText="No assets yet" /> : <Skeleton rows={5} />}
        </Panel>
        <Panel title="By customer" subtitle="Largest registers first" to="/assets/inventory" toLabel="Inventory">
          {d ? <BreakdownBar dense items={d.byCustomer.slice(0, 8).map((b) => ({ label: b.label, value: b.count, href: withQuery('/assets/inventory', { customerId: b.key }) }))} emptyText="No assets yet" /> : <Skeleton rows={5} />}
        </Panel>
        <Panel title="Cover health" subtitle="Warranty and AMC end dates, by how soon" className="lg:col-span-2" to={coverage('warranty')} toLabel="Warranty & AMC">
          {d ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
              {(['warranty', 'amc'] as const).map((kind) => (
                <div key={kind}>
                  <div className="text-[12px] font-medium text-muted mb-1.5">{COVER_LABEL[kind]}</div>
                  <BreakdownBar dense items={coverageItems(kind, d[kind], customerId)} />
                </div>
              ))}
            </div>
          ) : (
            <Skeleton rows={5} />
          )}
        </Panel>
        <Panel title="Cover ending next" subtitle="Soonest warranty and AMC end dates" to={coverage('warranty')} toLabel="View all">
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
                secondary: `${a.tag}${a.customerName ? ` · ${a.customerName}` : ''} · ${fmtDate(a.endDate)}`,
                right: <span className={a.daysLeft < 0 ? 'text-red-600' : a.daysLeft <= 30 ? 'text-amber-600' : undefined}>{a.daysLeft < 0 ? `${Math.abs(a.daysLeft)}d ago` : a.daysLeft === 0 ? 'today' : `${a.daysLeft}d left`}</span>,
                href: `/assets/${a.id}`,
              }))}
            />
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
        {canSoftware && (
          <Panel title="Software and licences" subtitle="Titles in use and how their licences hold up" className="lg:col-span-3" to={software('/assets/software')} toLabel="Software">
            {s ? (
              <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-8 gap-y-4">
                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <Stat label="Titles in use" value={fmtNumber(s.titlesInUse)} />
                  <Stat label="Installations" value={fmtNumber(s.installations)} />
                  <Stat label="Over-deployed" value={fmtNumber(s.positions.find((b) => b.key === 'over_deployed')?.count ?? 0)} tone={s.positions.find((b) => b.key === 'over_deployed')?.count ? 'bad' : 'good'} />
                  <Stat label="Licences ending · 90d" value={fmtNumber(s.renewals.d30 + s.renewals.d90)} tone={s.renewals.d30 + s.renewals.d90 ? 'warn' : 'good'} />
                </div>
                <div>
                  <div className="text-[12px] font-medium text-muted mb-1.5">Compliance positions</div>
                  <BreakdownBar dense items={s.positions.map((b) => ({ label: b.label, value: b.count, color: b.color ?? COMPLIANCE_COLORS[b.key] ?? 'slate', href: software('/assets/software/compliance', { position: b.key }) }))} emptyText="No software recorded yet" />
                </div>
              </div>
            ) : sw.isError ? (
              <div className="text-[12.5px] text-subtle">Software figures are not available.</div>
            ) : (
              <Skeleton rows={4} />
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}
