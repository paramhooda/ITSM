import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Card, LoadingBlock, ErrorBlock, Badge, Button } from '@/components/ui';
import { get, download } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { fmtDuration, fmtNumber, fmtDate, fmtDateTime, relativeTime, fmtBytes } from '@/lib/format';
import { KpiGrid } from './KpiGrid';
import { BreakdownBar } from './BreakdownBar';
import { SlaGauge } from './SlaGauge';
import { TicketMiniTable } from './TicketMiniTable';
import { EntitlementAlerts } from './EntitlementAlerts';
import type { TicketRow } from './types';

interface SlaBlock { totals: { met: number; breached: number; running: number; compliancePct: number | null; avgElapsedMinutes: number | null }; groups: { key: string; label: string; met: number; breached: number; running: number; compliancePct: number | null }[] }
interface Customer {
  generatedAt: string;
  customer: { id: string; name: string; code: string; timezone: string };
  tickets: { open: number; byStatusCategory: Record<string, number>; byPriority: { label: string; color: string | null; level: number; count: number }[]; byType: Record<string, number>; awaitingReply: number; awaitingApproval: number; resolved30d: number; opened30d: number; majorOpen: number };
  sla: { days30: SlaBlock; days90: SlaBlock };
  contracts: { id: string; number: string; name: string; status: string; start_date: string; end_date: string; days_to_expiry: number; auto_renew: boolean; type: string | null; services: string | null }[];
  entitlements: { id: string; name: string; unit: string; period: string; contractNumber: string | null; quantity: number; used: number; remaining: number; pct: number; overThreshold: boolean; exhausted: boolean; periodEnd: string }[];
  upcomingMaintenance: { id: string; program: string; planned_date: string; scheduled_date: string | null; status: string; site: string | null; engineer: string | null }[];
  scheduledVisits: { id: string; number: string; title: string; status: string; scheduled_start: string | null; engineer: string | null; site: string | null }[];
  reports: { id: string; name: string; report_key: string; format: string; created_at: string; attachment_id: string | null; filename: string | null; size: number | null; period: string | null }[];
  recentTickets: TicketRow[];
  serviceTeam: { accountManager: { id: string; name: string; email: string; phone: string | null } | null; teams: { id: string; name: string; team_type: string; email: string | null; manager_name: string | null }[] };
}

export function CustomerDashboard({ customerId }: { customerId?: string }) {
  const isCustomer = useAuthStore((s) => s.user?.userType === 'customer');
  const q = useQuery({ queryKey: ['dashboards', 'customer', customerId ?? 'me'], queryFn: () => get<Customer>('/dashboards/customer', { customerId }), placeholderData: (p) => p, staleTime: 30_000 });
  const d = q.data;
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!d) return <LoadingBlock />;
  const t = d.tickets;
  const ticketsHref = isCustomer ? '/portal/tickets' : `/tickets?customerId=${d.customer.id}`;
  return (
    <div className="flex flex-col gap-4">
      <KpiGrid
        items={[
          { label: 'Open tickets', value: fmtNumber(t.open), hint: `${fmtNumber(t.byType.incident ?? 0)} incidents · ${fmtNumber(t.byType.request ?? 0)} requests`, onClick: () => (window.location.href = ticketsHref) },
          { label: 'Awaiting your reply', value: fmtNumber(t.awaitingReply), tone: t.awaitingReply > 0 ? 'warn' : 'default', hint: t.awaitingApproval ? `${t.awaitingApproval} awaiting approval` : undefined },
          { label: 'Resolved (30 days)', value: fmtNumber(t.resolved30d), hint: `${fmtNumber(t.opened30d)} opened` },
          { label: 'SLA compliance (30d)', value: d.sla.days30.totals.compliancePct === null ? '—' : `${d.sla.days30.totals.compliancePct}%`, tone: d.sla.days30.totals.compliancePct === null ? 'default' : d.sla.days30.totals.compliancePct >= 95 ? 'good' : 'warn', hint: `${d.sla.days30.totals.breached} breached` },
          { label: 'Active contracts', value: fmtNumber(d.contracts.length), hint: d.contracts[0] ? `next renewal in ${d.contracts[0].days_to_expiry}d` : undefined },
          { label: 'Major incidents open', value: fmtNumber(t.majorOpen), tone: t.majorOpen > 0 ? 'bad' : 'good' },
        ]}
      />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Service levels">
          <div className="flex flex-col gap-4">
            <SlaGauge pct={d.sla.days30.totals.compliancePct} met={d.sla.days30.totals.met} breached={d.sla.days30.totals.breached} label="Last 30 days" size={96} />
            <SlaGauge pct={d.sla.days90.totals.compliancePct} met={d.sla.days90.totals.met} breached={d.sla.days90.totals.breached} label="Last 90 days" size={96} />
          </div>
          {d.sla.days30.groups.length > 0 && (
            <table className="table mt-3 [&_td]:py-1 [&_th]:py-1">
              <thead><tr><th>Priority</th><th className="text-right">30d</th><th className="text-right">90d</th></tr></thead>
              <tbody>
                {d.sla.days90.groups.map((g) => {
                  const g30 = d.sla.days30.groups.find((x) => x.key === g.key);
                  return <tr key={g.key}><td>{g.label}</td><td className="text-right tabular-nums">{g30?.compliancePct ?? '—'}{g30?.compliancePct !== null && g30 ? '%' : ''}</td><td className="text-right tabular-nums">{g.compliancePct ?? '—'}{g.compliancePct !== null ? '%' : ''}</td></tr>;
                })}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Open tickets by priority">
          <BreakdownBar items={t.byPriority.map((p) => ({ label: p.label, value: p.count, color: p.color }))} emptyText="No open tickets" />
          <div className="mt-4 text-[12.5px] font-medium text-muted mb-1">By status</div>
          <BreakdownBar dense items={Object.entries(t.byStatusCategory).map(([k, v]) => ({ label: k.replace(/_/g, ' '), value: v }))} emptyText="—" />
        </Card>
        <Card title="Your service team">
          <dl className="text-[12.5px] flex flex-col gap-2">
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-subtle">Account manager</dt>
              <dd>{d.serviceTeam.accountManager ? <>{d.serviceTeam.accountManager.name} · <a className="hover:underline text-brand-700 dark:text-brand-300" href={`mailto:${d.serviceTeam.accountManager.email}`}>{d.serviceTeam.accountManager.email}</a>{d.serviceTeam.accountManager.phone ? ` · ${d.serviceTeam.accountManager.phone}` : ''}</> : <span className="text-subtle">Not assigned</span>}</dd>
            </div>
            {d.serviceTeam.teams.map((tm) => (
              <div key={tm.id}>
                <dt className="text-[11px] uppercase tracking-wide text-subtle">{tm.name}</dt>
                <dd>{tm.email ? <a className="hover:underline text-brand-700 dark:text-brand-300" href={`mailto:${tm.email}`}>{tm.email}</a> : <span className="text-subtle">—</span>}{tm.manager_name ? ` · ${tm.manager_name}` : ''}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Contracts" actions={!isCustomer && <Link to={`/contracts?customerId=${d.customer.id}`} className="text-[11.5px] text-brand-700 dark:text-brand-300 hover:underline">All</Link>}>
          {d.contracts.length === 0 && <div className="text-[13px] text-subtle py-4 text-center">No active contracts</div>}
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {d.contracts.map((c) => (
              <li key={c.id} className="py-1.5 flex items-center justify-between gap-2 text-[12.5px]">
                <div className="min-w-0">
                  {isCustomer ? <span className="font-medium">{c.name}</span> : <Link to={`/contracts/${c.id}`} className="font-medium hover:underline">{c.name}</Link>}
                  <div className="text-subtle text-[11.5px] truncate"><span className="font-mono">{c.number}</span>{c.type ? ` · ${c.type}` : ''} · {fmtDate(c.start_date)} – {fmtDate(c.end_date)}{c.services ? ` · ${c.services}` : ''}</div>
                </div>
                <Badge color={c.days_to_expiry <= 30 ? 'amber' : 'green'}>{c.days_to_expiry}d left</Badge>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Entitlement utilization">
          <EntitlementAlerts showCustomer={false} items={d.entitlements.map((e) => ({ id: e.id, name: e.name, unit: e.unit, contractNumber: e.contractNumber, utilization: { pct: e.pct, used: e.used, quantity: e.quantity, remaining: e.remaining, exhausted: e.exhausted, overThreshold: e.overThreshold, periodEnd: e.periodEnd } }))} emptyText="No entitlements on active contracts" />
        </Card>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Upcoming maintenance (30 days)">
          {d.upcomingMaintenance.length === 0 && <div className="text-[13px] text-subtle py-4 text-center">No maintenance planned</div>}
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {d.upcomingMaintenance.map((m) => (
              <li key={m.id} className="py-1.5 text-[12.5px]"><span className="font-medium">{m.program}</span> <Badge color="slate" className="ml-1">{m.status}</Badge><div className="text-subtle text-[11.5px]">{fmtDate(m.scheduled_date ?? m.planned_date)}{m.site ? ` · ${m.site}` : ''}{m.engineer ? ` · ${m.engineer}` : ''}</div></li>
            ))}
          </ul>
          <div className="mt-3 text-[12.5px] font-medium text-muted">Scheduled visits</div>
          {d.scheduledVisits.length === 0 && <div className="text-[12.5px] text-subtle py-2">None scheduled</div>}
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {d.scheduledVisits.map((v) => (
              <li key={v.id} className="py-1.5 text-[12.5px]"><span className="font-mono">{v.number}</span> {v.title} <Badge color="slate" className="ml-1">{v.status}</Badge><div className="text-subtle text-[11.5px]">{v.scheduled_start ? fmtDateTime(v.scheduled_start) : 'to be scheduled'}{v.engineer ? ` · ${v.engineer}` : ''}{v.site ? ` · ${v.site}` : ''}</div></li>
            ))}
          </ul>
        </Card>
        <Card title="Latest reports" actions={<Link to="/reports?tab=history" className="text-[11.5px] text-brand-700 dark:text-brand-300 hover:underline">All reports</Link>}>
          {d.reports.length === 0 && <div className="text-[13px] text-subtle py-4 text-center">No reports published yet</div>}
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {d.reports.map((r) => (
              <li key={r.id} className="py-1.5 flex items-center justify-between gap-2 text-[12.5px]">
                <div className="min-w-0"><div className="font-medium truncate">{r.name}</div><div className="text-subtle text-[11.5px] truncate">{r.period ?? ''} · {relativeTime(r.created_at)} · {r.format.toUpperCase()}{r.size ? ` · ${fmtBytes(r.size)}` : ''}</div></div>
                {r.attachment_id && <Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />} onClick={() => download(`/attachments/${r.attachment_id}/download`, r.filename ?? `${r.name}.${r.format}`)}>Download</Button>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Recent tickets" actions={<Link to={ticketsHref} className="text-[11.5px] text-brand-700 dark:text-brand-300 hover:underline">All tickets</Link>}>
          <TicketMiniTable rows={d.recentTickets} columns={['priority', 'status', 'activity']} empty="No tickets yet" />
        </Card>
      </div>
      <div className="text-[11px] text-subtle">Average resolution time (30 days): {fmtDuration(d.sla.days30.totals.avgElapsedMinutes)} · updated {relativeTime(d.generatedAt)}</div>
    </div>
  );
}
