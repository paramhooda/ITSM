import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { BellRing } from 'lucide-react';
import { Badge, Button, EmptyState } from '@/components/ui';
import { errorMessage } from '@/components/admin/api';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { useAuthStore } from '@/stores/auth';
import { oncallApi, oncallKeys, PAGE_STATUS_COLORS, PAGE_STATUS_LABELS, CHANNEL_LABELS, type Page } from './api';

const SOURCE: Record<Page['source'], string> = { rule: 'escalation rule', manual: 'manual', ai: 'Grady' };

/** The page log of one ticket (or the recent pages across tickets): one row per step, with acknowledge and call-off. */
export function PagesPanel({ ticketId, status, limit = 50, showTicket, canAct }: { ticketId?: string; status?: 'open' | null; limit?: number; showTicket?: boolean; canAct?: boolean }) {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const params = { ticketId, status: status ?? undefined, limit };
  const q = useQuery({ queryKey: oncallKeys.pages(params), queryFn: () => oncallApi.pages(params), refetchInterval: 30_000 });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: oncallKeys.all });
    if (ticketId) void qc.invalidateQueries({ queryKey: ['tickets', ticketId] });
  };
  const ack = useMutation({ mutationFn: (id: string) => oncallApi.ack(id), onSuccess: () => { refresh(); toast.success('Page acknowledged'); }, onError: (e) => toast.error(errorMessage(e)) });
  const cancel = useMutation({ mutationFn: (id: string) => oncallApi.cancel(id), onSuccess: () => { refresh(); toast.success('Page called off'); }, onError: (e) => toast.error(errorMessage(e)) });
  const items = q.data?.items ?? [];
  const mayCancel = canAct ?? can('tickets:escalate', 'oncall:manage');
  if (!q.isLoading && !items.length) return <EmptyState icon={<BellRing className="h-5 w-5" />} title="No pages" description={ticketId ? 'Nobody has been paged for this ticket. Use Page on-call… in the actions menu.' : 'No one has been paged in this period.'} />;
  return (
    <ul className="divide-y divide-[var(--border)]">
      {items.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
          <Badge color={PAGE_STATUS_COLORS[p.status]} dot>{PAGE_STATUS_LABELS[p.status]}</Badge>
          <span className="font-medium">
            {showTicket && p.ticket && <Link to={`/tickets/${p.ticket.id}`} className="font-mono text-brand-700 hover:underline mr-2">{p.ticket.number}</Link>}
            {p.targetName ?? (p.targetTeamName ? `every member of ${p.targetTeamName}` : 'nobody reachable')}
          </span>
          <span className="text-muted">step {p.step + 1}{p.steps ? ` of ${p.steps}` : ''}{p.cycle ? `, round ${p.cycle + 1}` : ''}{p.policyName ? ` · ${p.policyName}` : ''}</span>
          {p.channels.length > 0 && <span className="text-subtle text-[12px]">{p.channels.map((c) => CHANNEL_LABELS[c]).join(', ')}</span>}
          <span className="flex-1 min-w-[120px] truncate text-muted" title={p.reason ?? undefined}>{p.reason}</span>
          <span className="text-subtle text-[12px]" title={fmtDateTime(p.createdAt)}>
            {p.status === 'pending' && p.expiresAt ? `escalates ${relativeTime(p.expiresAt)}` : p.status === 'acked' && p.ackedAt ? `by ${p.ackedByName ?? 'someone'} ${relativeTime(p.ackedAt)}` : relativeTime(p.createdAt)} · {SOURCE[p.source]}{p.createdByName ? ` by ${p.createdByName}` : ''}
          </span>
          {p.status === 'pending' && (
            <span className="inline-flex gap-1">
              <Button size="sm" onClick={() => ack.mutate(p.id)} loading={ack.isPending}>Acknowledge</Button>
              {mayCancel && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(p.id)} loading={cancel.isPending}>Call off</Button>}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
