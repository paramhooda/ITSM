import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Inbox, AlertTriangle, UserX, CheckCircle2, ShieldCheck, Pin, Wrench, CalendarCheck, Users, GitPullRequestArrow } from 'lucide-react';
import { Badge } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber, fmtPct, fmtDateTime, relativeTime } from '@/lib/format';
import { cn, truncate } from '@/lib/utils';
import { ANNOUNCEMENT_TYPE_COLORS } from '@/lib/statusColors';
import { ticketListPath, type TicketListLink } from '@itsm/shared';
import { KpiGrid, type KpiItem } from './KpiGrid';
import { Panel, RowList } from './Panel';
import { DonutChart } from './DonutChart';
import type { Overview, OverviewMe, OverviewAnnouncement, UpcomingItem, UpcomingKind } from './overviewApi';

/** "Good morning, Rajesh": the hero title of the Overview and My work. */
export function greeting(name: string) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name.split(' ')[0]}`;
}

const time = (d: string) => new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** The shift running now in one of the person's teams, or the next one, in words; null without a rota. */
export function shiftLine(shift: OverviewMe['shift']): string | null {
  if (!shift) return null;
  if (shift.current) return `${shift.current.name} shift · ${shift.teamName} · until ${time(shift.current.endsAt)}`;
  if (shift.next) return `Next shift: ${shift.next.name} · ${shift.teamName} · ${fmtDateTime(shift.next.startsAt)}`;
  return null;
}

const TYPE_PLURAL: Record<string, string> = { incident: 'Incidents', request: 'Requests', problem: 'Problems', change: 'Changes' };

function StatLink({ label, value, hint, tone = 'default', to }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'good' | 'warn' | 'bad'; to?: string }) {
  const cls = { default: 'text-default', good: 'text-emerald-600', warn: 'text-amber-600', bad: 'text-red-600' }[tone];
  const body = (
    <>
      <div className="text-[12px] text-muted truncate">{label}</div>
      <div className={cn('text-[22px] font-semibold tnum tracking-[-0.02em] mt-0.5 leading-tight', cls)}>{value}</div>
      {hint && <div className="text-[11.5px] text-subtle truncate mt-0.5">{hint}</div>}
    </>
  );
  return to ? <Link to={to} className="block min-w-0 rounded-lg px-3 py-2 -mx-1 hover:bg-surface-2 transition-colors">{body}</Link> : <div className="min-w-0 px-3 py-2 -mx-1">{body}</div>;
}

/** "My day": the person's own numbers, each a door into their list, and their open queue by type. A door opens only where the person may enter (the ticket list needs tickets:read, the approvals inbox an approval right); otherwise the number is a figure. */
export function MyDayStrip({ me, customerId, today, className }: { me: OverviewMe; customerId: string; today: string; className?: string }) {
  const can = useAuthStore((s) => s.can);
  const mine: TicketListLink = { customerId: customerId || null, assignee: 'me', status: 'open' };
  const door = (link: TicketListLink) => (can('tickets:read') ? ticketListPath(link) : undefined);
  const approvals = can('requests:approve', 'changes:approve') ? '/tickets/approvals' : undefined;
  return (
    <Panel title="My day" subtitle="Your queue right now; each number opens your list" to={door(mine)} toLabel="My tickets" className={className}>
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-x-4 gap-y-3">
        <div className="lg:col-span-3 grid grid-cols-2 sm:grid-cols-3 gap-x-2 gap-y-1">
          <StatLink label="Assigned to me" value={fmtNumber(me.assigned)} to={door(mine)} hint={me.dueToday > 0 ? `${fmtNumber(me.dueToday)} due today` : 'nothing due today'} />
          <StatLink label="Breached" value={fmtNumber(me.breached)} tone={me.breached > 0 ? 'bad' : 'good'} to={door({ ...mine, sla: 'breached' })} hint="SLA clock already missed" />
          <StatLink label="At risk" value={fmtNumber(me.atRisk)} tone={me.atRisk > 0 ? 'warn' : 'good'} to={door({ ...mine, sla: 'at_risk' })} hint="clock running, warned" />
          <StatLink label="Resolved today" value={fmtNumber(me.resolvedToday)} to={door({ customerId: customerId || null, assignee: 'me', status: 'any', resolvedFrom: today })} />
          <StatLink label="Approvals waiting" value={fmtNumber(me.approvals)} tone={me.approvals > 0 ? 'warn' : 'default'} to={approvals} hint="for you or your teams to decide" />
          <StatLink label="Due today" value={fmtNumber(me.dueToday)} tone={me.dueToday > 0 ? 'warn' : 'default'} hint="on your open tickets" />
        </div>
        <div className="lg:col-span-2 lg:border-l lg:border-default lg:pl-4">
          <div className="text-[12px] text-muted mb-2">My queue by type</div>
          <DonutChart size={100} centerLabel="open" emptyText="Nothing assigned to you" slices={me.byType.map((t) => ({ key: t.type, label: TYPE_PLURAL[t.type] ?? t.type, value: t.count, href: door({ ...mine, type: t.type as TicketListLink['type'] }) }))} />
        </div>
      </div>
    </Panel>
  );
}

/** Announcements aimed at staff, pinned first; the manage link shows for those who write them. */
export function AnnouncementsPanel({ items, className }: { items: OverviewAnnouncement[]; className?: string }) {
  const can = useAuthStore((s) => s.can);
  const manage = can('announcements:manage');
  return (
    <Panel title="Announcements" subtitle="For staff, pinned first" to={manage ? '/operations/announcements' : undefined} toLabel="Manage" className={className}>
      <RowList
        dense
        empty="No announcements for staff right now"
        items={items.map((a) => ({
          key: a.id,
          href: a.sourceTicket ? `/tickets/${a.sourceTicket.id}` : manage ? '/operations/announcements' : undefined,
          leading: <Badge color={ANNOUNCEMENT_TYPE_COLORS[a.type] ?? 'slate'}>{a.type}</Badge>,
          primary: (
            <span className="inline-flex items-center gap-1.5">
              {a.pinned && <Pin className="h-3 w-3 text-subtle" aria-label="Pinned" />}
              <span>{a.title}</span>
            </span>
          ),
          secondary: `${truncate(a.body, 120)}${a.startsAt ? ` · ${relativeTime(a.startsAt)}` : ''}`,
        }))}
      />
    </Panel>
  );
}

const KIND: Record<UpcomingKind, { label: string; icon: typeof Wrench; chip: string }> = {
  visit: { label: 'Site visit', icon: Wrench, chip: 'bg-orange-50 text-orange-600' },
  maintenance: { label: 'Maintenance', icon: CalendarCheck, chip: 'bg-amber-50 text-amber-600' },
  cab: { label: 'CAB meeting', icon: Users, chip: 'bg-violet-50 text-violet-600' },
  change: { label: 'Change window', icon: GitPullRequestArrow, chip: 'bg-purple-50 text-purple-600' },
};

/** Visits, maintenance, CAB meetings and change windows today and tomorrow, each opening its record. */
export function UpcomingPanel({ upcoming, today, className }: { upcoming: Overview['upcoming']; today: string; className?: string }) {
  const can = useAuthStore((s) => s.can);
  const c = upcoming.counts;
  const parts = [c.visits ? `${c.visits} visit${c.visits === 1 ? '' : 's'}` : null, c.maintenance ? `${c.maintenance} maintenance` : null, c.cab ? `${c.cab} CAB` : null, c.changes ? `${c.changes} change window${c.changes === 1 ? '' : 's'}` : null].filter(Boolean);
  const when = (i: UpcomingItem) => {
    const day = i.day === today ? 'Today' : i.day ? 'Tomorrow' : '';
    return i.startsAt ? `${day} ${time(i.startsAt)}`.trim() : day;
  };
  return (
    <Panel title="Upcoming" subtitle={parts.length ? `Today and tomorrow: ${parts.join(' · ')}` : 'Today and tomorrow: visits, maintenance, CAB meetings and change windows'} to={can('tickets:read') ? '/operations/change-calendar' : undefined} toLabel="Change calendar" className={className}>
      <RowList
        dense
        empty="Nothing scheduled for today or tomorrow"
        items={upcoming.items.map((i) => {
          const k = KIND[i.kind];
          return {
            key: `${i.kind}-${i.id}`,
            href: i.href,
            leading: <span className={cn('inline-flex h-6 w-6 items-center justify-center rounded-md', k.chip)}><k.icon className="h-3.5 w-3.5" /></span>,
            primary: i.title,
            secondary: [k.label, i.customerName, i.subtitle].filter(Boolean).join(' · '),
            right: when(i),
          };
        })}
      />
    </Panel>
  );
}

/** The five desk KPIs: every number counted live with the predicates its link carries; the sparkline is the daily series. */
export function deskKpis(d: Overview, customerId: string): KpiItem[] {
  const desk = d.desk;
  if (!desk) return [];
  const k = desk.kpis;
  const days = d.period.days;
  const scope: TicketListLink = { customerId: customerId || null };
  const open: TicketListLink = { ...scope, status: 'open' };
  const spark = desk.series.slice(Math.max(0, desk.series.length - (days <= 7 ? 7 : 14)));
  const sparkDays = spark.length;
  const compliance = k.slaCompliancePct;
  const complianceTone = compliance === null ? 'default' : compliance >= 95 ? 'good' : compliance >= 85 ? 'warn' : 'bad';
  return [
    { label: 'Open tickets', value: fmtNumber(k.open), icon: <Inbox className="h-4 w-4" />, delta: desk.deltas.open, lowerIsBetter: true, hint: `${fmtNumber(k.openedToday)} opened today · ${fmtNumber(k.major)} major`, spark: spark.map((s) => s.opened), sparkLabel: `Tickets opened per day, last ${sparkDays} days`, to: ticketListPath(open) },
    { label: 'Breached', value: fmtNumber(k.breached), icon: <AlertTriangle className="h-4 w-4" />, tone: k.breached > 0 ? 'bad' : 'good', delta: desk.deltas.breaches, lowerIsBetter: true, hint: `${fmtNumber(k.atRisk)} at risk`, spark: spark.map((s) => s.breaches), sparkLabel: `SLA breaches per day, last ${sparkDays} days`, to: ticketListPath({ ...open, sla: 'breached' }) },
    { label: 'Unassigned', value: fmtNumber(k.unassigned), icon: <UserX className="h-4 w-4" />, tone: k.unassigned > 0 ? 'warn' : 'default', hint: 'waiting for an owner', to: ticketListPath({ ...open, assignee: 'unassigned' }) },
    { label: `Resolved · ${days}d`, value: fmtNumber(k.resolvedInPeriod), icon: <CheckCircle2 className="h-4 w-4" />, delta: desk.deltas.resolvedInPeriod, hint: `${fmtNumber(k.openedInPeriod)} opened in the period`, spark: spark.map((s) => s.resolved), sparkLabel: `Tickets resolved per day, last ${sparkDays} days`, to: ticketListPath({ ...scope, status: 'any', resolvedFrom: d.period.from, resolvedTo: d.period.to }) },
    { label: `SLA compliance · ${days}d`, value: fmtPct(compliance, 1), icon: <ShieldCheck className="h-4 w-4" />, tone: complianceTone, delta: desk.deltas.slaCompliancePct, hint: `${fmtNumber(k.resolutionMet)} met · ${fmtNumber(k.resolutionBreached)} breached`, spark: spark.map((s) => s.compliancePct), sparkLabel: `Daily resolution SLA compliance, last ${sparkDays} days` },
  ];
}

export function DeskKpiRow({ overview, customerId }: { overview: Overview; customerId: string }) {
  const items = deskKpis(overview, customerId);
  if (!items.length) return null;
  return <KpiGrid items={items} columns={5} />;
}
