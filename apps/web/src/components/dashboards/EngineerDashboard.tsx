import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, LoadingBlock, ErrorBlock, Badge } from '@/components/ui';
import { get } from '@/api/client';
import { fmtDuration, fmtNumber, fmtDateTime, relativeTime, fmtDate } from '@/lib/format';
import { KpiGrid } from './KpiGrid';
import { BreakdownBar } from './BreakdownBar';
import { TicketMiniTable } from './TicketMiniTable';
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
  if (!d) return <LoadingBlock />;
  const todayCount = d.today.dueTickets.length + d.today.visits.length + d.today.pmOccurrences.length + d.today.tasks.length;
  return (
    <div className="flex flex-col gap-4">
      <KpiGrid
        items={[
          { label: 'Assigned to me', value: fmtNumber(d.assigned.total), hint: `${fmtNumber(d.assigned.breached)} SLA breached`, tone: d.assigned.breached > 0 ? 'bad' : 'default', onClick: () => (window.location.href = '/tickets?mine=true&open=true') },
          { label: "Today's workload", value: fmtNumber(todayCount), hint: `${d.today.dueTickets.length} due · ${d.today.visits.length} visits · ${d.today.pmOccurrences.length} PM · ${d.today.tasks.length} tasks` },
          { label: 'Team queues', value: fmtNumber(d.teamQueues.reduce((s, t) => s + t.unassigned, 0)), hint: 'unassigned in my teams', tone: d.teamQueues.some((t) => t.unassigned > 0) ? 'warn' : 'default' },
          { label: 'Approvals pending', value: fmtNumber(d.approvalsPending), tone: d.approvalsPending > 0 ? 'warn' : 'default' },
          { label: 'Resolved today', value: fmtNumber(d.activity.resolved), tone: d.activity.resolved > 0 ? 'good' : 'default' },
          { label: 'My activity today', value: fmtDuration(d.activity.minutes), hint: `${fmtNumber(d.activity.comments)} comments · time logged` },
        ]}
      />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card title="Due soon (by SLA remaining)" className="xl:col-span-2">
          <TicketMiniTable rows={d.assigned.dueSoon} columns={['customer', 'priority', 'status', 'sla']} empty="No SLA clocks running on your tickets" />
        </Card>
        <Card title="My open tickets by priority">
          <BreakdownBar items={d.assigned.byPriority.map((p) => ({ label: p.label, value: p.count, color: p.color }))} emptyText="Nothing assigned to you" />
          <div className="mt-4 text-[12.5px] font-medium text-muted mb-1">My team queues</div>
          <BreakdownBar dense items={d.teamQueues.map((t) => ({ label: t.name, value: t.unassigned, secondary: t.breached, href: `/tickets?teamId=${t.id}&unassigned=true&open=true` }))} emptyText="You are not a member of any team" />
        </Card>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4">
        <Card title={`Tickets due today (${d.today.dueTickets.length})`}>
          <TicketMiniTable rows={d.today.dueTickets} columns={['priority', 'due']} empty="Nothing due today" />
        </Card>
        <Card title={`Field visits today (${d.today.visits.length})`}>
          {d.today.visits.length === 0 && <div className="text-[13px] text-subtle py-4 text-center">No visits scheduled</div>}
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {d.today.visits.map((v) => (
              <li key={v.id} className="py-1.5 text-[12.5px]">
                <Link to={`/field/${v.id}`} className="hover:underline font-medium">{v.number}</Link> <Badge color="slate" className="ml-1">{v.status}</Badge>
                <div className="truncate">{v.title}</div>
                <div className="text-subtle text-[11.5px]">{v.customer_name}{v.site_name ? ` · ${v.site_name}` : ''} · {v.scheduled_start ? fmtDateTime(v.scheduled_start) : 'unscheduled'}</div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={`Preventive maintenance today (${d.today.pmOccurrences.length})`}>
          {d.today.pmOccurrences.length === 0 && <div className="text-[13px] text-subtle py-4 text-center">No PM scheduled</div>}
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {d.today.pmOccurrences.map((o) => (
              <li key={o.id} className="py-1.5 text-[12.5px]">
                <Link to="/maintenance" className="hover:underline font-medium">{o.program}</Link> <Badge color="slate" className="ml-1">{o.status}</Badge>
                <div className="text-subtle text-[11.5px]">{o.customer_name} · planned {fmtDate(o.planned_date)}</div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={`My open tasks (${d.today.tasks.length})`}>
          {d.today.tasks.length === 0 && <div className="text-[13px] text-subtle py-4 text-center">No open tasks</div>}
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {d.today.tasks.map((k) => (
              <li key={k.id} className="py-1.5 text-[12.5px]">
                <div className="truncate font-medium">{k.title}</div>
                <div className="text-subtle text-[11.5px]"><Link to={`/tickets/${k.ticket_id}`} className="font-mono hover:underline">{k.ticket_number}</Link> · {k.due_at ? `due ${relativeTime(k.due_at)}` : 'no due date'}</div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="Watched tickets with updates (24h)">
          <TicketMiniTable rows={d.watched} columns={['customer', 'status', 'assignee', 'activity']} empty="No updates on tickets you watch" />
        </Card>
        <Card title="Knowledge for your open work" actions={<Link to="/knowledge" className="text-[11.5px] text-brand-700 dark:text-brand-300 hover:underline">Knowledge base</Link>}>
          {d.knowledge.length === 0 && <div className="text-[13px] text-subtle py-4 text-center">No published articles yet</div>}
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {d.knowledge.map((a) => (
              <li key={a.id} className="py-1.5 text-[12.5px]">
                <Link to={`/knowledge/${a.id}`} className="hover:underline font-medium">{a.title}</Link>
                <div className="text-subtle text-[11.5px]"><span className="font-mono">{a.number}</span> · {a.article_type}{a.service_name ? ` · ${a.service_name}` : ''}{a.published_at ? ` · ${relativeTime(a.published_at)}` : ''}</div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
