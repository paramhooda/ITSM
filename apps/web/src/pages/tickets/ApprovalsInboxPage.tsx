import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, ClipboardCheck, X } from 'lucide-react';
import { PageHeader, Card, Button, Textarea, Badge, DataTable, EmptyState, ErrorBlock, type Column } from '@/components/ui';
import { TypeBadge } from '@/components/tickets/TicketStatusBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { relativeTime } from '@/lib/format';
import { ticketsApi, qk as tk } from '@/components/tickets/api';
import type { MyApproval } from '@/components/tickets/types';

function approverLabel(a: MyApproval) {
  if (a.approverUser) return a.approverUser.name;
  if (a.approverTeam) return `Team ${a.approverTeam.name}`;
  if (a.approverRole) return a.approverRole.name;
  if (a.approverRoleKey) return a.approverRoleKey.replace(/_/g, ' ');
  return 'You';
}

/**
 * My approvals: every pending step addressed to the signed-in person (directly, through a
 * role for the customer, or through a team), decided here without opening each ticket.
 */
export default function ApprovalsInboxPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: tk.mine, queryFn: ticketsApi.myApprovals, refetchInterval: 60_000 });
  const [deciding, setDeciding] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (v: { ticketId: string; id: string; decision: 'approved' | 'rejected' }) => ticketsApi.decide(v.ticketId, v.id, { decision: v.decision, comment: comment || null }),
    onSuccess: (_r, v) => {
      toast.success(v.decision === 'approved' ? 'Approved' : 'Rejected');
      setComment('');
      setDeciding(null);
      void qc.invalidateQueries({ queryKey: tk.mine });
      void qc.invalidateQueries({ queryKey: ['tickets', v.ticketId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const items = q.data?.items ?? [];

  const columns: Column<MyApproval>[] = [
    { key: 'ticket', header: 'Ticket', width: '150px', render: (a) => <Link to={`/tickets/${a.ticket.id}`} className="font-mono text-[12.5px] text-brand-700 hover:underline" onClick={(e) => e.stopPropagation()}>{a.ticket.number}</Link> },
    { key: 'title', header: 'Summary', render: (a) => (
      <div className="min-w-0">
        <div className="font-medium truncate max-w-[440px]">{a.ticket.title}</div>
        <div className="text-[11.5px] text-muted flex items-center gap-1.5"><TypeBadge type={a.ticket.type} short className="px-1 py-0 text-[10px]" />{a.ticket.customerName && <span>{a.ticket.customerName}</span>}{a.ticket.requesterName && <span>· raised by {a.ticket.requesterName}</span>}</div>
      </div>
    ) },
    { key: 'priority', header: 'Priority', width: '110px', render: (a) => <PriorityBadge priority={a.ticket.priority} compact /> },
    { key: 'step', header: 'Step', width: '200px', render: (a) => <div className="min-w-0"><div className="text-[12.5px]">{a.stepName ?? `Step ${a.step}`}</div><div className="text-[11.5px] text-muted truncate">for {approverLabel(a)}</div></div> },
    { key: 'since', header: 'Waiting', width: '110px', render: (a) => <span className="text-muted tnum">{relativeTime(a.createdAt)}</span> },
    { key: 'actions', header: '', width: '150px', render: (a) => (
      deciding === a.id ? null : (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} onClick={() => { setDeciding(a.id); setComment(''); }}>Decide</Button>
        </div>
      )
    ) },
  ];
  const current = items.find((a) => a.id === deciding);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="My approvals" subtitle="Requests and changes waiting for your decision" actions={<Badge color={items.length ? 'amber' : 'slate'}>{items.length} pending</Badge>} />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
      {current && (
        <Card className="border-amber-200/80">
          <div className="flex flex-col gap-2">
            <div className="text-[13px]"><span className="font-medium">{current.ticket.number}</span> · {current.ticket.title} · <span className="text-muted">{current.stepName ?? `Step ${current.step}`}</span></div>
            <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (optional for approval, recommended for rejection)" className="min-h-[56px]" />
            <div className="flex items-center gap-2">
              <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} loading={decide.isPending} onClick={() => decide.mutate({ ticketId: current.ticket.id, id: current.id, decision: 'approved' })}>Approve</Button>
              <Button size="sm" variant="danger" icon={<X className="h-3.5 w-3.5" />} loading={decide.isPending} onClick={() => decide.mutate({ ticketId: current.ticket.id, id: current.id, decision: 'rejected' })}>Reject</Button>
              <Button size="sm" variant="ghost" onClick={() => setDeciding(null)}>Cancel</Button>
            </div>
          </div>
        </Card>
      )}
      <div className="card overflow-hidden">
        <DataTable columns={columns} rows={items} loading={q.isLoading} dense empty={<EmptyState icon={<ClipboardCheck className="h-5 w-5" />} title="Nothing waiting for you" description="Approval steps addressed to you, your role or your team appear here." />} />
      </div>
    </div>
  );
}
