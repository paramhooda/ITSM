import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ClipboardCheck, Check, X } from 'lucide-react';
import { PageHeader, Badge, Button, Textarea, EmptyState, LoadingBlock, ErrorBlock } from '@/components/ui';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { portalApi, pk, type PortalApprovalItem } from '@/components/portal/api';

function ApprovalCard({ item }: { item: PortalApprovalItem }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [open, setOpen] = useState(false);
  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') => portalApi.decide(item.ticket.id, item.id, decision, comment),
    onSuccess: (_r, decision) => {
      toast.success(decision === 'approved' ? `${item.ticket.number} approved` : `${item.ticket.number} rejected`);
      qc.invalidateQueries({ queryKey: pk.approvals });
      qc.invalidateQueries({ queryKey: pk.me });
      qc.invalidateQueries({ queryKey: ['portal', 'tickets'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const t = item.ticket;
  return (
    <div className="card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
        <Link to={`/portal/tickets/${t.id}`} className="font-mono text-default hover:underline">{t.number}</Link>
        {t.catalogItemName && <Badge color="blue">{t.catalogItemName}</Badge>}
        {t.priority && <Badge color={t.priority.color ?? 'slate'}>{t.priority.label}</Badge>}
        <span className="ml-auto" title={fmtDateTime(item.createdAt)}>
          Requested {relativeTime(item.createdAt)}
        </span>
      </div>
      <div className="mt-1 font-medium text-[14px]">
        <Link to={`/portal/tickets/${t.id}`} className="hover:underline">{t.title}</Link>
      </div>
      <div className="text-[12.5px] text-muted mt-0.5">
        By {t.requesterName ?? 'a colleague'} · step: {item.stepName ?? `Step ${item.step}`}
      </div>
      {t.description && <div className="mt-2 text-[13px] whitespace-pre-wrap">{t.description}</div>}
      {t.form.length > 0 && (
        <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 rounded-md bg-surface-2/60 px-3 py-2">
          {t.form.map((f, i) => (
            <div key={i} className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wide text-subtle font-medium">{f.label}</dt>
              <dd className="text-[12.5px] break-words">{f.value === true ? 'Yes' : f.value === false ? 'No' : f.value === null || f.value === undefined || f.value === '' ? '—' : String(f.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-3 flex flex-col gap-2">
        {open ? <Textarea autoFocus value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment for the requester and the service desk (optional)" className="min-h-[60px] text-[12.5px]" /> : (
          <button className="text-[12px] text-brand-700 dark:text-brand-300 hover:underline self-start" onClick={() => setOpen(true)}>
            Add a comment
          </button>
        )}
        <div className="flex gap-2">
          <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} loading={decide.isPending} onClick={() => decide.mutate('approved')}>
            Approve
          </Button>
          <Button size="sm" variant="danger" icon={<X className="h-3.5 w-3.5" />} loading={decide.isPending} onClick={() => decide.mutate('rejected')}>
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function PortalApprovalsPage() {
  const list = useQuery({ queryKey: pk.approvals, queryFn: portalApi.approvals, refetchInterval: 60_000 });
  const items = list.data?.items ?? [];
  return (
    <div className="max-w-4xl">
      <PageHeader title="Approvals" subtitle="Requests from your organisation that need your decision before we start work." />
      {list.isLoading ? (
        <LoadingBlock />
      ) : list.isError ? (
        <ErrorBlock error={list.error} retry={() => list.refetch()} />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState icon={<ClipboardCheck className="h-5 w-5" />} title="Nothing to approve" description="You will see requests here when a colleague raises something that needs sign-off." />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((i) => (
            <ApprovalCard key={i.id} item={i} />
          ))}
        </div>
      )}
    </div>
  );
}
