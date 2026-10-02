import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, BadgeCheck, UserPlus, FileSignature, Gauge } from 'lucide-react';
import { PageHeader, ModuleNav, ErrorBlock, DataTable, type Column } from '@/components/ui';
import { CUSTOMER_MODULES } from '@/layouts/modules';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { Panel, KpiSkeleton, Skeleton } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useForwardListParams } from '@/hooks/useForwardListParams';
import { useLookups } from '@/hooks/useLookups';
import { fmtNumber, fmtPct } from '@/lib/format';
import { cn } from '@/lib/utils';
import { overviewApi, ovKeys, isUuid, withQuery, type CustomersOverview } from '@/components/overview/api';

type Attention = CustomersOverview['attention'][number];
const SLA_TARGET = 95;

/** Customers home: who needs attention, how service levels hold up per account, how the base is made up. */
export default function CustomersOverviewPage() {
  const forwarding = useForwardListParams('/customers/accounts');
  const navigate = useNavigate();
  const { byKey } = useLookups();
  const q = useQuery({ queryKey: ovKeys.customers, queryFn: () => overviewApi.customers(), refetchInterval: 60_000, placeholderData: (p) => p, enabled: !forwarding });
  const d = q.data;
  if (forwarding) return null;
  const accounts = (params: Record<string, string | undefined> = {}) => withQuery('/customers/accounts', params);
  /** Buckets carry the option key or id; the list filters by id. */
  const optionId = (type: string, key: string) => (isUuid(key) ? key : byKey(type, key)?.id);
  const optionLink = (type: string, param: string, key: string) => {
    const id = optionId(type, key);
    return id ? accounts({ [param]: id, isActive: 'all' }) : accounts({ isActive: 'all' });
  };
  const slaTone = (pct: number | null) => (pct === null ? 'slate' : pct >= SLA_TARGET ? 'green' : pct >= SLA_TARGET - 10 ? 'amber' : 'red');

  const num = (v: number, tone?: 'bad' | 'warn') => <span className={cn('tabular-nums', v > 0 ? (tone === 'bad' ? 'text-red-600 font-medium' : tone === 'warn' ? 'text-amber-600 font-medium' : 'font-medium') : 'text-subtle')}>{fmtNumber(v)}</span>;
  const columns: Column<Attention>[] = [
    { key: 'name', header: 'Customer', render: (r) => <div className="min-w-0"><div className="font-medium truncate">{r.name}</div><div className="text-[11px] text-subtle font-mono">{r.code}</div></div> },
    { key: 'openTickets', header: 'Open', className: 'text-right', render: (r) => num(r.openTickets) },
    { key: 'openP1', header: 'P1', className: 'text-right', render: (r) => num(r.openP1, 'bad') },
    { key: 'breached', header: 'Breached', className: 'text-right', render: (r) => num(r.breached, 'bad') },
    { key: 'sla', header: 'SLA · 30d', className: 'text-right', render: (r) => <span className={cn('tabular-nums', r.slaCompliance30d === null ? 'text-subtle' : r.slaCompliance30d < SLA_TARGET ? 'text-red-600 font-medium' : 'text-emerald-600')}>{fmtPct(r.slaCompliance30d, 0)}</span> },
    { key: 'contracts', header: 'Expiring · 60d', className: 'text-right', render: (r) => num(r.contractsExpiring60d, 'warn') },
    { key: 'entitlements', header: 'Over limit', className: 'text-right', render: (r) => num(r.entitlementsOverThreshold, 'warn') },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Customers" subtitle="Account health across the customer base" />
      <ModuleNav items={CUSTOMER_MODULES} />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}

      {!d && q.isLoading && <KpiSkeleton count={5} />}
      {d && (
        <KpiGrid
          columns={5}
          items={[
            { label: 'Customers', value: fmtNumber(d.total), icon: <Building2 className="h-4 w-4" />, hint: `${fmtNumber(d.inactive)} inactive`, onClick: () => navigate(accounts({ isActive: 'all' })) },
            { label: 'Active', value: fmtNumber(d.active), tone: 'good', icon: <BadgeCheck className="h-4 w-4" />, hint: 'receiving services', onClick: () => navigate(accounts()) },
            { label: 'New · 90d', value: fmtNumber(d.newLast90d), icon: <UserPlus className="h-4 w-4" />, hint: 'onboarded this quarter', onClick: () => navigate(accounts({ sort: 'createdAt', order: 'desc', isActive: 'all' })) },
            { label: 'Contracts expiring · 60d', value: fmtNumber(d.contractsExpiring60d), tone: d.contractsExpiring60d ? 'warn' : 'good', icon: <FileSignature className="h-4 w-4" />, hint: 'renewals to start now', onClick: () => navigate('/contracts/list?expiringWithinDays=60') },
            { label: 'Entitlements over limit', value: fmtNumber(d.entitlementsOverThreshold), tone: d.entitlementsOverThreshold ? 'warn' : 'good', icon: <Gauge className="h-4 w-4" />, hint: 'usage past the warning threshold', onClick: () => navigate('/contracts/entitlements?status=over_threshold') },
          ]}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="Needs attention" subtitle="Most open P1 and breached work first" className="lg:col-span-2" padded={false} to={accounts({ sort: 'openTickets', order: 'desc' })} toLabel="All accounts">
          {d ? <DataTable dense columns={columns} rows={d.attention.slice(0, 8)} onRowClick={(r) => navigate(`/customers/${r.id}`)} rowClassName={(r) => (r.openP1 > 0 || r.breached > 0 ? 'row-rail-bad' : r.contractsExpiring60d > 0 || r.entitlementsOverThreshold > 0 ? 'row-rail-warn' : undefined)} empty={<div className="text-[13px] text-subtle py-8 text-center">No customer needs attention right now</div>} /> : <div className="px-5 pb-5"><Skeleton rows={6} /></div>}
        </Panel>
        <Panel title="SLA compliance" subtitle={`% of targets met in 30 days · lowest first · target ${SLA_TARGET}%`} to="/tickets?slaState=breached" toLabel="Breached tickets">
          {d ? (
            <BreakdownBar
              dense
              max={100}
              emptyText="Nothing measured in the last 30 days"
              items={d.slaByCustomer.filter((c) => c.compliancePct !== null).slice(0, 8).map((c) => ({ label: c.name, value: c.met + c.breached > 0 ? Math.round(c.compliancePct ?? 0) : 0, secondary: c.breached, secondaryLabel: 'breached', color: slaTone(c.compliancePct), href: `/customers/${c.id}?tab=tickets` }))}
            />
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
        <Panel title="By status" subtitle="Account status" to={accounts({ isActive: 'all' })} toLabel="Accounts">
          {d ? <BreakdownBar dense items={d.byStatus.map((b) => ({ label: b.label, value: b.count, color: b.color ?? byKey('customer_status', b.key)?.color ?? null, href: optionLink('customer_status', 'statusId', b.key) }))} emptyText="No customers yet" /> : <Skeleton rows={4} />}
        </Panel>
        <Panel title="By type" subtitle="How the base is made up" to={accounts({ isActive: 'all' })} toLabel="Accounts">
          {d ? <BreakdownBar dense items={d.byType.map((b) => ({ label: b.label, value: b.count, color: b.color ?? null, href: optionLink('customer_type', 'typeId', b.key) }))} emptyText="No customers yet" /> : <Skeleton rows={4} />}
        </Panel>
        <Panel title="By industry" subtitle="Sectors served" to={accounts({ isActive: 'all' })} toLabel="Accounts">
          {d ? <BreakdownBar dense items={d.byIndustry.slice(0, 8).map((b) => ({ label: b.label, value: b.count, color: b.color ?? null, href: optionLink('customer_industry', 'industryId', b.key) }))} emptyText="No customers yet" /> : <Skeleton rows={4} />}
        </Panel>
      </div>
    </div>
  );
}
