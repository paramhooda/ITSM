import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { ErrorBlock, Badge, ProgressBar } from '@/components/ui';
import { get } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber, fmtDate, fmtDateTime, fmtPct } from '@/lib/format';
import { fmtRating, ratingTone } from '@/components/surveys/api';
import { PRIORITY_LEVEL_COLORS } from '@/lib/statusColors';
import { useLookups } from '@/hooks/useLookups';
import { ticketListPath, type TicketListLink } from '@itsm/shared';
import { KpiGrid } from './KpiGrid';
import { TrendChart } from './TrendChart';
import { BreakdownBar } from './BreakdownBar';
import { SlaGauge } from './SlaGauge';
import { TicketMiniTable } from './TicketMiniTable';
import { Panel, KpiSkeleton, Skeleton, RowList, Segmented, type RowItem } from './Panel';
import { PORTAL_KE_STATUS_LABELS } from '@/components/known-errors/api';
import type { TicketRow } from './types';

interface SlaBlock { totals: { met: number; breached: number; running: number; compliancePct: number | null; avgElapsedMinutes: number | null }; groups: { key: string; label: string; met: number; breached: number; running: number; compliancePct: number | null }[] }
interface Customer {
  generatedAt: string;
  customer: { id: string; name: string; code: string; timezone: string };
  period: { days: number; from: string; to: string };
  /** Tickets opened and resolved per day, last 30 days. */
  series: { day: string; opened: number; resolved: number }[];
  tickets: { open: number; byStatusCategory: Record<string, number>; byPriority: { id: string | null; key: string | null; label: string; color: string | null; level: number; count: number }[]; byType: Record<string, number>; awaitingReply: number; awaitingApproval: number; resolved30d: number; opened30d: number; majorOpen: number };
  sla: { period?: SlaBlock & { days: number }; days30: SlaBlock; days90: SlaBlock };
  contracts: { id: string; number: string; name: string; status: string; start_date: string; end_date: string; days_to_expiry: number; auto_renew: boolean; type: string | null; services: string | null }[];
  entitlements: { id: string; name: string; unit: string; period: string; contractNumber: string | null; quantity: number; used: number; remaining: number; pct: number; overThreshold: boolean; exhausted: boolean; periodEnd: string }[];
  upcomingMaintenance: { id: string; program: string; planned_date: string; scheduled_date: string | null; status: string; site: string | null; engineer: string | null }[];
  scheduledVisits: { id: string; number: string; title: string; status: string; scheduled_start: string | null; engineer: string | null; site: string | null }[];
  reports: { id: string; name: string; report_key: string; format: string; created_at: string; attachment_id: string | null; filename: string | null; size: number | null; period: string | null }[];
  recentTickets: TicketRow[];
  serviceTeam: { accountManager: { id: string; name: string; email: string; phone: string | null } | null; teams: { id: string; name: string; team_type: string; email: string | null; manager_name: string | null }[] };
  /** Published known errors of the organisation (empty for a customer user without portal:kedb). */
  knownErrors?: { published: number; items: { id: string; number: string; title: string; keStatus: string; publishedAt: string | null }[] };
  /** The organisation's satisfaction ratings in the period and the tickets still waiting for one (items for customer users only). */
  csat?: { avg: number | null; responses: number; satisfiedPct: number | null; pending: { count: number; items: { ticketId: string; number: string; title: string; requestedAt: string; expiresAt: string }[] } };
}

export function CustomerDashboard({ customerId, days = 30 }: { customerId?: string; days?: number }) {
  const isCustomer = useAuthStore((s) => s.user?.userType === 'customer');
  const can = useAuthStore((s) => s.can);
  const [upcomingView, setUpcomingView] = useState<'both' | 'visits' | 'pm'>('both');
  // The staff link behind "awaiting your reply" names the status by id (the portal list keeps its own `status=awaiting` key).
  const { options } = useLookups();
  const pendingCustomer = options('ticket_status').find((o) => o.key === 'pending_customer')?.id;
  const q = useQuery({ queryKey: ['dashboards', 'customer', customerId ?? 'me', days], queryFn: () => get<Customer>('/dashboards/customer', { customerId, days }), placeholderData: (p) => p, staleTime: 30_000 });
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
  const t = d.tickets;
  const slaBlock = d.sla.period ?? d.sla.days30;
  const sla = slaBlock.totals.compliancePct;
  const open: TicketListLink = { customerId: d.customer.id, status: 'open' };
  const ticketsHref = isCustomer ? '/portal/tickets' : ticketListPath(open);
  const openTickets = d.recentTickets.filter((r) => r.status_category && !['resolved', 'closed', 'cancelled'].includes(r.status_category));
  const upcoming: RowItem[] = [
    ...(upcomingView === 'pm' ? [] : d.scheduledVisits).map((v) => ({ key: `v-${v.id}`, href: isCustomer ? `/portal/maintenance?visit=${v.id}` : `/field/${v.id}`, primary: v.title, secondary: `Site visit${v.site ? ` · ${v.site}` : ''}${v.engineer ? ` · ${v.engineer}` : ''}`, right: v.scheduled_start ? fmtDateTime(v.scheduled_start) : 'to be scheduled' })),
    ...(upcomingView === 'visits' ? [] : d.upcomingMaintenance).map((m) => ({ key: `m-${m.id}`, href: isCustomer ? `/portal/maintenance?occurrence=${m.id}` : '/maintenance', primary: m.program, secondary: `Preventive maintenance${m.site ? ` · ${m.site}` : ''}${m.engineer ? ` · ${m.engineer}` : ''}`, right: fmtDate(m.scheduled_date ?? m.planned_date) })),
  ].slice(0, 6);
  // A period with nothing opened or resolved shows the chart's empty text rather than a flat line.
  const flow = d.series.some((s) => s.opened || s.resolved) ? d.series : [];
  // Priority colours follow the level (P1 red → P5 slate), never the row position; the API orders P1 first.
  const priorities = t.byPriority.map((p) => ({
    label: p.label,
    value: p.count,
    color: PRIORITY_LEVEL_COLORS[p.level] ?? p.color,
    href: p.key ? (isCustomer ? `/portal/tickets?priority=${p.key}` : ticketListPath({ ...open, priorityIds: [p.id as string] })) : undefined,
  }));
  const slaGroups: RowItem[] = slaBlock.groups.slice(0, 5).map((g) => ({
    key: g.key || g.label,
    primary: g.label,
    secondary: `${fmtNumber(g.met)} met · ${fmtNumber(g.breached)} breached`,
    right: g.compliancePct === null ? <span className="text-subtle">no targets completed</span> : <Badge color={g.compliancePct >= 95 ? 'green' : g.compliancePct >= 85 ? 'amber' : 'red'}>{g.compliancePct}%</Badge>,
  }));
  return (
    <div className="flex flex-col gap-6">
      <KpiGrid
        columns={5}
        items={[
          { label: 'Open tickets', value: fmtNumber(t.open), hint: `${fmtNumber(t.byType.incident ?? 0)} incidents · ${fmtNumber(t.byType.request ?? 0)} requests`, to: ticketsHref },
          { label: 'Awaiting your reply', value: fmtNumber(t.awaitingReply), tone: t.awaitingReply > 0 ? 'warn' : 'good', hint: t.awaitingApproval ? `${t.awaitingApproval} awaiting your approval` : 'nothing waiting on you', to: isCustomer ? '/portal/tickets?status=awaiting' : pendingCustomer ? ticketListPath({ ...open, statusIds: [pendingCustomer] }) : ticketsHref },
          { label: `Resolved · ${days} days`, value: fmtNumber(t.resolved30d), hint: `${fmtNumber(t.opened30d)} opened in the same period`, to: isCustomer ? undefined : ticketListPath({ customerId: d.customer.id, status: 'any', resolvedFrom: d.period.from, resolvedTo: d.period.to }) },
          { label: `SLA compliance · ${days} days`, value: sla === null ? '—' : `${sla}%`, tone: sla === null ? 'default' : sla >= 95 ? 'good' : sla >= 85 ? 'warn' : 'bad', hint: `${slaBlock.totals.met} met · ${slaBlock.totals.breached} breached` },
          { label: `Satisfaction · ${days} days`, value: fmtRating(d.csat?.avg), tone: ratingTone(d.csat?.avg), hint: d.csat?.responses ? `${fmtNumber(d.csat.responses)} ${d.csat.responses === 1 ? 'response' : 'responses'} · ${fmtPct(d.csat.satisfiedPct)} satisfied` : 'no ratings yet', to: isCustomer ? '/portal/tickets?status=rate' : can('surveys:read') ? `/reports/csat?customerId=${d.customer.id}&days=${days}` : undefined },
        ]}
      />
      {isCustomer && d.csat && d.csat.pending.count > 0 && (
        <div className="-mt-2 rounded-xl border border-amber-200 bg-amber-50 text-amber-900 px-4 py-3 text-[13px] flex flex-wrap items-center gap-2" role="status">
          <Star className="h-4 w-4" /> You have {fmtNumber(d.csat.pending.count)} {d.csat.pending.count === 1 ? 'ticket' : 'tickets'} to rate · <Link to="/portal/tickets?status=rate" className="font-medium hover:underline">Rate them</Link>
        </div>
      )}
      <Panel title="Ticket flow" subtitle={`Opened and resolved per day, last ${days} days`} to={ticketsHref}>
        <TrendChart data={flow} x="day" kind="area" series={[{ key: 'opened', label: 'Opened' }, { key: 'resolved', label: 'Resolved', color: '#0f9d6f' }]} height={220} />
      </Panel>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Panel title="Open tickets by priority" subtitle="Highest priority first" to={ticketsHref}>
          <BreakdownBar items={priorities} emptyText="No open tickets" />
        </Panel>
        <Panel title={`SLA compliance · ${days} days`} subtitle="Resolution targets on tickets raised in the period, by priority">
          <SlaGauge pct={sla} met={slaBlock.totals.met} breached={slaBlock.totals.breached} label="Targets met" />
          <div className="mt-4 pt-3 border-t border-default">
            <RowList dense items={slaGroups} empty={`No targets completed in the last ${days} days`} />
          </div>
        </Panel>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Your open tickets" subtitle="Most recently updated first" to={ticketsHref} className="xl:col-span-2" padded={false}>
          <div className="px-5">
            <TicketMiniTable rows={openTickets.length ? openTickets : d.recentTickets} max={8} columns={['priority', 'status', 'sla', 'activity']} empty="No open tickets. Raise one from the portal whenever you need us." />
          </div>
        </Panel>
        <div className="flex flex-col gap-6 min-w-0">
          {(!isCustomer || can('portal:kedb')) && (
            <Panel title="Known issues with a workaround" subtitle={d.knownErrors?.published ? `${fmtNumber(d.knownErrors.published)} published for your organisation` : 'Published for your organisation'} to="/knowledge/known-errors" toLabel="All known issues">
              <RowList dense empty="No known issues right now" items={(d.knownErrors?.items ?? []).map((k) => ({ key: k.id, primary: k.title, secondary: PORTAL_KE_STATUS_LABELS[k.keStatus] ?? k.keStatus, right: k.publishedAt ? fmtDate(k.publishedAt) : undefined, href: `/knowledge/known-errors/${k.id}` }))} />
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
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Panel title="Upcoming maintenance & visits" subtitle="Next 30 days" to={isCustomer ? '/portal/maintenance' : '/maintenance'} action={<Segmented size="sm" options={[{ value: 'both', label: 'Both' }, { value: 'visits', label: 'Visits' }, { value: 'pm', label: 'Maintenance' }]} value={upcomingView} onChange={setUpcomingView} />}>
          <RowList dense items={upcoming} empty="Nothing scheduled in the next 30 days" />
        </Panel>
        <Panel title="Contracts" subtitle="Active agreements and renewal dates" to={isCustomer ? '/portal/services' : `/contracts?customerId=${d.customer.id}`}>
          <RowList
            dense
            empty="No active contracts"
            items={d.contracts.slice(0, 4).map((c) => ({ key: c.id, href: isCustomer ? '/portal/services' : `/contracts/${c.id}`, primary: c.name, secondary: `${c.number}${c.services ? ` · ${c.services}` : ''}`, right: <Badge color={c.days_to_expiry <= 30 ? 'amber' : 'green'}>{c.days_to_expiry}d left</Badge> }))}
          />
        </Panel>
        <Panel title="Entitlements" subtitle="Usage this period" to={isCustomer ? '/portal/services' : `/contracts?customerId=${d.customer.id}`}>
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
