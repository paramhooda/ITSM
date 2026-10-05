import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Package, HardDrive, AlertOctagon, ShieldOff, CalendarClock } from 'lucide-react';
import { PageHeader, ModuleNav, Select, ErrorBlock, Badge } from '@/components/ui';
import { ASSET_MODULES } from '@/layouts/modules';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { Panel, RowList, KpiSkeleton, Skeleton, Stat } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useForwardListParams } from '@/hooks/useForwardListParams';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDate, fmtMoney, fmtNumber } from '@/lib/format';
import { COMPLIANCE_COLORS, INSTALL_SOURCE_COLORS } from '@/lib/statusColors';
import { withQuery } from '@/components/overview/api';
import { SoftwareNav } from '@/components/software/SoftwareNav';
import { softwareApi, softwareKeys, daysLeftClass, daysLeftText } from '@/components/software/api';

/** Software home: what is installed, how the licence position looks, and which licences end next. */
export default function SoftwareOverviewPage() {
  const forwarding = useForwardListParams('/assets/software/installations');
  const customers = useCustomersLookup();
  // Local, not in the URL: a query-bearing URL on the overview is forwarded to the installations list.
  const [customer, setCustomer] = useState<string>('');
  const customerId = customer || undefined;
  const q = useQuery({ queryKey: softwareKeys.overview(customerId), queryFn: () => softwareApi.overview(customerId), refetchInterval: 60_000, placeholderData: (p) => p, enabled: !forwarding });
  const d = q.data;
  if (forwarding) return null;
  const titles = (params: Record<string, string | undefined> = {}) => withQuery('/assets/software/titles', { ...params, customerId });
  const installations = (params: Record<string, string | undefined> = {}) => withQuery('/assets/software/installations', { ...params, customerId });
  const compliance = (params: Record<string, string | undefined> = {}) => withQuery('/assets/software/compliance', { ...params, customerId });
  const renewals = (days: number) => withQuery('/assets/software/renewals', { days: String(days), customerId });
  const overDeployed = d ? (d.positions.find((b) => b.key === 'over_deployed')?.count ?? 0) : 0;
  const unlicensed = d ? (d.positions.find((b) => b.key === 'unlicensed')?.count ?? 0) : 0;
  const ending90 = d ? d.renewals.d30 + d.renewals.d90 : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Software"
        subtitle="Titles, installations, licences and the compliance position at a glance"
        actions={<Select className="w-48 h-8 py-0 text-[13px]" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />}
      />
      <ModuleNav items={ASSET_MODULES} />
      <SoftwareNav />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}

      {!d && q.isLoading && <KpiSkeleton count={5} />}
      {d && (
        <KpiGrid
          columns={5}
          items={[
            { label: 'Titles in use', value: fmtNumber(d.titlesInUse), icon: <Package className="h-4 w-4" />, hint: `${fmtNumber(d.licencesActive)} licences in term`, to: titles({ inUseOnly: 'true' }) },
            { label: 'Installations', value: fmtNumber(d.installations), icon: <HardDrive className="h-4 w-4" />, hint: `on ${fmtNumber(d.hosts)} hosts · ${fmtNumber(d.unlinked)} not linked`, to: installations() },
            { label: 'Over-deployed', value: fmtNumber(overDeployed), tone: overDeployed ? 'bad' : 'good', icon: <AlertOctagon className="h-4 w-4" />, hint: 'more installed than licensed', to: compliance({ position: 'over_deployed' }) },
            { label: 'Unlicensed', value: fmtNumber(unlicensed), tone: unlicensed ? 'bad' : 'good', icon: <ShieldOff className="h-4 w-4" />, hint: 'installed with no licence in term', to: compliance({ position: 'unlicensed' }) },
            { label: 'Ending · 90d', value: fmtNumber(ending90), tone: ending90 ? 'warn' : 'good', icon: <CalendarClock className="h-4 w-4" />, hint: `licences · ${fmtNumber(d.renewals.expired)} already expired`, to: renewals(90) },
          ]}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="Compliance positions" subtitle="Titles per customer by installed against entitled" to={compliance()} toLabel="Compliance">
          {d ? <BreakdownBar dense items={d.positions.map((b) => ({ label: b.label, value: b.count, color: b.color ?? COMPLIANCE_COLORS[b.key] ?? 'slate', href: compliance({ position: b.key }) }))} emptyText="No installations or licences yet" /> : <Skeleton rows={5} />}
        </Panel>
        <Panel title="Titles by category" subtitle="What kind of software is in use" to={titles({ inUseOnly: 'true' })} toLabel="Titles">
          {d ? <BreakdownBar dense items={d.byCategory.slice(0, 8).map((b) => ({ label: b.label, value: b.count, color: b.color ?? null, href: titles({ inUseOnly: 'true' }) }))} emptyText="No titles in use" /> : <Skeleton rows={5} />}
        </Panel>
        <Panel title="Installations by source" subtitle="Recorded by hand, imported or discovered" to={installations()} toLabel="Installations">
          {d ? <BreakdownBar dense items={d.bySource.map((b) => ({ label: b.label, value: b.count, color: b.color ?? INSTALL_SOURCE_COLORS[b.key] ?? 'slate', href: installations({ source: b.key }) }))} emptyText="No installations yet" /> : <Skeleton rows={4} />}
        </Panel>
        <Panel title="Top over-deployed titles" subtitle="Largest gap between installed and licensed first" to={compliance({ position: 'over_deployed' })} toLabel="Compliance">
          {d ? (
            <RowList
              dense
              empty="Every title is within its entitlement"
              items={d.topOverDeployed.map((t) => ({
                key: `${t.customerId}-${t.productId}`,
                primary: <span className="truncate">{t.title}</span>,
                secondary: `${t.customerName} · ${fmtNumber(t.installed)} installed, ${fmtNumber(t.entitled)} licensed`,
                right: <Badge color={t.entitled === 0 ? 'red' : 'orange'}>{t.entitled === 0 ? 'unlicensed' : `+${fmtNumber(t.installed - t.entitled)}`}</Badge>,
                href: withQuery(`/assets/software/titles/${t.productId}`, { customerId: t.customerId }),
              }))}
            />
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
        <Panel title="Renewals due next" subtitle="Soonest licence end dates" to={renewals(90)} toLabel="Renewals">
          {d ? (
            <RowList
              dense
              empty="No licence ends soon"
              items={d.renewingSoon.map((l) => ({
                key: l.id,
                primary: <span className="truncate">{l.name}</span>,
                secondary: `${l.customerName ?? ''}${l.customerName ? ' · ' : ''}${l.title} · ends ${fmtDate(l.endDate)}`,
                right: <span className={daysLeftClass(l.daysLeft)}>{daysLeftText(l.daysLeft, l.endDate)}</span>,
                href: `/assets/software/licences/${l.id}`,
              }))}
            />
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
        <Panel title="Licence estate" subtitle="Seats, spend and the installations that need a look" to={withQuery('/assets/software/licences', { customerId })} toLabel="Licences">
          {d ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                <Stat label="Licences in term" value={fmtNumber(d.licencesActive)} />
                <Stat label="Seats licensed" value={fmtNumber(d.seatsLicensed)} />
                <Stat label="Spend this year" value={d.spendYear === null ? '—' : fmtMoney(d.spendYear)} />
                <Stat label="Stale installations" value={fmtNumber(d.stale)} tone={d.stale ? 'warn' : 'good'} />
              </div>
              <div>
                <div className="text-[12px] font-medium text-muted mb-1.5">Licence end dates</div>
                <BreakdownBar
                  dense
                  items={[
                    { label: 'Expired', value: d.renewals.expired, color: 'red', href: withQuery('/assets/software/renewals', { status: 'expired', customerId }) },
                    { label: 'Ends within 30 days', value: d.renewals.d30, color: 'amber', href: renewals(30) },
                    { label: 'Ends in 31–90 days', value: d.renewals.d90, color: 'amber', href: renewals(90) },
                    { label: 'Later', value: d.renewals.ok, color: 'green', href: withQuery('/assets/software/licences', { status: 'active', customerId }) },
                    { label: 'Perpetual', value: d.renewals.none, color: 'slate', href: withQuery('/assets/software/licences', { customerId }) },
                  ]}
                />
              </div>
              {!customerId && d.byCustomer.length > 0 && (
                <div>
                  <div className="text-[12px] font-medium text-muted mb-1.5">Installations by customer</div>
                  <BreakdownBar dense items={d.byCustomer.slice(0, 6).map((b) => ({ label: b.label, value: b.count, href: withQuery('/assets/software/installations', { customerId: b.key }) }))} />
                </div>
              )}
            </div>
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
      </div>
    </div>
  );
}
