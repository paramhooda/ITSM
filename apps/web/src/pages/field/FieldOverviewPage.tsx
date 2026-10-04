import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CalendarRange, AlertTriangle, Clock, ClipboardCheck } from 'lucide-react';
import { PageHeader, ModuleNav, Select, ErrorBlock, Badge, Avatar } from '@/components/ui';
import { FIELD_MODULES } from '@/layouts/modules';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { Panel, RowList, Stat, KpiSkeleton, Skeleton, Segmented } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { TrendChart } from '@/components/dashboards/TrendChart';
import { useForwardListParams } from '@/hooks/useForwardListParams';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDateTime, fmtNumber, titleCase } from '@/lib/format';
import { VISIT_STATUS_COLORS, PM_STATUS_COLORS } from '@/lib/statusColors';
import { overviewApi, ovKeys, withQuery, ymd } from '@/components/overview/api';

/** Field Service home: today and this week, what is late or unowned, engineer load, maintenance due. */
export default function FieldOverviewPage() {
  const [workView, setWorkView] = useState<'both' | 'visits' | 'pm'>('both');
  const forwarding = useForwardListParams('/field/visits');
  const navigate = useNavigate();
  const customers = useCustomersLookup();
  // Local, not in the URL: a query-bearing URL on the overview is forwarded to the list.
  const [customerId, setCustomerId] = useState<string>('');
  const cid = customerId || undefined;
  const q = useQuery({ queryKey: ovKeys.field(cid), queryFn: () => overviewApi.field(cid), refetchInterval: 60_000, placeholderData: (p) => p, enabled: !forwarding });
  const d = q.data;
  if (forwarding) return null;

  const now = new Date();
  const today = ymd(now);
  const in7 = ymd(new Date(now.getTime() + 7 * 86_400_000));
  const monthStart = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const visits = (params: Record<string, string | undefined> = {}) => withQuery('/field/visits', { ...params, customerId: cid });
  const maintenance = (params: Record<string, string | undefined> = {}) => withQuery('/maintenance', { ...params, customerId: cid });
  const work = d && d.series.some((s) => Number(s.visitsCompleted) || Number(s.pmCompleted)) ? d.series : [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Field service"
        subtitle="Today, this week, engineer load and maintenance due"
        actions={<Select className="w-48 h-8 py-0 text-[13px]" value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />}
      />
      <ModuleNav items={FIELD_MODULES} />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}

      {!d && q.isLoading && <KpiSkeleton count={5} />}
      {d && (
        <KpiGrid
          columns={5}
          items={[
            { label: 'Today', value: fmtNumber(d.today.scheduled + d.today.inProgress), tone: d.today.inProgress ? 'accent' : 'default', icon: <CalendarDays className="h-4 w-4" />, hint: `${fmtNumber(d.today.inProgress)} on site · ${fmtNumber(d.today.completed)} completed`, to: visits({ status: 'scheduled,in_progress', from: today, to: today }) },
            { label: 'This week', value: fmtNumber(d.week.scheduled), icon: <CalendarRange className="h-4 w-4" />, hint: `${fmtNumber(d.week.completed)} completed · ${fmtNumber(d.week.cancelled)} cancelled`, to: withQuery('/field/calendar', { customerId: cid }) },
            { label: 'Overdue', value: fmtNumber(d.overdue), tone: d.overdue ? 'bad' : 'good', icon: <AlertTriangle className="h-4 w-4" />, hint: 'scheduled time passed, not started', to: visits({ status: 'requested,scheduled', to: today }) },
            { label: 'Awaiting acknowledgement', value: fmtNumber(d.awaitingAcknowledgement), tone: d.awaitingAcknowledgement ? 'warn' : 'good', icon: <Clock className="h-4 w-4" />, hint: 'completed, no customer sign-off', to: visits({ status: 'completed', unacknowledged: 'true' }) },
            { label: 'PM due this month', value: fmtNumber(d.pm.dueThisMonth), tone: d.pm.overdue ? 'warn' : 'default', icon: <ClipboardCheck className="h-4 w-4" />, hint: `${fmtNumber(d.pm.overdue)} overdue · ${fmtNumber(d.pm.completedThisMonth)} done`, to: maintenance({ from: monthStart, to: monthEnd }) },
          ]}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Second series uses kit slot 6 (validated pair with blue); slot 2 orange fails the 3:1 contrast check on bars. */}
        <Panel title="Completed work" subtitle={`${workView === 'visits' ? 'Site visits' : workView === 'pm' ? 'Preventive maintenance' : 'Site visits and preventive maintenance'} completed per day, last 30 days`} className="lg:col-span-2" to={visits({ status: 'completed' })} toLabel="Completed visits" action={<Segmented size="sm" options={[{ value: 'both', label: 'Both' }, { value: 'visits', label: 'Visits' }, { value: 'pm', label: 'Maintenance' }]} value={workView} onChange={setWorkView} />}>
          {d ? <TrendChart data={work} x="day" kind="bar" series={[...(workView !== 'pm' ? [{ key: 'visitsCompleted', label: 'Visits completed' }] : []), ...(workView !== 'visits' ? [{ key: 'pmCompleted', label: 'Maintenance completed', color: '#1a7f37' }] : [])]} height={220} /> : <Skeleton rows={6} />}
        </Panel>
        <Panel title="Visits by status" subtitle="Open and recent visits · click to filter" to={visits()} toLabel="Visits">
          {d ? <BreakdownBar dense items={d.byStatus.filter((b) => b.count > 0).map((b) => ({ label: b.label || titleCase(b.key), value: b.count, color: b.color ?? VISIT_STATUS_COLORS[b.key] ?? 'slate', href: visits({ status: b.key }) }))} emptyText="No visits yet" /> : <Skeleton rows={5} />}
        </Panel>
        <Panel title="Engineer load" subtitle="Visits in the next 7 days, busiest first" to={visits({ status: 'requested,scheduled,in_progress', from: today, to: in7 })} toLabel="Next 7 days">
          {d ? (
            <>
              <div className="grid grid-cols-2 gap-3 mb-3 pb-3 border-b border-default">
                <Stat label="Unassigned" value={fmtNumber(d.unassigned)} tone={d.unassigned ? 'warn' : 'good'} />
                <Stat label="Engineers booked" value={fmtNumber(d.byEngineer.filter((e) => e.scheduled + e.inProgress > 0).length)} />
              </div>
              <BreakdownBar dense items={d.byEngineer.slice(0, 8).map((e) => ({ label: e.name, value: e.scheduled + e.inProgress, href: visits({ engineerId: e.id, status: 'scheduled,in_progress', from: today, to: in7 }) }))} emptyText="Nothing booked for the next 7 days" />
            </>
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
        <Panel title="Maintenance" subtitle="Preventive maintenance this month" to={maintenance()} toLabel="Maintenance">
          {d ? (
            <>
              <div className="grid grid-cols-3 gap-3 mb-3 pb-3 border-b border-default">
                <Stat label="Due" value={fmtNumber(d.pm.dueThisMonth)} />
                <Stat label="Overdue" value={fmtNumber(d.pm.overdue)} tone={d.pm.overdue ? 'bad' : 'good'} />
                <Stat label="Completed" value={fmtNumber(d.pm.completedThisMonth)} tone="good" />
              </div>
              <BreakdownBar dense items={d.pm.byStatus.filter((b) => b.count > 0).map((b) => ({ label: b.label || titleCase(b.key), value: b.count, color: b.color ?? PM_STATUS_COLORS[b.key] ?? 'slate', href: maintenance({ status: b.key, from: monthStart, to: monthEnd }) }))} emptyText="No maintenance planned this month" />
            </>
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
        <Panel title="Up next" subtitle="Soonest scheduled visits" to={visits({ from: today })} toLabel="View all">
          {d ? (
            <RowList
              dense
              empty="Nothing scheduled"
              items={d.upcoming.slice(0, 8).map((v) => ({
                key: v.id,
                leading: <Avatar name={v.engineerName} size="xs" />,
                primary: (
                  <span className="inline-flex items-center gap-2 min-w-0">
                    <span className="truncate">{v.title}</span>
                    <Badge color={VISIT_STATUS_COLORS[v.status] ?? 'slate'}>{titleCase(v.status)}</Badge>
                  </span>
                ),
                secondary: `${v.customerName}${v.siteName ? ` · ${v.siteName}` : ''} · ${v.engineerName ?? 'unassigned'}`,
                right: fmtDateTime(v.scheduledStart),
                href: `/field/${v.id}`,
              }))}
            />
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
      </div>
    </div>
  );
}
