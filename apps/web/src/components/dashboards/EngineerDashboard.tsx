import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ErrorBlock, Badge } from '@/components/ui';
import { get } from '@/api/client';
import { fmtDuration, fmtNumber, fmtDateTime, relativeTime, fmtDate } from '@/lib/format';
import { KpiGrid } from './KpiGrid';
import { TicketMiniTable } from './TicketMiniTable';
import { Panel, KpiSkeleton, RowList, type RowItem } from './Panel';
import type { TicketRow } from './types';

interface Engineer {
  generatedAt: string;
  assigned: { total: number; byPriority: { label: string; color: string | null; level: number; count: number }[]; breached: number; items: TicketRow[]; dueSoon: TicketRow[] };
  teamQueues: { id: string; name: string; unassigned: number; open: number; breached: number }[];
  today: {
    dueTickets: TicketRow[];
    visits: { id: string; number: string; title: string; status: string; scheduled_start: string | null; customer_name: string | null; site_name: string | null }[];
    pmOccurrences: { id: string; program: string; customer_name: string | null; status: string; planned_date: string; scheduled_date: string | null }[];
    tasks: { id: string; title: string; status: string; due_at: string | null; ticket_id: string; ticket_number: string; ticket_title: string }[];
  };
  approvalsPending: number;
  activity: { comments: number; minutes: number; resolved: number; breachedAssigned: number };
  knowledge: { id: string; number: string; title: string; article_type: string; published_at: string | null; service_name: string | null }[];
  watched: TicketRow[];
}

export function EngineerDashboard() {
  const q = useQuery({ queryKey: ['dashboards', 'engineer'], queryFn: () => get<Engineer>('/dashboards/engineer'), refetchInterval: 120_000, placeholderData: (p) => p });
  const d = q.data;
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d) return <KpiSkeleton />;
  const dueIn4h = d.assigned.dueSoon.filter((t) => t.sla && !t.sla.breached && t.sla.remainingMinutes <= 240).length;
  const todayItems: RowItem[] = [
    ...d.today.visits.map((v) => ({ key: `v-${v.id}`, href: `/field/${v.id}`, primary: v.title, secondary: `Site visit · ${v.customer_name ?? ''}${v.site_name ? ` · ${v.site_name}` : ''}`, right: v.scheduled_start ? fmtDateTime(v.scheduled_start).split(',').pop()?.trim() : 'unscheduled' })),
    ...d.today.pmOccurrences.map((o) => ({ key: `pm-${o.id}`, href: '/maintenance', primary: o.program, secondary: `Preventive maintenance · ${o.customer_name ?? ''}`, right: fmtDate(o.scheduled_date ?? o.planned_date) })),
    ...d.today.dueTickets.map((t) => ({ key: `t-${t.id}`, href: `/tickets/${t.id}`, primary: `${t.number} · ${t.title}`, secondary: `Due today · ${t.customer_name ?? ''}`, right: t.due_at ? relativeTime(t.due_at) : '' })),
    ...d.today.tasks.map((k) => ({ key: `k-${k.id}`, href: `/tickets/${k.ticket_id}`, primary: k.title, secondary: `Task on ${k.ticket_number}`, right: k.due_at ? relativeTime(k.due_at) : '' })),
  ];
  const queueTotal = d.teamQueues.reduce((s, t) => s + t.unassigned, 0);
  return (
    <div className="flex flex-col gap-6">
      <KpiGrid
        items={[
          { label: 'Assigned to me', value: fmtNumber(d.assigned.total), tone: d.assigned.breached > 0 ? 'bad' : 'default', hint: d.assigned.breached > 0 ? `${fmtNumber(d.assigned.breached)} SLA breached` : 'all within SLA', onClick: () => (window.location.href = '/tickets?mine=true&open=true') },
          { label: 'Due within 4 hours', value: fmtNumber(dueIn4h), tone: dueIn4h > 0 ? 'warn' : 'good', hint: 'by SLA remaining' },
          { label: 'Approvals waiting', value: fmtNumber(d.approvalsPending), tone: d.approvalsPending > 0 ? 'warn' : 'default', hint: 'requests and changes for you to decide' },
          { label: 'Today', value: fmtNumber(todayItems.length), hint: `${d.today.visits.length} visits · ${d.today.pmOccurrences.length} maintenance · ${d.today.dueTickets.length} due` },
        ]}
      />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="My queue" subtitle="Soonest SLA deadline first" to="/tickets?mine=true&open=true" className="xl:col-span-2" padded={false}>
          <div className="px-5">
            <TicketMiniTable rows={d.assigned.dueSoon.length ? d.assigned.dueSoon : d.assigned.items} max={10} columns={['customer', 'priority', 'status', 'sla']} empty="Nothing assigned to you. Pick up unassigned work from your team queues." />
          </div>
          {queueTotal > 0 && (
            <div className="px-5 py-3 border-t border-default text-[12.5px] text-muted">
              {fmtNumber(queueTotal)} unassigned in your teams · <Link to="/tickets?unassigned=true&open=true" className="text-brand-700 hover:underline">Take the next one</Link>
            </div>
          )}
        </Panel>
        <Panel title="Today" subtitle="Visits, maintenance and deadlines">
          <RowList items={todayItems.slice(0, 8)} empty="Nothing scheduled for today" dense />
        </Panel>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Team queues" subtitle="Unassigned tickets in teams you belong to">
          <RowList
            dense
            empty="You are not a member of any team"
            items={d.teamQueues.map((t) => ({ key: t.id, href: `/tickets?teamId=${t.id}&unassigned=true&open=true`, primary: t.name, secondary: `${fmtNumber(t.open)} open${t.breached ? ` · ${t.breached} breached` : ''}`, right: <span className={t.unassigned > 0 ? 'text-amber-600 font-medium' : ''}>{fmtNumber(t.unassigned)} unassigned</span> }))}
          />
        </Panel>
        <Panel title="Watched tickets" subtitle="Updates in the last 24 hours" padded={false}>
          <div className="px-5">
            <TicketMiniTable rows={d.watched} max={6} columns={['status', 'activity']} empty="No updates on tickets you watch" />
          </div>
        </Panel>
        {d.knowledge.length > 0 ? (
          <Panel title="Knowledge for your work" subtitle="Recently published for services on your tickets" to="/knowledge" toLabel="Knowledge base">
            <RowList dense items={d.knowledge.map((a) => ({ key: a.id, href: `/knowledge/${a.id}`, primary: a.title, secondary: `${a.number} · ${a.article_type}${a.service_name ? ` · ${a.service_name}` : ''}` }))} />
          </Panel>
        ) : (
          <Panel title="Your activity today" subtitle="Updates, time and resolutions">
            <RowList dense items={[{ key: 'c', primary: 'Updates posted', right: fmtNumber(d.activity.comments) }, { key: 't', primary: 'Time logged', right: fmtDuration(d.activity.minutes) }, { key: 'r', primary: 'Resolved', right: <Badge color="green">{fmtNumber(d.activity.resolved)}</Badge> }]} />
          </Panel>
        )}
      </div>
    </div>
  );
}
