import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ErrorBlock } from '@/components/ui';
import { Activity, Flame, Timer, UserX, PhoneCall, AlertTriangle } from 'lucide-react';
import { get } from '@/api/client';
import { fmtNumber, relativeTime, fmtDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { KpiGrid } from './KpiGrid';
import { TrendChart } from './TrendChart';
import { BreakdownBar } from './BreakdownBar';
import { TicketMiniTable } from './TicketMiniTable';
import { WorkloadList, type WorkloadItem } from './WorkloadList';
import { Panel, KpiSkeleton, Stat, Updated } from './Panel';
import type { TicketRow, Breakdown } from './types';

interface Noc {
  generatedAt: string;
  totals: { open: number; openIncidents: number; breached: number; atRisk: number; unassigned: number; major: number; escalated: number; openedToday: number; resolvedToday: number; mttrTodayMinutes: number | null };
  openIncidents: Breakdown[];
  criticalOpen: TicketRow[];
  slaAtRisk: { atRisk: number; breached: number; items: TicketRow[] };
  unassigned: { count: number; items: TicketRow[] };
  byCategory: Breakdown[];
  monitoringEvents24h: { total: number; ticketsCreated: number; bySeverity: { severity: string; count: number; ticketed: number }[] };
  engineerWorkload: WorkloadItem[];
  recentlyResolved: TicketRow[];
  aging: { bucket: string; count: number }[];
  series: { day: string; opened: number; incidents: number; security: number; resolved: number; breaches: number }[];
  majorIncidents: { id: string; number: string; title: string; customerName: string; declaredAt: string; lastUpdateAt: string | null; nextUpdateDueAt: string | null; bridgeUrl: string | null; commander: string | null; overdue: boolean; children: number }[];
}

/** Active major incidents: who commands them and whether the stakeholders are owed an update. */
function MajorIncidentsPanel({ items }: { items: Noc['majorIncidents'] }) {
  return (
    <Panel title="Major incidents in progress" subtitle={items.length ? 'Bridge, commander and update cadence per incident' : 'None declared'} to="/operations/major-incidents" toLabel="Incident command" padded={false} className={items.length ? 'border-red-200' : undefined}>
      {items.length === 0 ? (
        <div className="px-5 pb-4 text-[12.5px] text-muted">No major incident is open. Declare one from an incident's actions menu when an outage needs a bridge and regular stakeholder updates.</div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {items.map((m) => {
            const due = m.nextUpdateDueAt ? Math.round((new Date(m.nextUpdateDueAt).getTime() - Date.now()) / 60_000) : null;
            return (
              <li key={m.id} className="px-5 py-2.5 flex items-center gap-3 text-[13px]">
                <span className="h-6 w-6 rounded-full bg-red-100 text-red-700 flex items-center justify-center shrink-0"><Flame className="h-3.5 w-3.5" /></span>
                <Link to={`/tickets/${m.id}?tab=major`} className="font-mono text-[12.5px] text-brand-700 hover:underline whitespace-nowrap">{m.number}</Link>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium" title={m.title}>{m.title}</span>
                  <span className="block text-[11.5px] text-muted truncate">{m.customerName} · {m.commander ? `commander ${m.commander}` : 'no commander'}{m.children ? ` · ${m.children} child${m.children === 1 ? '' : 'ren'}` : ''}</span>
                </span>
                <span className={cn('text-[11.5px] whitespace-nowrap inline-flex items-center gap-1', m.overdue ? 'text-red-600 font-medium' : 'text-muted')}>
                  {m.overdue && <AlertTriangle className="h-3 w-3" />}
                  {due === null ? `declared ${relativeTime(m.declaredAt)}` : due < 0 ? `update ${fmtDuration(-due)} overdue` : `next update in ${fmtDuration(due)}`}
                </span>
                {m.bridgeUrl && (
                  <a href={m.bridgeUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 h-7 px-2 rounded-md bg-red-600 text-white text-[12px] font-medium hover:bg-red-700 whitespace-nowrap"><PhoneCall className="h-3 w-3" /> Bridge</a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function NocDashboard({ days = 30 }: { days?: number }) {
  const q = useQuery({ queryKey: ['dashboards', 'noc', days], queryFn: () => get<Noc>('/dashboards/noc', { days }), refetchInterval: 60_000, placeholderData: (p) => p });
  const d = q.data;
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d) return <KpiSkeleton />;
  const t = d.totals;
  const p1p2 = d.openIncidents.filter((p) => (p.level ?? 99) <= 2).reduce((s, p) => s + p.count, 0);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between -mt-2">
        <span className="text-[12.5px] text-muted">Live view of infrastructure incidents · refreshes every minute</span>
        <Updated at={d.generatedAt} fetching={q.isFetching} />
      </div>
      <KpiGrid
        items={[
          { label: 'Open incidents', value: fmtNumber(t.openIncidents), icon: <Activity className="h-4 w-4" />, hint: `${fmtNumber(t.openedToday)} opened · ${fmtNumber(t.resolvedToday)} resolved today`, spark: d.series.map((s) => s.incidents), sparkLabel: `Incidents opened per day, last ${days} days`, onClick: () => (window.location.href = '/tickets?type=incident&open=true') },
          { label: 'P1 / P2 open', value: fmtNumber(p1p2), icon: <Flame className="h-4 w-4" />, tone: p1p2 > 0 ? 'bad' : 'good', hint: `${fmtNumber(t.major)} major · ${fmtNumber(t.escalated)} escalated` },
          { label: 'SLA at risk', value: fmtNumber(t.atRisk), icon: <Timer className="h-4 w-4" />, tone: t.atRisk > 0 ? 'warn' : 'good', hint: `${fmtNumber(t.breached)} already breached`, spark: d.series.map((s) => s.breaches), sparkLabel: `SLA breaches per day, last ${days} days`, onClick: () => (window.location.href = '/tickets?open=true&slaState=breached') },
          { label: 'Unassigned', value: fmtNumber(t.unassigned), icon: <UserX className="h-4 w-4" />, tone: t.unassigned > 0 ? 'warn' : 'default', hint: 'waiting for an owner', onClick: () => (window.location.href = '/tickets?open=true&unassigned=true') },
        ]}
      />
      {(d.majorIncidents?.length ?? 0) > 0 && <MajorIncidentsPanel items={d.majorIncidents} />}
      <Panel title="Critical and major incidents" subtitle="P1, P2 and major tickets ordered by priority" to="/tickets?open=true&priorityId=&type=incident" toLabel="All incidents" padded={false}>
        <div className="px-5">
          <TicketMiniTable rows={d.criticalOpen} max={8} columns={['customer', 'priority', 'ci', 'status', 'sla', 'assignee']} empty="No P1/P2 or major incidents open" />
        </div>
      </Panel>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Ticket aging" subtitle="How long open tickets have been waiting" className="xl:col-span-1">
          <TrendChart data={d.aging} x="bucket" kind="bar" series={[{ key: 'count', label: 'Open tickets' }]} height={170} xFormatter={(v) => v} />
          <div className="mt-4 pt-4 border-t border-default grid grid-cols-3 gap-3">
            <Stat label="PRTG events · 24h" value={fmtNumber(d.monitoringEvents24h.total)} />
            <Stat label="Tickets from monitoring" value={fmtNumber(d.monitoringEvents24h.ticketsCreated)} />
            <Stat label="Ticket rate" value={d.monitoringEvents24h.total ? `${Math.round((d.monitoringEvents24h.ticketsCreated / d.monitoringEvents24h.total) * 100)}%` : '—'} />
          </div>
        </Panel>
        <Panel title="At risk or breached" subtitle="Soonest SLA deadline first" to="/tickets?open=true&slaState=breached" toLabel="All breached" padded={false}>
          <div className="px-5">
            <TicketMiniTable rows={d.slaAtRisk.items} max={6} columns={['customer', 'priority', 'sla']} empty="Every open ticket is within SLA" />
          </div>
        </Panel>
        <Panel title="Engineer load" subtitle="Open tickets per engineer in NOC, infrastructure and network teams">
          <WorkloadList items={d.engineerWorkload.slice(0, 8)} />
        </Panel>
      </div>
      <Panel title="Open by category" subtitle="NOC categories, breaches in red" to="/tickets?open=true" toLabel="All open">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
          <BreakdownBar items={d.byCategory.slice(0, 5).map((c) => ({ label: c.label, value: c.count, secondary: c.breached, href: c.id ? `/tickets?open=true&categoryId=${c.id}` : undefined }))} emptyText="No open NOC tickets" />
          <BreakdownBar items={d.byCategory.slice(5, 10).map((c) => ({ label: c.label, value: c.count, secondary: c.breached, href: c.id ? `/tickets?open=true&categoryId=${c.id}` : undefined }))} emptyText="" max={Math.max(1, ...d.byCategory.map((c) => c.count))} />
        </div>
      </Panel>
    </div>
  );
}
