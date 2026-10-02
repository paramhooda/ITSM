import { Link, useNavigate } from 'react-router-dom';
import { Ticket, ShieldCheck, FileSignature, Boxes, Server, CalendarCheck } from 'lucide-react';
import { Card, StatTile, Badge, EmptyState } from '@/components/ui';
import { fmtDate, fmtDateTime, relativeTime, titleCase } from '@/lib/format';
import { ContractStatusBadge, ExpiryCountdown, MiniBars } from '@/components/contracts/ContractBits';
import { EntitlementBar } from '@/components/contracts/EntitlementBar';
import type { CustomerOverview } from './types';

/** The customer 360 view. */
export function OverviewPanel({ overview, customerId }: { overview: CustomerOverview; customerId: string }) {
  const navigate = useNavigate();
  const o = overview;
  const sla = o.sla30d;
  const slaTone = sla.compliancePct === null ? 'default' : sla.compliancePct >= 95 ? 'good' : sla.compliancePct >= 85 ? 'warn' : 'bad';
  const next = o.next.visit?.scheduledStart ?? o.next.pm?.plannedDate ?? null;
  const nextLabel = o.next.visit ? `Visit ${o.next.visit.number}` : o.next.pm ? o.next.pm.programName : null;
  const liveContracts = o.contracts.filter((c) => c.status !== 'renewed' && c.status !== 'terminated');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatTile label="Open tickets" value={o.counts.openTickets} hint={`${o.counts.totalTickets} total`} icon={<Ticket className="h-4 w-4" />} onClick={() => navigate(`/tickets?customerId=${customerId}`)} />
        <StatTile label="SLA compliance (30d)" value={sla.compliancePct === null ? '—' : `${sla.compliancePct}%`} hint={`${sla.met} met · ${sla.breached} breached`} tone={slaTone} icon={<ShieldCheck className="h-4 w-4" />} />
        <StatTile label="Active contracts" value={o.counts.activeContracts} hint={`${o.counts.contracts} total`} icon={<FileSignature className="h-4 w-4" />} onClick={() => navigate(`/contracts?customerId=${customerId}`)} />
        <StatTile label="Assets" value={o.counts.assets} icon={<Boxes className="h-4 w-4" />} onClick={() => navigate(`/assets?customerId=${customerId}`)} />
        <StatTile label="CIs" value={o.counts.cis} icon={<Server className="h-4 w-4" />} onClick={() => navigate(`/cmdb?customerId=${customerId}`)} />
        <StatTile label="Next PM / visit" value={next ? fmtDate(next) : '—'} hint={nextLabel ?? 'Nothing in the next 30 days'} icon={<CalendarCheck className="h-4 w-4" />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Open tickets by priority" actions={<Link to={`/tickets?customerId=${customerId}&open=true`} className="text-xs text-brand-600 hover:underline">View tickets</Link>}>
          <MiniBars rows={o.ticketsByPriority.map((p) => ({ label: p.label, count: p.count, color: p.color }))} />
          <div className="flex flex-wrap gap-1.5 mt-3">
            {Object.entries(o.ticketsByStatusCategory).map(([k, v]) => (
              <Badge key={k} color={k === 'new' ? 'blue' : k === 'open' ? 'amber' : k === 'pending' ? 'violet' : k === 'resolved' ? 'green' : 'slate'}>
                {titleCase(k)} {v}
              </Badge>
            ))}
          </div>
        </Card>

        <Card title="Contracts" actions={<Link to={`/contracts?customerId=${customerId}`} className="text-xs text-brand-600 hover:underline">All contracts</Link>} padded={false}>
          {liveContracts.length === 0 ? (
            <EmptyState title="No contracts" description="Create a contract to define coverage, scope and entitlements." />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {liveContracts.map((c) => (
                <li key={c.id} className="px-4 py-2 flex items-center gap-3 text-[13px]">
                  <Link to={`/contracts/${c.id}`} className="font-medium hover:underline shrink-0">
                    {c.number}
                  </Link>
                  <span className="truncate flex-1 text-muted">
                    {c.name}
                    {c.typeLabel && <span className="text-subtle"> · {c.typeLabel}</span>}
                  </span>
                  <ContractStatusBadge status={c.status} label={c.statusLabel} color={c.statusColor} />
                  <ExpiryCountdown days={c.daysToExpiry} endDate={c.endDate} status={c.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Entitlement utilisation">
          {o.entitlements.length === 0 ? (
            <div className="text-[13px] text-muted">No entitlements on active contracts.</div>
          ) : (
            <div className="space-y-3">
              {o.entitlements.map((e) => (
                <EntitlementBar key={e.id} entitlement={e} compact showContract />
              ))}
            </div>
          )}
        </Card>

        <Card title="Recent activity" padded={false}>
          {o.recentActivity.length === 0 ? (
            <div className="px-4 py-6 text-[13px] text-muted">No activity recorded yet.</div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {o.recentActivity.map((a) => (
                <li key={a.id} className="px-4 py-2 text-[12.5px] flex items-center gap-2">
                  <span className="text-subtle w-20 shrink-0" title={fmtDateTime(a.occurredAt)}>
                    {relativeTime(a.occurredAt)}
                  </span>
                  <span className="truncate flex-1">
                    <span className="font-medium">{a.userName ?? 'system'}</span> <span className="text-muted">{titleCase(a.action)}</span> <span className="text-subtle">{titleCase(a.entityType)}</span> {a.entityLabel && <span>{a.entityLabel}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Upcoming visits & maintenance (30 days)" padded={false}>
          {o.upcomingVisits.length === 0 && o.upcomingPm.length === 0 ? (
            <div className="px-4 py-6 text-[13px] text-muted">Nothing scheduled.</div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {o.upcomingVisits.map((v) => (
                <li key={v.id} className="px-4 py-2 text-[12.5px] flex items-center gap-2">
                  <Badge color="blue">Visit</Badge>
                  <Link to={`/field/${v.id}`} className="font-medium hover:underline">
                    {v.number}
                  </Link>
                  <span className="truncate flex-1 text-muted">
                    {v.title}
                    {v.siteName && <span className="text-subtle"> · {v.siteName}</span>}
                  </span>
                  <span className="text-subtle whitespace-nowrap">{v.scheduledStart ? fmtDateTime(v.scheduledStart) : titleCase(v.status)}</span>
                </li>
              ))}
              {o.upcomingPm.map((p) => (
                <li key={p.id} className="px-4 py-2 text-[12.5px] flex items-center gap-2">
                  <Badge color="teal">PM</Badge>
                  <span className="truncate flex-1">
                    {p.programName}
                    {p.siteName && <span className="text-subtle"> · {p.siteName}</span>}
                  </span>
                  <Badge color={p.status === 'scheduled' ? 'green' : 'slate'}>{titleCase(p.status)}</Badge>
                  <span className="text-subtle whitespace-nowrap">{fmtDate(p.scheduledDate ?? p.plannedDate)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Latest tickets" padded={false} actions={<Link to={`/tickets?customerId=${customerId}`} className="text-xs text-brand-600 hover:underline">All</Link>}>
          {o.recentTickets.length === 0 ? (
            <div className="px-4 py-6 text-[13px] text-muted">No tickets yet.</div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {o.recentTickets.map((t) => (
                <li key={t.id} className="px-4 py-2 text-[12.5px] flex items-center gap-2">
                  <Link to={`/tickets/${t.id}`} className="font-medium hover:underline shrink-0">
                    {t.number}
                  </Link>
                  <span className="truncate flex-1">{t.title}</span>
                  {t.priorityLabel && <Badge color={t.priorityColor ?? undefined}>{t.priorityLabel}</Badge>}
                  <Badge color={t.statusColor ?? undefined}>{t.statusLabel}</Badge>
                  <span className="text-subtle whitespace-nowrap">{relativeTime(t.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
