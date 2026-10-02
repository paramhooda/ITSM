import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ErrorBlock, Badge } from '@/components/ui';
import { Wrench, UserX, Timer, CalendarCheck } from 'lucide-react';
import { get } from '@/api/client';
import { fmtDate, fmtDateTime, fmtNumber } from '@/lib/format';
import { KpiGrid } from './KpiGrid';
import { TicketMiniTable } from './TicketMiniTable';
import { EntitlementAlerts, type EntitlementAlert } from './EntitlementAlerts';
import { Panel, KpiSkeleton, Segmented, Updated, RowList } from './Panel';
import type { TicketRow } from './types';

interface Amc {
  generatedAt: string;
  kpis: { open: number; unassigned: number; breached: number; atRisk: number; dueToday: number; awaitingCustomer: number; openedToday: number; resolvedThisWeek: number; resolvedToday: number; visitsThisWeek: number };
  queue: { items: TicketRow[]; counts: { all: number; unassigned: number; dueToday: number; breached: number; awaitingCustomer: number } };
  visits: { id: string; number: string; title: string; status: string; scheduled_start: string | null; customer_name: string | null; site_name: string | null; engineer: string | null; ticket_number: string | null; ticket_id: string | null }[];
  maintenance: { id: string; program: string; customer_name: string | null; site: string | null; due_date: string; status: string; overdue: boolean; engineer: string | null }[];
  entitlements: EntitlementAlert[];
}

type Filter = 'all' | 'unassigned' | 'dueToday' | 'breached' | 'awaitingCustomer';
const VISIT_COLOR: Record<string, string> = { requested: 'slate', scheduled: 'blue', in_progress: 'indigo', completed: 'green', cancelled: 'gray' };

/** AMC / field service view: an AMC ticket work queue first, visits and maintenance beside it. */
export function AmcDashboard() {
  const q = useQuery({ queryKey: ['dashboards', 'amc'], queryFn: () => get<Amc>('/dashboards/amc'), refetchInterval: 120_000, placeholderData: (p) => p });
  const [filter, setFilter] = useState<Filter>('all');
  const d = q.data;
  const rows = useMemo(() => {
    const items = d?.queue.items ?? [];
    switch (filter) {
      case 'unassigned':
        return items.filter((t) => !t.assignee_id);
      case 'dueToday':
        return items.filter((t) => t.due_today);
      case 'breached':
        return items.filter((t) => t.sla?.breached);
      case 'awaitingCustomer':
        return items.filter((t) => t.status_key === 'pending_customer');
      default:
        return items;
    }
  }, [d, filter]);
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d) return <KpiSkeleton />;
  const k = d.kpis;
  const c = d.queue.counts;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between -mt-2">
        <span className="text-[12.5px] text-muted">Refreshes every two minutes</span>
        <Updated at={d.generatedAt} fetching={q.isFetching} />
      </div>
      <KpiGrid
        items={[
          { label: 'Open AMC tickets', icon: <Wrench className="h-4 w-4" />, value: fmtNumber(k.open), hint: `${fmtNumber(k.openedToday)} opened today · ${fmtNumber(k.resolvedThisWeek)} resolved this week`, onClick: () => (window.location.href = '/tickets?domain=amc&open=true') },
          { label: 'Unassigned', icon: <UserX className="h-4 w-4" />, value: fmtNumber(k.unassigned), tone: k.unassigned > 0 ? 'warn' : 'default', hint: 'waiting for an engineer', onClick: () => setFilter('unassigned') },
          { label: 'SLA at risk', icon: <Timer className="h-4 w-4" />, value: fmtNumber(k.atRisk + k.breached), tone: k.breached > 0 ? 'bad' : k.atRisk > 0 ? 'warn' : 'good', hint: `${fmtNumber(k.breached)} breached · ${fmtNumber(k.dueToday)} due today`, onClick: () => setFilter('breached') },
          { label: 'Site visits this week', icon: <CalendarCheck className="h-4 w-4" />, value: fmtNumber(k.visitsThisWeek), hint: 'scheduled or in progress', onClick: () => (window.location.href = '/field') },
        ]}
      />
      <Panel
        title="AMC work queue"
        subtitle="Open tickets in the AMC domain, highest priority first"
        to="/tickets?domain=amc&open=true"
        padded={false}
        action={
          <Segmented
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: c.all },
              { value: 'unassigned', label: 'Unassigned', count: c.unassigned },
              { value: 'dueToday', label: 'Due today', count: c.dueToday },
              { value: 'breached', label: 'Breached', count: c.breached },
              { value: 'awaitingCustomer', label: 'Awaiting customer', count: c.awaitingCustomer },
            ]}
          />
        }
      >
        <div className="px-5">
          <TicketMiniTable rows={rows} max={25} columns={['customer', 'site', 'category', 'priority', 'status', 'sla', 'assignee', 'visit']} empty={filter === 'all' ? 'No open AMC tickets' : 'Nothing matches this filter'} />
        </div>
      </Panel>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Visits this week" subtitle="Scheduled and in-progress site visits" to="/field" toLabel="Field service">
          <RowList
            empty="No visits scheduled this week"
            dense
            items={d.visits.map((v) => ({
              key: v.id,
              href: `/field/${v.id}`,
              primary: (
                <span className="inline-flex items-center gap-2">
                  <span>{v.title}</span>
                  <Badge color={VISIT_COLOR[v.status] ?? 'slate'}>{v.status.replace('_', ' ')}</Badge>
                </span>
              ),
              secondary: `${v.customer_name ?? ''}${v.site_name ? ` · ${v.site_name}` : ''}${v.engineer ? ` · ${v.engineer}` : ' · unassigned'}`,
              right: v.scheduled_start ? fmtDateTime(v.scheduled_start) : 'to schedule',
            }))}
          />
        </Panel>
        <Panel title="Maintenance due" subtitle="Preventive maintenance due within 14 days" to="/maintenance" toLabel="Maintenance">
          <RowList
            empty="No maintenance due"
            dense
            items={d.maintenance.map((m) => ({
              key: m.id,
              href: `/maintenance?occurrence=${m.id}`,
              primary: (
                <span className="inline-flex items-center gap-2">
                  <span>{m.program}</span>
                  {m.overdue ? <Badge color="red">overdue</Badge> : <Badge color={m.status === 'scheduled' ? 'blue' : 'slate'}>{m.status}</Badge>}
                </span>
              ),
              secondary: `${m.customer_name ?? ''}${m.site ? ` · ${m.site}` : ''}${m.engineer ? ` · ${m.engineer}` : ''}`,
              right: fmtDate(m.due_date),
            }))}
          />
        </Panel>
        <Panel title="Entitlements near limit" subtitle="Visits and hours at 80% or more" to="/reports?tab=run&report=amc_utilization" toLabel="Utilization report">
          <EntitlementAlerts items={d.entitlements} emptyText="All AMC entitlements have headroom" />
        </Panel>
      </div>
    </div>
  );
}
