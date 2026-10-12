import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Star, Inbox, Reply, Timer, CheckCircle2, ShieldCheck, Pin, Wrench, CalendarCheck, GitPullRequestArrow } from 'lucide-react';
import { ErrorBlock, Badge, ProgressBar } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber, fmtDate, fmtDateTime, fmtDuration, fmtPct, relativeTime } from '@/lib/format';
import { cn, truncate } from '@/lib/utils';
import { fmtRating, ratingTone } from '@/components/surveys/api';
import { PRIORITY_LEVEL_COLORS, ANNOUNCEMENT_TYPE_COLORS } from '@/lib/statusColors';
import { portalTicketListPath, complianceTone, type TicketListLink } from '@itsm/shared';
import { portalApi, pk, type PortalHome, type PortalLoadRow } from '@/components/portal/api';
import { PORTAL_KE_STATUS_LABELS } from '@/components/known-errors/api';
import { KpiGrid, type KpiItem } from './KpiGrid';
import { TrendChart } from './TrendChart';
import { BreakdownBar } from './BreakdownBar';
import { DonutChart } from './DonutChart';
import { TicketMiniTable } from './TicketMiniTable';
import { Panel, KpiSkeleton, Skeleton, RowList, Segmented, Stat, type RowItem } from './Panel';
import { STATUS_COLORS } from './chartTheme';
import { SlaComplianceDonut, slaOutcomeLink, SLA_PANEL_SUBTITLE } from './SlaComplianceDonut';
import { toneToKpi } from './OutcomeDonut';
import { useLocalControl } from './localControls';
import { AgeingPanel, RateTable, flowPointHref } from './DeskPanels';

/**
 * The customer portal home's body: the organisation's dashboard for the hero's
 * period and site scope (`GET /dashboards/customer`). Every number is counted
 * live under the organisation (and site) fence with exactly the predicates its
 * door carries, and every door goes through `portalTicketListPath`, so the
 * portal list it opens shows the same number in its count line (held by
 * `apps/api/test/dashboards-consistency.test.ts` as a portal principal). The
 * controls in a panel header (`flow`, `by`, `upcoming`) live in the URL and
 * change that panel alone. A number that cannot reproduce on a list (the SLA
 * compliance percentage, the satisfaction average and its sample, response and
 * resolution times, entitlement usage) is a figure; the percentage's met and
 * breached counts, and the same by priority, are doors (`slaOutcome` with the
 * period as `slaEndedFrom/To`).
 */

const TYPE_PLURAL: Record<string, string> = { incident: 'Incidents', request: 'Requests', problem: 'Problems', change: 'Changes' };
const TYPE_SINGULAR: Record<string, string> = { incident: 'incident', request: 'request', problem: 'problem', change: 'change' };

type FlowView = 'flow' | 'type' | 'breaches';
const FLOW_VIEWS: readonly FlowView[] = ['flow', 'type', 'breaches'];
type ByView = 'priority' | 'site' | 'service';
const BY_VIEWS: readonly ByView[] = ['priority', 'site', 'service'];
type UpcomingView = 'all' | 'visits' | 'maintenance' | 'changes';
const UPCOMING_VIEWS: readonly UpcomingView[] = ['all', 'visits', 'maintenance', 'changes'];
const BY_NOUN: Record<ByView, string> = { priority: 'priority', site: 'site', service: 'the service they concern' };

const KIND: Record<'visit' | 'maintenance' | 'change', { label: string; icon: typeof Wrench; chip: string }> = {
  visit: { label: 'Site visit', icon: Wrench, chip: 'bg-orange-50 text-orange-600' },
  maintenance: { label: 'Preventive maintenance', icon: CalendarCheck, chip: 'bg-amber-50 text-amber-600' },
  change: { label: 'Planned change', icon: GitPullRequestArrow, chip: 'bg-purple-50 text-purple-600' },
};

/** The home's payload for the hero's scope; shared by the page (period and Updated stamp) and the body through one query key. */
export function useCustomerHome(scope: { days: number; siteId: string }, enabled = true) {
  const params = { days: scope.days, siteId: scope.siteId || undefined };
  return useQuery({ queryKey: pk.home(params), queryFn: () => portalApi.home(params), placeholderData: (p) => p, staleTime: 30_000, refetchInterval: 60_000, enabled });
}

const plural = (n: number, word: string, words = `${word}s`) => (n === 1 ? word : words);
const BADGE_TONE = { good: 'green', warning: 'amber', critical: 'red' } as const;

export function CustomerDashboard({ days, siteId, sites }: { days: number; siteId: string; sites: { id: string; name: string }[] }) {
  const can = useAuthStore((s) => s.can);
  const q = useCustomerHome({ days, siteId });
  const [flow, setFlow] = useLocalControl<FlowView>('flow', 'flow', FLOW_VIEWS);
  // "By site" is offered only when the organisation has more than one site; a `by=site` link on a single-site organisation reads as the default.
  const byViews = sites.length > 1 ? BY_VIEWS : BY_VIEWS.filter((v) => v !== 'site');
  const [by, setBy] = useLocalControl<ByView>('by', 'priority', byViews);
  const d = q.data;
  const canChanges = can('portal:status');
  const upcomingViews = canChanges ? UPCOMING_VIEWS : UPCOMING_VIEWS.filter((v) => v !== 'changes');
  const [upcomingView, setUpcomingView] = useLocalControl<UpcomingView>('upcoming', 'all', upcomingViews);
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d)
    return (
      <div className="flex flex-col gap-6">
        <KpiSkeleton count={5} />
        <div className="card p-5">
          <Skeleton rows={6} />
        </div>
      </div>
    );
  const t = d.tickets;
  const path = portalTicketListPath;
  // Every door carries the site scope when one is on; `open` is the organisation's (or site's) open list, the breadcrumb root.
  const site = d.siteId;
  const any: TicketListLink = { siteId: site };
  const open: TicketListLink = { ...any, status: 'open' };
  const openedInPeriod = path({ ...any, status: 'any', createdFrom: d.period.from, createdTo: d.period.to });
  const resolvedInPeriod = path({ ...any, status: 'any', resolvedFrom: d.period.from, resolvedTo: d.period.to });
  const toRate = path({ ...any, statusCategories: ['resolved', 'closed'], csat: 'pending' });
  const periodLabel = `${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}`;
  const sla = d.sla.compliancePct;
  const period = { from: d.period.from, to: d.period.to };
  const spark = d.series.slice(Math.max(0, d.series.length - (days <= 7 ? 7 : 14)));
  const sparkDays = spark.length;
  // "5 incidents · 1 request · 1 change": every type the organisation has open, largest first as the API orders them.
  const typesHint = t.byType.length ? t.byType.map((b) => `${fmtNumber(b.count)} ${plural(b.count, TYPE_SINGULAR[b.type] ?? b.type)}`).join(' · ') : 'nothing open';
  const tiles: KpiItem[] = [
    { label: 'Open tickets', value: fmtNumber(t.open), icon: <Inbox className="h-4 w-4" />, delta: d.deltas.open, lowerIsBetter: true, hint: typesHint, spark: spark.map((s) => s.opened), sparkLabel: `Tickets opened per day, last ${sparkDays} days`, to: path(open) },
    {
      label: 'Awaiting your reply',
      value: fmtNumber(t.awaitingReply),
      icon: <Reply className="h-4 w-4" />,
      tone: t.awaitingReply > 0 ? 'warn' : 'good',
      hint: t.awaitingApproval > 0 ? `${fmtNumber(t.awaitingApproval)} awaiting your approval` : 'nothing waiting on you',
      to: t.awaitingStatusId ? path({ ...open, statusIds: [t.awaitingStatusId] }) : path(open),
      hintTo: t.awaitingApproval > 0 && t.awaitingApprovalStatusId ? path({ ...open, statusIds: [t.awaitingApprovalStatusId] }) : undefined,
    },
    { label: 'Breached', value: fmtNumber(t.breached), icon: <Timer className="h-4 w-4" />, tone: t.breached > 0 ? 'bad' : 'good', hint: `${fmtNumber(t.atRisk)} at risk`, spark: spark.map((s) => s.breaches), sparkLabel: `SLA breaches per day, last ${sparkDays} days`, to: path({ ...open, sla: 'breached' }), hintTo: path({ ...open, sla: 'at_risk' }) },
    { label: `Resolved · ${days}d`, value: fmtNumber(t.resolvedInPeriod), icon: <CheckCircle2 className="h-4 w-4" />, delta: d.deltas.resolvedInPeriod, hint: `${fmtNumber(t.openedInPeriod)} opened in the period`, spark: spark.map((s) => s.resolved), sparkLabel: `Tickets resolved per day, last ${sparkDays} days`, to: resolvedInPeriod, hintTo: openedInPeriod },
    // The percentage is a figure with its delta and sparkline; its met and breached counts are doors (the same the donut's segments open).
    {
      label: `SLA compliance · ${days}d`,
      value: fmtPct(sla, 1),
      icon: <ShieldCheck className="h-4 w-4" />,
      tone: toneToKpi(complianceTone(sla)),
      delta: d.deltas.slaCompliancePct,
      spark: spark.map((s) => s.compliancePct),
      sparkLabel: `Daily resolution SLA compliance, last ${sparkDays} days`,
      hint: (
        <>
          <Link to={path(slaOutcomeLink(any, period, 'met'))} className="hover:text-default hover:underline underline-offset-2 tnum" data-testid="sla-met-door">{fmtNumber(d.sla.met)} met</Link>
          {' · '}
          <Link to={path(slaOutcomeLink(any, period, 'breached'))} className="hover:text-default hover:underline underline-offset-2 tnum" data-testid="sla-breached-door">{fmtNumber(d.sla.breached)} breached</Link>
        </>
      ),
    },
  ];

  // ---- ticket flow: the period's days (UTC, the list's cut); a bar opens that day's tickets
  const live = d.series.some((s) => s.opened || s.resolved || s.breaches);
  const flowSubtitle = { flow: 'Opened and resolved per day; a bar opens that day’s tickets', type: 'Opened per day by type; a bar opens that day’s tickets of that type', breaches: 'SLA clocks breached per day' }[flow];
  // The by-type view stacks every type the organisation raises (the four series sum to the Flow view's opened bars); a type with nothing in the period stays out of the legend.
  const typeSeries = ([['incidentsOpened', 'incident'], ['requestsOpened', 'request'], ['problemsOpened', 'problem'], ['changesOpened', 'change']] as const).filter(([key]) => d.series.some((s) => s[key] > 0));

  // ---- open by priority, site or service: one row per record, breached in red; a row without a record is a figure
  const loadRows = (rows: PortalLoadRow[], key: (id: string) => Partial<TicketListLink>) => rows.map((r) => ({ label: r.label, value: r.open, secondary: r.breached, secondaryLabel: 'breached', href: r.id ? path({ ...open, ...key(r.id) }) : undefined }));
  const byRows =
    by === 'priority'
      ? t.byPriority.map((p) => ({ label: p.label, value: p.count, secondary: p.breached, secondaryLabel: 'breached', color: PRIORITY_LEVEL_COLORS[p.level] ?? p.color, href: p.id ? path({ ...open, priorityIds: [p.id] }) : undefined }))
      : by === 'site'
        ? loadRows(t.bySite, (id) => ({ siteId: id }))
        : loadRows(t.byService, (id) => ({ serviceId: id }));
  const figureRows = byRows.filter((r) => !r.href).length;

  // ---- upcoming: one predicate per number, the same the page each count opens uses
  const u = d.upcoming;
  const countDoor = (n: number | null, noun: string, nouns: string, to: string) => (n === null ? null : <Link key={to} to={to} className="font-medium text-default hover:underline underline-offset-2 tnum">{fmtNumber(n)} {plural(n, noun, nouns)}</Link>);
  // The maintenance page reads `kind` (visit | pm) and `site` (a site id), so a site-scoped count opens the page narrowed to that site.
  const maintenanceDoor = (kind: 'visit' | 'pm') => `/portal/maintenance?kind=${kind}${site ? `&site=${encodeURIComponent(site)}` : ''}`;
  const countDoors = [
    countDoor(u.counts.visits, 'visit', 'visits', maintenanceDoor('visit')),
    countDoor(u.counts.maintenance, 'maintenance', 'maintenance', maintenanceDoor('pm')),
    countDoor(u.counts.changes, 'change', 'changes', '/portal/changes?state=upcoming'),
    countDoor(u.counts.approvals, 'approval', 'approvals', '/portal/approvals'),
  ].filter(Boolean);
  const chip = (k: keyof typeof KIND) => {
    const Icon = KIND[k].icon;
    return <span className={cn('inline-flex h-6 w-6 items-center justify-center rounded-md', KIND[k].chip)}><Icon className="h-3.5 w-3.5" /></span>;
  };
  const upcomingRows: (RowItem & { at: number })[] = [
    ...(upcomingView === 'all' || upcomingView === 'visits' ? u.visits : []).map((v) => ({ key: `v-${v.id}`, at: v.scheduledStart ? Date.parse(v.scheduledStart) : Number.MAX_SAFE_INTEGER, href: `/portal/maintenance?visit=${v.id}`, leading: chip('visit'), primary: v.title, secondary: [KIND.visit.label, v.site, v.engineer].filter(Boolean).join(' · '), right: v.scheduledStart ? fmtDateTime(v.scheduledStart) : 'to be scheduled' })),
    ...(upcomingView === 'all' || upcomingView === 'maintenance' ? u.maintenance : []).map((m) => ({ key: `m-${m.id}`, at: Date.parse(m.scheduledDate ?? m.plannedDate), href: `/portal/maintenance?occurrence=${m.id}`, leading: chip('maintenance'), primary: m.program, secondary: [KIND.maintenance.label, m.site, m.engineer].filter(Boolean).join(' · '), right: fmtDate(m.scheduledDate ?? m.plannedDate) })),
    ...((upcomingView === 'all' || upcomingView === 'changes') && u.changes ? u.changes : []).map((c) => ({ key: `c-${c.id}`, at: c.scheduledStart ? Date.parse(c.scheduledStart) : Number.MAX_SAFE_INTEGER, href: `/portal/tickets/${c.id}`, leading: chip('change'), primary: `${c.number} · ${c.title}`, secondary: [KIND.change.label, c.service?.name, c.downtimeExpectedMinutes ? `${fmtDuration(c.downtimeExpectedMinutes)} downtime expected` : null].filter(Boolean).join(' · '), right: c.scheduledStart ? fmtDateTime(c.scheduledStart) : 'window to be set' })),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(0, 8);
  const upcomingOptions = [{ value: 'all' as const, label: 'All' }, { value: 'visits' as const, label: 'Visits' }, { value: 'maintenance' as const, label: 'Maintenance' }, ...(u.changes ? [{ value: 'changes' as const, label: 'Changes' }] : [])];

  // ---- SLA compliance by priority: the same two doors per priority (a "No priority" row is a figure)
  const slaRows: RowItem[] = d.sla.byPriority.slice(0, 6).map((g) => ({
    key: g.id ?? g.label,
    leading: <Badge color={PRIORITY_LEVEL_COLORS[g.level] ?? g.color ?? 'slate'}>{g.label}</Badge>,
    primary: (
      <span className="text-[12.5px] text-muted tnum">
        {g.id ? <Link to={path({ ...slaOutcomeLink(any, period, 'met'), priorityIds: [g.id] })} className="hover:text-default hover:underline underline-offset-2">{fmtNumber(g.met)} met</Link> : `${fmtNumber(g.met)} met`}
        {' · '}
        {g.id ? <Link to={path({ ...slaOutcomeLink(any, period, 'breached'), priorityIds: [g.id] })} className={cn('hover:underline underline-offset-2', g.breached > 0 ? 'text-red-600' : 'hover:text-default')}>{fmtNumber(g.breached)} breached</Link> : `${fmtNumber(g.breached)} breached`}
      </span>
    ),
    right: g.compliancePct === null ? <span className="text-subtle">—</span> : <Badge color={BADGE_TONE[complianceTone(g.compliancePct) ?? 'good']}>{g.compliancePct}%</Badge>,
  }));
  const pending = d.csat.pending.count;
  const contractsPath = '/portal/services/contracts';
  const responsiveness = d.byPriorityResponsiveness.filter((r) => r.opened > 0 || r.resolved > 0);

  return (
    <div className="flex flex-col gap-6">
      <KpiGrid columns={5} items={tiles} />
      {pending > 0 && (
        <div className="-mt-2 rounded-xl border border-amber-200 bg-amber-50 text-amber-900 px-4 py-3 text-[13px] flex flex-wrap items-center gap-2" role="status" data-testid="rate-banner">
          <Star className="h-4 w-4" /> You have {fmtNumber(pending)} {plural(pending, 'ticket')} to rate · <Link to={toRate} className="font-medium hover:underline">Rate them</Link>
        </div>
      )}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Ticket flow" subtitle={`${flowSubtitle} · ${periodLabel}`} to={openedInPeriod} toLabel="Opened in the period" className="xl:col-span-2 rise-in rise-in-2" action={<Segmented size="sm" options={[{ value: 'flow', label: 'Flow' }, { value: 'type', label: 'By type' }, { value: 'breaches', label: 'Breaches' }]} value={flow} onChange={setFlow} />}>
          {flow === 'flow' && <TrendChart data={live ? d.series : []} x="day" kind="bar" height={240} series={[{ key: 'opened', label: 'Opened' }, { key: 'resolved', label: 'Resolved', color: STATUS_COLORS.good }]} pointHref={flowPointHref(any, { opened: 'created', resolved: 'resolved' }, path)} />}
          {flow === 'type' && <TrendChart data={live && typeSeries.length ? d.series : []} x="day" kind="bar" stacked height={240} series={typeSeries.map(([key, type]) => ({ key, label: TYPE_PLURAL[type] }))} pointHref={flowPointHref(any, Object.fromEntries(typeSeries.map(([key, type]) => [key, { kind: 'created', type }])), path)} />}
          {flow === 'breaches' && <TrendChart data={live ? d.series : []} x="day" kind="bar" height={240} series={[{ key: 'breaches', label: 'SLA breaches', color: STATUS_COLORS.critical }]} />}
        </Panel>
        <Panel title="Open by type" subtitle="Open tickets now; a slice opens the list" to={path(open)} toLabel="All open" className="rise-in rise-in-2">
          <DonutChart size={150} centerLabel="open" emptyText="No open tickets" slices={t.byType.map((b) => ({ key: b.type, label: TYPE_PLURAL[b.type] ?? b.type, value: b.count, href: path({ ...open, type: b.type as TicketListLink['type'] }) }))} />
          {t.byType.some((b) => b.breached > 0) && (
            <div className="mt-4 pt-3 border-t border-default text-[12px] text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Breached:</span>
              {t.byType.filter((b) => b.breached > 0).map((b) => (
                <Link key={b.type} to={path({ ...open, type: b.type as TicketListLink['type'], sla: 'breached' })} className="text-red-600 font-medium tnum hover:underline">
                  {fmtNumber(b.breached)} {(TYPE_PLURAL[b.type] ?? b.type).toLowerCase()}
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Open by" subtitle={`Open tickets by ${BY_NOUN[by]}, breached in red`} to={path(open)} toLabel="All open" className="rise-in rise-in-3" action={<Segmented size="sm" options={byViews.map((v) => ({ value: v, label: v === 'priority' ? 'Priority' : v === 'site' ? 'Site' : 'Service' }))} value={by} onChange={setBy} />}>
          <BreakdownBar dense emptyText="No open tickets" items={byRows} max={Math.max(1, ...byRows.map((r) => r.value))} />
          {figureRows > 0 && <div className="mt-3 text-[11.5px] text-subtle">A row without a record (no priority, no site, no service) is a figure, not a door.</div>}
        </Panel>
        <AgeingPanel ageing={d.ageing} link={open} path={path} className="rise-in rise-in-3" />
        <Panel title="Announcements" subtitle="For your organisation, pinned first" to={can('portal:status') ? '/portal/status' : undefined} toLabel="Service status" className="rise-in rise-in-3">
          <RowList
            dense
            empty="No announcements right now"
            items={d.announcements.map((a) => ({
              key: a.id,
              href: a.sourceTicket ? `/portal/tickets/${a.sourceTicket.id}` : undefined,
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
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Your open tickets" subtitle="Most recent activity first" to={path(open)} toLabel="All open" className="xl:col-span-2 rise-in rise-in-4" padded={false}>
          <div className="px-5">
            <TicketMiniTable rows={d.recentTickets} max={8} columns={['priority', 'status', 'sla', 'activity']} empty="No open tickets. Raise one from the portal whenever you need us." />
          </div>
        </Panel>
        <Panel
          title="Upcoming"
          subtitle={<span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5" data-testid="upcoming-counts">Next {u.horizonDays} days: {countDoors.length ? countDoors.map((door, i) => <span key={i} className="inline-flex items-center gap-1.5">{i > 0 && <span aria-hidden>·</span>}{door}</span>) : 'nothing scheduled'}</span>}
          to="/portal/maintenance"
          toLabel="Maintenance & visits"
          className="rise-in rise-in-4"
          action={<Segmented size="sm" options={upcomingOptions} value={upcomingView} onChange={setUpcomingView} />}
        >
          <RowList dense items={upcomingRows} empty={`Nothing scheduled in the next ${u.horizonDays} days`} />
          <div className="mt-3 text-[11.5px] text-subtle">Changes follow the planned-changes window; changes and approvals are organisation-wide.</div>
        </Panel>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Response by priority" subtitle={`Tickets opened or resolved ${periodLabel}: time to first response and to resolve, first-contact resolution and reopens`} className="xl:col-span-2 rise-in rise-in-4">
          <RateTable
            columns={['Priority', 'Opened', 'Resolved', 'First response', 'Resolution', 'First contact', 'Reopened']}
            empty="No tickets opened or resolved in this period"
            rows={responsiveness.map((r) => ({
              key: r.id ?? r.priority,
              label: r.priority,
              color: PRIORITY_LEVEL_COLORS[r.level] ?? null,
              cells: [
                { value: fmtNumber(r.opened), href: r.id ? path({ ...any, status: 'any', priorityIds: [r.id], createdFrom: d.period.from, createdTo: d.period.to }) : undefined },
                { value: fmtNumber(r.resolved), href: r.id ? path({ ...any, status: 'any', priorityIds: [r.id], resolvedFrom: d.period.from, resolvedTo: d.period.to }) : undefined },
                { value: fmtDuration(r.mttaMinutes), tone: r.mttaMinutes === null ? 'muted' : 'default' },
                { value: fmtDuration(r.mttrMinutes), tone: r.mttrMinutes === null ? 'muted' : 'default' },
                { value: fmtPct(r.fcrPct), tone: r.fcrPct === null ? 'muted' : 'default' },
                { value: fmtPct(r.reopenPct), tone: r.reopenPct === null ? 'muted' : (r.reopenPct ?? 0) > 10 ? 'bad' : 'default' },
              ],
            }))}
          />
        </Panel>
        <div className="flex flex-col gap-6 min-w-0 rise-in rise-in-4">
          {can('portal:kedb') && (
            <Panel title="Known issues with a workaround" subtitle={d.knownErrors.published ? `${fmtNumber(d.knownErrors.published)} published for your organisation` : 'Published for your organisation'} to="/knowledge/known-errors" toLabel="All known issues">
              <RowList dense empty="No known issues right now" items={d.knownErrors.items.map((k) => ({ key: k.id, primary: k.title, secondary: PORTAL_KE_STATUS_LABELS[k.keStatus] ?? k.keStatus, right: k.publishedAt ? fmtDate(k.publishedAt) : undefined, href: `/knowledge/known-errors/${k.id}` }))} />
            </Panel>
          )}
          <Panel title="Your service team" subtitle="Who to contact">
            <RowList
              dense
              empty="No team assigned yet"
              items={[
                ...(d.serviceTeam.accountManager ? [{ key: 'am', primary: d.serviceTeam.accountManager.name, secondary: `Account manager · ${d.serviceTeam.accountManager.email}${d.serviceTeam.accountManager.phone ? ` · ${d.serviceTeam.accountManager.phone}` : ''}` }] : []),
                ...d.serviceTeam.teams.slice(0, 4).map((tm) => ({ key: tm.id, primary: tm.name, secondary: tm.email ?? (tm.manager_name ? `Managed by ${tm.manager_name}` : '') })),
              ]}
            />
          </Panel>
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Panel title={`Satisfaction · ${days}d`} subtitle="The ratings your organisation gave in the period" to={pending > 0 ? toRate : undefined} toLabel="To rate" className="rise-in rise-in-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Average rating" value={fmtRating(d.csat.avg)} tone={ratingTone(d.csat.avg)} />
            <Stat label="Responses" value={fmtNumber(d.csat.responses)} />
            <Stat label="Satisfied" value={d.csat.responses ? fmtPct(d.csat.satisfiedPct) : '—'} />
          </div>
          <div className="mt-4 pt-3 border-t border-default text-[12.5px] text-muted">
            {pending > 0 ? (
              <Link to={toRate} className="hover:underline underline-offset-2"><span className="font-medium text-default tnum">{fmtNumber(pending)}</span> {plural(pending, 'ticket')} to rate</Link>
            ) : (
              'Every resolved ticket is rated'
            )}
          </div>
        </Panel>
        <Panel title={`SLA compliance · ${days}d`} subtitle={SLA_PANEL_SUBTITLE} className="rise-in rise-in-4" to={can('portal:contracts') ? '/portal/services/sla' : undefined} toLabel="Service levels">
          <SlaComplianceDonut sla={d.sla} period={period} link={any} path={path} />
          {slaRows.length > 0 && (
            <div className="mt-4 pt-3 border-t border-default" data-testid="sla-by-priority">
              <div className="text-[12px] text-muted mb-1">By priority</div>
              <RowList dense items={slaRows} />
            </div>
          )}
        </Panel>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Panel title="Contracts" subtitle="Active agreements and renewal dates" to={contractsPath} className="rise-in rise-in-4">
          <RowList
            dense
            empty="No active contracts"
            items={d.contracts.slice(0, 4).map((c) => ({ key: c.id, href: contractsPath, primary: c.name, secondary: `${c.number}${c.services ? ` · ${c.services}` : ''}`, right: <Badge color={c.days_to_expiry <= 30 ? 'amber' : 'green'}>{c.days_to_expiry}d left</Badge> }))}
          />
        </Panel>
        <Panel title="Entitlements" subtitle="Usage this period" to={contractsPath} className="rise-in rise-in-4">
          {d.entitlements.length === 0 ? (
            <div className="text-[13px] text-subtle py-6 text-center">No entitlements on active contracts</div>
          ) : (
            <ul className="flex flex-col gap-3">
              {d.entitlements.slice(0, 4).map((e) => (
                <li key={e.id} className="text-[12.5px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-default truncate">{e.name}</span>
                    <span className="text-muted tnum shrink-0">{fmtNumber(e.used, 1)} / {fmtNumber(e.quantity, 1)} {e.unit}</span>
                  </div>
                  <ProgressBar pct={e.pct} className="mt-1.5" />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      {d.reports.length > 0 && (
        <div className="text-[12.5px] text-muted">
          Latest report: <Link to="/reports?tab=history" className="text-brand-700 hover:underline">{d.reports[0].name}</Link> · {fmtDate(d.reports[0].created_at)}
        </div>
      )}
    </div>
  );
}
