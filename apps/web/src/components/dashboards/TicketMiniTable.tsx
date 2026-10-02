import { Link } from 'react-router-dom';
import { AlertTriangle, PauseCircle } from 'lucide-react';
import { Badge } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { fmtDuration, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { TicketRow, SlaCompact } from './types';
import { TICKET_CATEGORY_COLORS } from '@/lib/statusColors';

export type TicketColumn = 'customer' | 'site' | 'priority' | 'severity' | 'status' | 'category' | 'ci' | 'sla' | 'assignee' | 'age' | 'resolved' | 'activity' | 'due' | 'visit';

export function SlaCell({ sla }: { sla?: SlaCompact | null }) {
  if (!sla) return <span className="text-subtle">—</span>;
  if (sla.paused) return <span className="inline-flex items-center gap-1 text-muted"><PauseCircle className="h-3.5 w-3.5" /> paused</span>;
  const breached = sla.breached || sla.remainingMinutes < 0;
  const warn = !breached && sla.pctConsumed >= 75;
  return (
    <span className={cn('inline-flex items-center gap-1 tabular-nums', breached ? 'text-red-600 font-medium' : warn ? 'text-amber-600' : 'text-muted')} title={`${sla.metric}: ${Math.round(sla.pctConsumed)}% consumed`}>
      {breached && <AlertTriangle className="h-3.5 w-3.5" />}
      {breached ? `${fmtDuration(Math.abs(sla.remainingMinutes))} over` : `${fmtDuration(sla.remainingMinutes)} left`}
    </span>
  );
}

/** Compact ticket list with links; customer users are routed to the portal ticket view. */
export function TicketMiniTable({ rows, columns = ['customer', 'priority', 'status', 'sla', 'assignee', 'age'], empty = 'No tickets', max }: { rows: TicketRow[]; columns?: TicketColumn[]; empty?: string; max?: number }) {
  const isCustomer = useAuthStore((s) => s.user?.userType === 'customer');
  const link = (id: string) => (isCustomer ? `/portal/tickets/${id}` : `/tickets/${id}`);
  const list = max ? rows.slice(0, max) : rows;
  if (!list.length) return <div className="text-[13px] text-subtle py-4 text-center">{empty}</div>;
  const has = (c: TicketColumn) => columns.includes(c);
  return (
    <div className="overflow-auto -mx-5 -mb-5">
      <table className="table [&_td]:py-2 [&_th]:py-2">
        <thead>
          <tr>
            <th>Ticket</th>
            {has('customer') && !isCustomer && <th>Customer</th>}
            {has('site') && <th>Site</th>}
            {has('priority') && <th>Priority</th>}
            {has('severity') && <th>Severity</th>}
            {has('category') && <th>Category</th>}
            {has('ci') && <th>CI</th>}
            {has('status') && <th>Status</th>}
            {has('sla') && <th>SLA</th>}
            {has('due') && <th>Due</th>}
            {has('assignee') && <th>Assignee</th>}
            {has('visit') && <th>Visit</th>}
            {has('age') && <th>Age</th>}
            {has('activity') && <th>Updated</th>}
            {has('resolved') && <th>Resolved</th>}
          </tr>
        </thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id}>
              <td className="max-w-[320px]">
                <Link to={link(t.id)} className="text-[12.5px] font-medium text-brand-700 hover:underline">{t.number}</Link>
                {t.is_major && <Badge color="red" className="ml-1.5">Major</Badge>}
                {t.escalation_level > 0 && <Badge color="orange" className="ml-1.5">Esc {t.escalation_level}</Badge>}
                <div className="truncate text-[13px] text-default" title={t.title}>{t.title}</div>
              </td>
              {has('customer') && !isCustomer && <td className="text-muted whitespace-nowrap max-w-[160px] truncate"><Link to={`/customers/${t.customer_id}`} className="hover:underline">{t.customer_name ?? '—'}</Link></td>}
              {has('site') && <td className="text-muted whitespace-nowrap max-w-[140px] truncate">{t.site_name ?? '—'}</td>}
              {has('priority') && <td>{t.priority ? <Badge color={t.priority_color ?? undefined}>{t.priority.split(' - ')[0]}</Badge> : '—'}</td>}
              {has('severity') && <td>{t.severity ? <Badge color={t.severity_color ?? undefined}>{t.severity}</Badge> : '—'}</td>}
              {has('category') && <td className="text-muted whitespace-nowrap">{t.category ?? '—'}</td>}
              {has('ci') && <td className="text-muted whitespace-nowrap max-w-[140px] truncate">{t.ci_id && !isCustomer ? <Link to={`/cmdb/${t.ci_id}`} className="hover:underline">{t.ci_name}</Link> : t.ci_name ?? '—'}</td>}
              {has('status') && <td>{t.status ? <Badge color={t.status_color ?? TICKET_CATEGORY_COLORS[t.status_category ?? ''] ?? undefined} dot>{t.status}</Badge> : '—'}</td>}
              {has('sla') && <td className="whitespace-nowrap"><SlaCell sla={t.sla} /></td>}
              {has('due') && <td className="whitespace-nowrap text-muted">{t.due_at ? relativeTime(t.due_at) : '—'}</td>}
              {has('assignee') && <td className="text-muted whitespace-nowrap">{t.assignee ?? <span className="text-amber-600">Unassigned</span>}</td>}
              {has('visit') && <td className="whitespace-nowrap">{t.visit_id ? <Link to={`/field/${t.visit_id}`} className="text-brand-700 hover:underline text-[12.5px]">{t.visit_number}</Link> : <span className="text-subtle">—</span>}</td>}
              {has('age') && <td className="text-muted whitespace-nowrap">{relativeTime(t.created_at)}</td>}
              {has('activity') && <td className="text-muted whitespace-nowrap">{relativeTime(t.last_activity_at)}</td>}
              {has('resolved') && <td className="text-muted whitespace-nowrap">{t.resolved_at ? `${relativeTime(t.resolved_at)}${t.mttr_minutes !== undefined && t.mttr_minutes !== null ? ` · ${fmtDuration(t.mttr_minutes)}` : ''}` : '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
