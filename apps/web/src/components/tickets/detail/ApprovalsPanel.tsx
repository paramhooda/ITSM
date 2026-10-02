import { useState } from 'react';
import { Panel } from '../Panel';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ClipboardCheck, Check, X, Clock, RotateCcw } from 'lucide-react';
import { Button, Textarea, Badge } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { ticketsApi } from '../api';
import type { Approval, TicketDetail } from '../types';
import { APPROVAL_STATUS_COLORS } from '@/lib/statusColors';

const STATUS_COLORS = APPROVAL_STATUS_COLORS;

function approverLabel(a: Approval) {
  if (a.approverUser) return a.approverUser.name;
  if (a.approverTeam) return `Team ${a.approverTeam.name}`;
  if (a.approverRole) return a.approverRole.name;
  if (a.approverRoleKey) return a.approverRoleKey.replace(/_/g, ' ');
  return 'Approver';
}

/** Approval steps with decide actions for addressees / approvers. */
export function ApprovalsPanel({ ticket, approvals, canApprove, canRequest }: { ticket: TicketDetail; approvals: Approval[]; canApprove: boolean; canRequest: boolean }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [deciding, setDeciding] = useState<string | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['tickets', ticket.id] });
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: 'approved' | 'rejected' }) => ticketsApi.decide(ticket.id, input.id, { decision: input.decision, comment: comment || null }),
    onSuccess: (_r, v) => {
      toast.success(v.decision === 'approved' ? 'Approved' : 'Rejected');
      setComment('');
      setDeciding(null);
      invalidate();
      qc.invalidateQueries({ queryKey: ['approvals'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const request = useMutation({
    mutationFn: () => ticketsApi.requestApproval(ticket.id),
    onSuccess: () => {
      toast.success('Approval requested');
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const latestBatch = approvals.filter((a) => a.status !== 'superseded');
  const pending = latestBatch.filter((a) => a.status === 'pending');
  if (!latestBatch.length && !canRequest) return null;
  const canRequestNow = canRequest && (ticket.type === 'change' || ticket.type === 'request') && pending.length === 0 && !['closed', 'cancelled', 'resolved'].includes(ticket.status?.category ?? '');

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-subtle" /> Approvals
          {ticket.approvalStatus && <Badge color={STATUS_COLORS[ticket.approvalStatus] ?? 'slate'}>{ticket.approvalStatus}</Badge>}
        </span>
      }
      actions={canRequestNow ? <Button size="sm" variant="outline" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => request.mutate()} loading={request.isPending}>{ticket.approvalStatus ? 'Re-request approval' : 'Request approval'}</Button> : undefined}
      padded={false}
    >
      {latestBatch.length === 0 ? (
        <div className="px-4 py-3 text-[12.5px] text-muted">No approval requested yet.</div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {latestBatch.map((a) => {
            const mine = a.canDecide || (canApprove && a.status === 'pending');
            return (
              <li key={a.id} className="px-4 py-2.5">
                <div className="flex items-center gap-3">
                  <span className="h-6 w-6 rounded-full bg-surface-2 text-[11px] font-semibold flex items-center justify-center shrink-0">{a.step}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium truncate">{a.stepName ?? `Step ${a.step}`}</div>
                    <div className="text-[11.5px] text-muted truncate">
                      {approverLabel(a)}
                      {a.decidedByUser && a.status !== 'pending' ? ` · ${a.status} by ${a.decidedByUser.name} ${a.decidedAt ? fmtDateTime(a.decidedAt) : ''}` : ''}
                      {a.comment ? ` — "${a.comment}"` : ''}
                    </div>
                  </div>
                  <Badge color={STATUS_COLORS[a.status] ?? 'slate'} className="capitalize">
                    {a.status === 'pending' ? <Clock className="h-3 w-3" /> : null}
                    {a.status}
                  </Badge>
                  {a.status === 'pending' && mine && deciding !== a.id && (
                    <Button size="sm" variant="outline" onClick={() => setDeciding(a.id)}>
                      Decide
                    </Button>
                  )}
                </div>
                {deciding === a.id && (
                  <div className="mt-2 ml-9 flex flex-col gap-2">
                    <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (optional for approval, recommended for rejection)" className="min-h-[56px]" />
                    <div className="flex items-center gap-2">
                      <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} onClick={() => decide.mutate({ id: a.id, decision: 'approved' })} loading={decide.isPending}>
                        Approve
                      </Button>
                      <Button size="sm" variant="danger" icon={<X className="h-3.5 w-3.5" />} onClick={() => decide.mutate({ id: a.id, decision: 'rejected' })} loading={decide.isPending}>
                        Reject
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeciding(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
