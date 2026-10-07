import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Activity, ShieldAlert, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber, fmtPct, fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { fmtRating, ratingTone } from '@/components/surveys/api';
import { ticketListPath, type TicketListLink } from '@itsm/shared';
import { dashboardPath } from './DashboardFrame';
import { Panel, Stat } from './Panel';
import { TrendChart } from './TrendChart';
import { DeltaBadge } from './KpiGrid';
import { ExpiringContracts } from './ExpiringContracts';
import { EntitlementAlerts } from './EntitlementAlerts';
import { STATUS_COLORS } from './chartTheme';
import type { Overview, NocStrip, SocStrip, AmcStrip } from './overviewApi';

/**
 * The operations strips and the management extras of the Overview. A strip
 * shows the dedicated dashboard's own tile numbers (the API computes both from
 * one function) with an "Open dashboard" link that keeps the period and the
 * scope; the management extras appear only for people who hold
 * dashboards:management.
 */

interface StripItem {
  label: string;
  value: number;
  href?: string;
  tone?: 'default' | 'bad' | 'warn';
}

/** One strip: the dashboard's name and a hint on the left, its five tile numbers across, "Open dashboard" on the right; wraps on a phone. */
function StripCard({ title, icon, route, scope, hint, items, className }: { title: string; icon: ReactNode; route: string; scope: { days: number; customerId: string }; hint: string; items: StripItem[]; className?: string }) {
  return (
    <section className={cn('card flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3.5', className)} data-testid="ops-strip">
      <div className="min-w-0 w-full sm:w-[220px] sm:shrink-0">
        <h2 className="text-[14px] font-semibold text-default leading-tight tracking-[-0.01em] inline-flex items-center gap-2 max-w-full">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand-50 text-brand-600 shrink-0">{icon}</span>
          <span className="truncate">{title}</span>
        </h2>
        <p className="text-[12px] text-muted mt-1 truncate" title={hint}>{hint}</p>
        <Link to={dashboardPath(route, scope)} className="mt-1 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-default whitespace-nowrap transition-colors">
          Open dashboard <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <ul className="flex flex-wrap items-start gap-x-4 gap-y-2 flex-1 min-w-0 sm:justify-between">
        {items.map((i) => {
          const cls = i.tone === 'bad' && i.value > 0 ? 'text-red-600' : i.tone === 'warn' && i.value > 0 ? 'text-amber-600' : 'text-default';
          const body = (
            <>
              <span className="block text-[11.5px] text-muted whitespace-nowrap">{i.label}</span>
              <span className={cn('block text-[20px] font-semibold tnum tracking-[-0.02em] leading-tight mt-0.5', cls)}>{fmtNumber(i.value)}</span>
            </>
          );
          return <li key={i.label} className="min-w-[64px]">{i.href ? <Link to={i.href} className="block rounded-md -mx-1.5 px-1.5 py-1 hover:bg-surface-2 transition-colors">{body}</Link> : <div className="py-1" title="A figure without a list behind it">{body}</div>}</li>;
        })}
      </ul>
    </section>
  );
}

export function nocStripItems(s: NocStrip, customerId: string): StripItem[] {
  const open: TicketListLink = { customerId: customerId || null, domain: 'not_soc', status: 'open' };
  return [
    { label: 'Open incidents', value: s.openIncidents, href: ticketListPath({ ...open, type: 'incident' }) },
    { label: 'Breached', value: s.breached, tone: 'bad', href: ticketListPath({ ...open, sla: 'breached' }) },
    { label: 'At risk', value: s.atRisk, tone: 'warn', href: ticketListPath({ ...open, sla: 'at_risk' }) },
    { label: 'Unassigned', value: s.unassigned, tone: 'warn', href: ticketListPath({ ...open, assignee: 'unassigned' }) },
    { label: 'Major', value: s.major, tone: 'bad', href: ticketListPath({ ...open, isMajor: true }) },
  ];
}

export function socStripItems(s: SocStrip, customerId: string): StripItem[] {
  const open: TicketListLink = { customerId: customerId || null, domain: 'soc', status: 'open' };
  return [
    { label: 'Open incidents', value: s.open, href: ticketListPath(open) },
    { label: 'Critical / high', value: s.criticalHigh, tone: 'bad', href: s.criticalHighSeverityIds.length ? ticketListPath({ ...open, severityIds: s.criticalHighSeverityIds }) : undefined },
    { label: 'Breached', value: s.breached, tone: 'bad', href: ticketListPath({ ...open, sla: 'breached' }) },
    { label: 'At risk', value: s.atRisk, tone: 'warn', href: ticketListPath({ ...open, sla: 'at_risk' }) },
    { label: 'Unassigned', value: s.unassigned, tone: 'warn', href: ticketListPath({ ...open, assignee: 'unassigned' }) },
  ];
}

export function amcStripItems(s: AmcStrip, customerId: string): StripItem[] {
  const open: TicketListLink = { customerId: customerId || null, domain: 'amc', status: 'open' };
  return [
    { label: 'Open tickets', value: s.open, href: ticketListPath(open) },
    { label: 'Breached', value: s.breached, tone: 'bad', href: ticketListPath({ ...open, sla: 'breached' }) },
    { label: 'At risk', value: s.atRisk, tone: 'warn', href: ticketListPath({ ...open, sla: 'at_risk' }) },
    { label: 'Unassigned', value: s.unassigned, tone: 'warn', href: ticketListPath({ ...open, assignee: 'unassigned' }) },
    // "Due today" is not a list predicate, so it is a figure, not a door.
    { label: 'Due today', value: s.dueToday, tone: 'warn' },
  ];
}

/** One card per operations dashboard the person may open, each number the dashboard's own tile number. */
export function OperationsStrips({ d, scope, className }: { d: Overview; scope: { days: number; customerId: string }; className?: string }) {
  const { noc, soc, amc } = d.strips;
  const cards = [
    noc && <StripCard key="noc" title="Network operations" icon={<Activity className="h-3.5 w-3.5" />} route="/dashboards/noc" scope={scope} hint={`${fmtNumber(noc.openedToday)} opened · ${fmtNumber(noc.resolvedToday)} resolved today · ${fmtNumber(noc.highRisk)} likely to breach`} items={nocStripItems(noc, scope.customerId)} />,
    soc && <StripCard key="soc" title="Security operations" icon={<ShieldAlert className="h-3.5 w-3.5" />} route="/dashboards/soc" scope={scope} hint={`${fmtNumber(soc.openedToday)} opened today · ${fmtNumber(soc.escalated)} escalated`} items={socStripItems(soc, scope.customerId)} />,
    amc && <StripCard key="amc" title="AMC & field service" icon={<Wrench className="h-3.5 w-3.5" />} route="/dashboards/amc" scope={scope} hint={`${fmtNumber(amc.openedToday)} opened today · ${fmtNumber(amc.resolvedThisWeek)} resolved this week · ${fmtNumber(amc.visitsThisWeek)} visits this week`} items={amcStripItems(amc, scope.customerId)} />,
  ].filter(Boolean);
  if (!cards.length) return null;
  return <div className={cn('flex flex-col gap-3', className)}>{cards}</div>;
}

/** Customers with breaches, major incidents or out-of-scope work in the period: the name opens the account, the ticket count opens their list. */
function NeedsAttentionPanel({ d, className }: { d: Overview; className?: string }) {
  const m = d.management!;
  const rows = m.needsAttention.filter((c) => c.slaBreached > 0 || c.major > 0 || c.out_of_scope > 0).slice(0, 6);
  const period = { createdFrom: d.period.from, createdTo: d.period.to };
  return (
    <Panel title="Needs attention" subtitle="Customers with breaches, major incidents or out-of-scope work in the period" to="/reports?tab=run&report=sla_performance" toLabel="SLA report" className={className}>
      {rows.length === 0 ? (
        <div className="text-[13px] text-subtle py-6 text-center">No customer needs attention right now</div>
      ) : (
        <ul className="flex flex-col">
          {rows.map((c) => (
            <li key={c.id} className="flex items-start gap-3 border-b border-default last:border-b-0 py-2.5">
              <span className="min-w-0 flex-1">
                <Link to={`/customers/${c.id}`} className="block text-[13.5px] text-default font-medium truncate leading-snug hover:underline">{c.name}</Link>
                <span className="block text-[12.5px] text-muted truncate mt-0.5">
                  <Link to={ticketListPath({ customerId: c.id, status: 'any', ...period })} className="hover:underline tnum">{fmtNumber(c.tickets)} tickets</Link>
                  {' · '}
                  <Link to={ticketListPath({ customerId: c.id, status: 'any', isMajor: true, ...period })} className="hover:underline tnum">{fmtNumber(c.major)} major</Link>
                  {` · ${fmtNumber(c.out_of_scope)} out of scope`}
                </span>
              </span>
              <span className="shrink-0 inline-flex items-center gap-2 text-[12.5px] tnum">
                {/* Resolution clocks breached on the period's tickets: a clock count, so a figure rather than a door. */}
                {c.slaBreached > 0 && <span className="text-red-600 font-medium">{c.slaBreached} breached</span>}
                {c.compliancePct !== null && <Badge color={c.compliancePct >= 95 ? 'green' : c.compliancePct >= 85 ? 'amber' : 'red'}>{c.compliancePct}%</Badge>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function CsatPanel({ d, className }: { d: Overview; className?: string }) {
  const can = useAuthStore((s) => s.can);
  const c = d.management!.csat;
  const series = c.series.some((p) => p.responses) ? c.series : [];
  return (
    <Panel title="Customer satisfaction" subtitle={`Ratings on tickets resolved ${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}, averaged per week`} to={can('surveys:read') ? '/reports/csat' : undefined} toLabel="Satisfaction" className={className}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <div>
          <Stat label="Average rating" value={fmtRating(c.avg)} tone={ratingTone(c.avg)} />
          <div className="mt-1"><DeltaBadge delta={c.trendAvg} /></div>
        </div>
        <Stat label="Satisfied" value={fmtPct(c.satisfiedPct)} />
        <Stat label="Responses" value={fmtNumber(c.responses)} />
        <Stat label="Low ratings" value={fmtNumber(c.low)} tone={c.low > 0 ? 'bad' : 'default'} />
      </div>
      <TrendChart data={series} x="week" kind="line" height={150} series={[{ key: 'avg', label: 'Average rating', color: STATUS_COLORS.good }]} yDomain={[1, 5]} yTicks={[1, 2, 3, 4, 5]} yFormatter={(v) => String(v)} valueFormatter={(v) => `${v.toFixed(1)}/5`} />
    </Panel>
  );
}

/** Accounts and service levels for those who hold dashboards:management: needs attention, satisfaction, contracts ending and entitlements near their limit. */
export function ManagementExtras({ d, className }: { d: Overview; className?: string }) {
  const m = d.management;
  if (!m) return null;
  const k = m.kpis;
  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 card px-5 py-4" data-testid="management-counts">
        <Stat label="Active customers" value={fmtNumber(k.customersActive)} />
        <Stat label="Active contracts" value={fmtNumber(k.contractsActive)} />
        <Stat label="Ending within 90 days" value={fmtNumber(k.contractsExpiring90d)} tone={k.contractsExpiring90d > 0 ? 'warn' : 'default'} />
        <Stat label="Expired in 30 days" value={fmtNumber(k.contractsExpired30d)} tone={k.contractsExpired30d > 0 ? 'bad' : 'default'} />
        <Stat label="Entitlements over threshold" value={fmtNumber(k.entitlementsOverThreshold)} tone={k.entitlementsOverThreshold > 0 ? 'warn' : 'default'} />
        <Stat label="Entitlements exhausted" value={fmtNumber(k.entitlementsExhausted)} tone={k.entitlementsExhausted > 0 ? 'bad' : 'default'} />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <NeedsAttentionPanel d={d} />
        <CsatPanel d={d} />
        <Panel title="Expiring contracts" subtitle={`${fmtNumber(k.expiringContracts)} ending within 90 days`} to="/contracts?expiringWithinDays=90" toLabel="Contracts">
          <ExpiringContracts items={m.expiringContracts.slice(0, 5)} />
        </Panel>
        <Panel title="Entitlements near limit" subtitle="Visits and hours over their warning threshold" to="/contracts/entitlements" toLabel="Entitlements">
          <EntitlementAlerts items={m.entitlementAlerts.slice(0, 5)} />
        </Panel>
      </div>
    </div>
  );
}

/** A quiet section label between the Overview's blocks. */
export function SectionLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 -mb-2">
      <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-subtle">{children}</div>
      {hint && <div className="text-[12px] text-subtle">{hint}</div>}
    </div>
  );
}
