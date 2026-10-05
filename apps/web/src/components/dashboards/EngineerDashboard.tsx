import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ErrorBlock, Badge, Select } from '@/components/ui';
import { get } from '@/api/client';
import { fmtDuration, fmtNumber, fmtDateTime, relativeTime, fmtDate } from '@/lib/format';
import { PRIORITY_LEVEL_COLORS } from '@/lib/statusColors';
import { KpiGrid } from './KpiGrid';
import { TrendChart } from './TrendChart';
import { BreakdownBar } from './BreakdownBar';
import { TicketMiniTable } from './TicketMiniTable';
import { Panel, KpiSkeleton, Skeleton, RowList, Segmented, Stat, type RowItem } from './Panel';
import type { TicketRow } from './types';
import { truncate } from '@/lib/utils';
import { fmtPct } from '@/lib/format';
import { fmtRating, ratingTone } from '@/components/surveys/api';
import { RatingBadge } from '@/components/surveys/RatingBadge';

interface Engineer {
  generatedAt: string;
  period: { days: number; from: string; to: string };
  /** Tickets assigned to me resolved per day, last 14 days. */
  series: { day: string; resolved: number }[];
  assigned: { total: number; byPriority: { id: string | null; label: string; color: string | null; level: number; count: number }[]; breached: number; items: TicketRow[]; dueSoon: TicketRow[] };
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
  /** Ratings customers gave on tickets this engineer resolved in the period, with the latest comments. */
  csat?: { avg: number | null; responses: number; satisfiedPct: number | null; recent: { ticketId: string; number: string; title: string; rating: number; comment: string | null; answeredAt: string | null; customerName: string | null }[] };
}

export function EngineerDashboard({ days = 30, customerId = '' }: { days?: number; customerId?: string }) {
  const [resolvedView, setResolvedView] = useState<'daily' | 'weekly'>('daily');
  const [teamFilter, setTeamFilter] = useState('');
  const q = useQuery({ queryKey: ['dashboards', 'engineer', days, customerId], queryFn: () => get<Engineer>('/dashboards/engineer', { days, customerId: customerId || undefined }), refetchInterval: 120_000, placeholderData: (p) => p });
  const d = q.data;
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d)
    return (
      <div className="flex flex-col gap-6">
        <KpiSkeleton />
        <div className="card p-5">
          <Skeleton rows={6} />
        </div>
      </div>
    );
  const dueIn4h = d.assigned.dueSoon.filter((t) => t.sla && !t.sla.breached && t.sla.remainingMinutes <= 240).length;
  const todayItems: RowItem[] = [
    ...d.today.visits.map((v) => ({ key: `v-${v.id}`, href: `/field/${v.id}`, primary: v.title, secondary: `Site visit · ${v.customer_name ?? ''}${v.site_name ? ` · ${v.site_name}` : ''}`, right: v.scheduled_start ? fmtDateTime(v.scheduled_start).split(',').pop()?.trim() : 'unscheduled' })),
    ...d.today.pmOccurrences.map((o) => ({ key: `pm-${o.id}`, href: '/maintenance', primary: o.program, secondary: `Preventive maintenance · ${o.customer_name ?? ''}`, right: fmtDate(o.scheduled_date ?? o.planned_date) })),
    ...d.today.dueTickets.map((t) => ({ key: `t-${t.id}`, href: `/tickets/${t.id}`, primary: `${t.number} · ${t.title}`, secondary: `Due today · ${t.customer_name ?? ''}`, right: t.due_at ? relativeTime(t.due_at) : '' })),
    ...d.today.tasks.map((k) => ({ key: `k-${k.id}`, href: `/tickets/${k.ticket_id}`, primary: k.title, secondary: `Task on ${k.ticket_number}`, right: k.due_at ? relativeTime(k.due_at) : '' })),
  ];
  const queueTotal = d.teamQueues.reduce((s, t) => s + t.unassigned, 0);
  const resolvedDaily = d.series.some((s) => s.resolved) ? d.series : [];
  // Weekly rollup: ISO-week buckets labelled by their Monday, so a 90-day period reads as 13 bars instead of 90.
  const resolvedFlow = resolvedView === 'weekly' ? Object.values(resolvedDaily.reduce<Record<string, { day: string; resolved: number }>>((acc, s) => { const dt = new Date(`${s.day}T00:00:00`); const monday = new Date(dt); monday.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); const key = monday.toISOString().slice(0, 10); acc[key] = acc[key] ?? { day: key, resolved: 0 }; acc[key].resolved += s.resolved; return acc; }, {})) : resolvedDaily;
  const teamRows = teamFilter ? d.teamQueues.filter((t) => t.id === teamFilter) : d.teamQueues;
  // Priority colours follow the level (P1 red → P5 slate); the API orders the queue P1 first.
  const queueByPriority = d.assigned.byPriority.map((p) => ({ label: p.label, value: p.count, color: PRIORITY_LEVEL_COLORS[p.level] ?? p.color, href: p.id ? `/tickets?mine=true&open=true&priorityId=${p.id}` : '/tickets?mine=true&open=true' }));
  return (
    <div className="flex flex-col gap-6">
      <KpiGrid
        items={[
          { label: 'Assigned to me', value: fmtNumber(d.assigned.total), tone: d.assigned.breached > 0 ? 'bad' : 'default', hint: d.assigned.breached > 0 ? `${fmtNumber(d.assigned.breached)} SLA breached` : 'all within SLA', to: '/tickets?mine=true&open=true' },
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
        <Panel title="Resolved by me" subtitle={`Tickets you resolved per ${resolvedView === 'weekly' ? 'week' : 'day'}, last ${days} days`} className="xl:col-span-2" to="/tickets?mine=true&statusCategory=resolved" toLabel="Resolved tickets" action={<Segmented size="sm" options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]} value={resolvedView} onChange={setResolvedView} />}>
          <TrendChart data={resolvedFlow} x="day" kind="bar" series={[{ key: 'resolved', label: 'Resolved', color: '#0f9d6f' }]} height={160} />
        </Panel>
        <Panel title="My queue by priority" subtitle="Open tickets assigned to you" to="/tickets?mine=true&open=true">
          <BreakdownBar items={queueByPriority} emptyText="Nothing assigned to you" />
        </Panel>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Team queues" subtitle="Unassigned tickets in teams you belong to" action={d.teamQueues.length > 1 ? <Select className="h-7 py-0 text-[12px] w-40" value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} placeholder="All my teams" options={d.teamQueues.map((t) => ({ value: t.id, label: t.name }))} aria-label="Team" /> : undefined}>
          <RowList
            dense
            empty="You are not a member of any team"
            items={teamRows.map((t) => ({ key: t.id, href: `/tickets?teamId=${t.id}&unassigned=true&open=true`, primary: t.name, secondary: `${fmtNumber(t.open)} open${t.breached ? ` · ${t.breached} breached` : ''}`, right: <span className={t.unassigned > 0 ? 'text-amber-600 font-medium' : ''}>{fmtNumber(t.unassigned)} unassigned</span> }))}
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
      {d.csat && (
        <Panel title="Customer feedback for you" subtitle={`Ratings on tickets you resolved, last ${days} days`} to="/tickets?mine=true&csat=rated" toLabel="Rated tickets">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="grid grid-cols-3 lg:grid-cols-1 gap-4 content-start">
              <Stat label="Average rating" value={fmtRating(d.csat.avg)} tone={ratingTone(d.csat.avg)} />
              <Stat label="Responses" value={fmtNumber(d.csat.responses)} />
              <Stat label="Satisfied" value={fmtPct(d.csat.satisfiedPct)} />
            </div>
            <div className="lg:col-span-2">
              <RowList dense empty="No ratings yet" items={d.csat.recent.map((r) => ({ key: r.ticketId, href: `/tickets/${r.ticketId}`, primary: `${r.number} · ${r.title}`, secondary: r.comment ? `${r.customerName ? `${r.customerName} · ` : ''}“${truncate(r.comment, 110)}”` : (r.customerName ?? 'No comment left'), right: <RatingBadge rating={r.rating} /> }))} />
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}
