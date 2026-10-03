import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileSignature, CalendarClock, CalendarX2, Ban, Plus } from 'lucide-react';
import { PageHeader, ModuleNav, Button, Select, ErrorBlock, Badge } from '@/components/ui';
import { CONTRACT_MODULES } from '@/layouts/modules';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { Panel, RowList, Stat, KpiSkeleton, Skeleton } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { TrendChart } from '@/components/dashboards/TrendChart';
import { useForwardListParams } from '@/hooks/useForwardListParams';
import { useCustomersLookup, useLookups } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtDate, fmtNumber, titleCase } from '@/lib/format';
import { CONTRACT_STATUS_COLORS } from '@/lib/statusColors';
import { overviewApi, ovKeys, isUuid, withQuery, ymd } from '@/components/overview/api';

const monthLabel = (m: string) => (/^\d{4}-\d{2}/.test(m) ? new Date(`${m.slice(0, 7)}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : m);

/** Contracts home: what expires when, how entitlements are consumed, where scope and paperwork are missing. */
export default function ContractsOverviewPage() {
  const forwarding = useForwardListParams('/contracts/list');
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const { byKey } = useLookups();
  const customers = useCustomersLookup();
  // Local, not in the URL: a query-bearing URL on the overview is forwarded to the list.
  const [customerId, setCustomerId] = useState<string>('');
  const cid = customerId || undefined;
  const q = useQuery({ queryKey: ovKeys.contracts(cid), queryFn: () => overviewApi.contracts(cid), refetchInterval: 60_000, placeholderData: (p) => p, enabled: !forwarding });
  const d = q.data;
  if (forwarding) return null;
  const list = (params: Record<string, string | undefined> = {}) => withQuery('/contracts/list', { ...params, customerId: cid });
  const entitlements = (params: Record<string, string | undefined> = {}) => withQuery('/contracts/entitlements', { ...params, customerId: cid });
  const statusColor = (key: string) => byKey('contract_status', key)?.color ?? CONTRACT_STATUS_COLORS[key] ?? 'slate';
  const typeLink = (key: string) => {
    const id = isUuid(key) ? key : byKey('contract_type', key)?.id;
    return id ? list({ typeId: id }) : list();
  };
  const since30 = ymd(new Date(Date.now() - 30 * 86_400_000));
  const timeline = d ? d.expiryTimeline.map((m) => ({ month: m.month, count: m.count })) : [];
  const hasTimeline = timeline.some((m) => m.count > 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Contracts & Scope"
        subtitle="Expiries, entitlement consumption and scope coverage"
        actions={
          <>
            <Select className="w-48 h-8 py-0 text-[13px]" value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
            {can('contracts:manage') && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => navigate(list({ new: '1' }))}>New contract</Button>}
          </>
        }
      />
      <ModuleNav items={CONTRACT_MODULES} />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}

      {!d && q.isLoading && <KpiSkeleton count={5} />}
      {d && (
        <KpiGrid
          columns={5}
          items={[
            { label: 'Active contracts', value: fmtNumber(d.byStatus.filter((b) => b.key === 'active' || b.key === 'expiring').reduce((n, b) => n + b.count, 0)), icon: <FileSignature className="h-4 w-4" />, hint: `${fmtNumber(d.total)} in total`, to: list({ status: 'active,expiring' }) },
            { label: 'Expiring · 30d', value: fmtNumber(d.expiring.d30), tone: d.expiring.d30 ? 'bad' : 'good', icon: <CalendarClock className="h-4 w-4" />, hint: `${fmtNumber(d.expiring.d60)} within 60 days`, to: list({ expiringWithinDays: '30' }) },
            { label: 'Expiring · 90d', value: fmtNumber(d.expiring.d90), tone: d.expiring.d90 ? 'warn' : 'good', icon: <CalendarClock className="h-4 w-4" />, hint: 'renewals to plan', to: list({ expiringWithinDays: '90' }) },
            { label: 'Expired', value: fmtNumber(d.expiring.expired), tone: d.expiring.expired ? 'bad' : 'good', icon: <CalendarX2 className="h-4 w-4" />, hint: 'past the end date, not renewed', to: list({ status: 'expired' }) },
            { label: 'Entitlements exhausted', value: fmtNumber(d.entitlements.exhausted), tone: d.entitlements.exhausted ? 'bad' : 'good', icon: <Ban className="h-4 w-4" />, hint: `${fmtNumber(d.entitlements.overThreshold)} over threshold`, to: entitlements({ status: 'exhausted' }) },
          ]}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="Expiry timeline" subtitle="Contracts ending per month, next 12 months" className="lg:col-span-2" to={list({ expiringWithinDays: '90' })} toLabel="Expiring ≤ 90 d">
          {d ? <TrendChart data={hasTimeline ? timeline : []} x="month" kind="bar" series={[{ key: 'count', label: 'Contracts ending' }]} height={220} xFormatter={monthLabel} /> : <Skeleton rows={6} />}
        </Panel>
        <Panel title="Expiring next" subtitle="Soonest end dates" to={list({ expiringWithinDays: '90' })} toLabel="View all">
          {d ? (
            <RowList
              dense
              empty="No contracts end in the next 90 days"
              items={d.expiringSoon.slice(0, 8).map((c) => ({
                key: c.id,
                primary: c.name,
                secondary: `${c.number} · ${c.customerName} · ends ${fmtDate(c.endDate)}`,
                right: <Badge color={c.daysLeft < 0 ? 'red' : c.daysLeft <= 30 ? 'amber' : 'slate'}>{c.daysLeft < 0 ? 'expired' : c.daysLeft === 0 ? 'today' : `${c.daysLeft}d left`}</Badge>,
                href: `/contracts/${c.id}`,
              }))}
            />
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
        <Panel title="By status and type" subtitle="Click a row to list those contracts" to={list()} toLabel="Contracts">
          {d ? (
            <>
              <BreakdownBar dense items={d.byStatus.map((b) => ({ label: b.label || titleCase(b.key), value: b.count, color: b.color ?? statusColor(b.key), href: list({ status: b.key }) }))} emptyText="No contracts yet" />
              <div className="mt-3 pt-3 border-t border-default">
                <BreakdownBar dense items={d.byType.map((b) => ({ label: b.label, value: b.count, color: b.color ?? null, href: typeLink(b.key) }))} emptyText="No contract types in use" />
              </div>
            </>
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
        <Panel title="Entitlement health" subtitle={d ? `${fmtNumber(d.entitlements.total)} active entitlements` : 'Consumption against limits'} to={entitlements()} toLabel="Entitlements">
          {d ? (
            <>
              <BreakdownBar
                dense
                emptyText="No entitlements yet"
                items={[
                  { label: 'Within limits', value: d.entitlements.ok, color: 'green', href: entitlements({ status: 'ok' }) },
                  { label: 'Over threshold', value: d.entitlements.overThreshold, color: 'amber', href: entitlements({ status: 'over_threshold' }) },
                  { label: 'Exhausted', value: d.entitlements.exhausted, color: 'red', href: entitlements({ status: 'exhausted' }) },
                ].filter((i) => d.entitlements.total > 0)}
              />
              {d.entitlements.byType.length > 0 && (
                <div className="mt-3 pt-3 border-t border-default">
                  <BreakdownBar dense items={d.entitlements.byType.map((b) => ({ label: b.label, value: b.count, color: b.color ?? null, href: entitlements() }))} />
                </div>
              )}
            </>
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
        <Panel title="Scope & health" subtitle="Where contracts are incomplete" to={list()} toLabel="Contracts">
          {d ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-4">
              <Link to={list()} className="block rounded-md hover:bg-surface-2 -mx-1 px-1"><Stat label="Without scope items" value={fmtNumber(d.scope.contractsWithoutScope)} tone={d.scope.contractsWithoutScope ? 'warn' : 'good'} /></Link>
              <Link to={withQuery('/tickets', { scopeStatus: 'out_of_scope', createdFrom: since30, customerId: cid })} className="block rounded-md hover:bg-surface-2 -mx-1 px-1"><Stat label="Out-of-scope tickets · 30d" value={fmtNumber(d.scope.outOfScopeTickets30d)} tone={d.scope.outOfScopeTickets30d ? 'warn' : 'good'} /></Link>
              <Link to={list({ status: 'active,expiring' })} className="block rounded-md hover:bg-surface-2 -mx-1 px-1"><Stat label="No signed agreement" value={fmtNumber(d.health.missingAgreement)} tone={d.health.missingAgreement ? 'bad' : 'good'} /></Link>
              <Link to={list({ status: 'active,expiring' })} className="block rounded-md hover:bg-surface-2 -mx-1 px-1"><Stat label="No SLA policy" value={fmtNumber(d.health.noSlaPolicy)} tone={d.health.noSlaPolicy ? 'warn' : 'good'} /></Link>
              <Link to={list({ status: 'active,expiring' })} className="block rounded-md hover:bg-surface-2 -mx-1 px-1"><Stat label="No services" value={fmtNumber(d.health.noServices)} tone={d.health.noServices ? 'warn' : 'good'} /></Link>
            </div>
          ) : (
            <Skeleton rows={4} />
          )}
        </Panel>
      </div>
    </div>
  );
}
