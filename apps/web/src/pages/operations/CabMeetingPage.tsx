import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Gavel, Plus, Trash2, Check, X, Clock, Lock, Search } from 'lucide-react';
import { Badge, Button, Dialog, Input, Textarea, LoadingBlock, ErrorBlock, EmptyState } from '@/components/ui';
import { RecordLayout, RecordHeader, RecordRibbon, RailCard, RailRows } from '@/components/record';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { APPROVAL_STATUS_COLORS, CHANGE_RISK_COLORS } from '@/lib/statusColors';
import { ticketsApi } from '@/components/tickets/api';
import { changesApi, changeKeys, type CabItem } from '@/components/changes/api';
import { CAB_STATUS_COLOR, CAB_STATUS_LABEL } from './CabMeetingsPage';

const DECISION_COLOR: Record<string, string> = { pending: 'slate', approved: 'green', rejected: 'red', deferred: 'amber' };
const DECISION_LABEL: Record<string, string> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', deferred: 'Deferred' };
const APPROVAL_LABEL: Record<string, string> = { pending: 'Approval pending', approved: 'Approved', rejected: 'Rejected', not_required: 'Pre-approved' };

/** One CAB meeting: the agenda of changes, a decision per item (which also decides the pending approval step), the minutes and closing. */
export default function CabMeetingPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: changeKeys.meeting(id), queryFn: () => changesApi.meeting(id), enabled: !!id });
  const m = q.data;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['cab'] }), qc.invalidateQueries({ queryKey: ['tickets'] })]);
  const fail = (e: Error) => toast.error(e.message);
  const [deciding, setDeciding] = useState<{ item: CabItem; decision: 'approved' | 'rejected' | 'deferred' } | null>(null);
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const [closing, setClosing] = useState(false);
  const [minutes, setMinutes] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (p: { itemId: string; decision: 'approved' | 'rejected' | 'deferred'; notes: string }) => changesApi.decideItem(id, p.itemId, { decision: p.decision, notes: p.notes || null }),
    onSuccess: (r) => {
      toast.success(r.approval.applied ? `Decision recorded · ${r.approval.note}` : r.approval.note ? `Decision recorded · ${r.approval.note}` : 'Decision recorded');
      setDeciding(null);
      setNotes('');
      void refresh();
    },
    onError: fail,
  });
  const remove = useMutation({ mutationFn: (itemId: string) => changesApi.removeItem(id, itemId), onSuccess: () => { toast.success('Removed from the agenda'); void refresh(); }, onError: fail });
  const close = useMutation({ mutationFn: () => changesApi.closeMeeting(id, minutes), onSuccess: () => { toast.success('Meeting closed'); setClosing(false); void refresh(); }, onError: fail });
  const saveMinutes = useMutation({ mutationFn: () => changesApi.updateMeeting(id, { minutes }), onSuccess: () => { toast.success('Minutes saved'); void refresh(); }, onError: fail });

  if (q.isLoading) return <LoadingBlock label="Opening the meeting…" />;
  if (q.isError || !m) return <ErrorBlock error={q.error ?? new Error('Meeting not found')} retry={() => q.refetch()} />;
  const open = m.status !== 'closed' && m.status !== 'cancelled';
  const canEdit = m.canDecide && open;
  const items = m.items;
  const counts = { approved: items.filter((i) => i.decision === 'approved').length, rejected: items.filter((i) => i.decision === 'rejected').length, deferred: items.filter((i) => i.decision === 'deferred').length, pending: items.filter((i) => i.decision === 'pending').length };

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'Operations', to: '/operations' }, { label: 'CAB', to: '/operations/cab' }, { label: m.title }]}
            title={m.title}
            badges={<Badge color={CAB_STATUS_COLOR[m.status] ?? 'slate'} dot>{CAB_STATUS_LABEL[m.status] ?? m.status}</Badge>}
            primary={canEdit ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add change</Button> : undefined}
            controls={canEdit ? <Button variant="outline" icon={<Lock className="h-4 w-4" />} onClick={() => { setMinutes(m.minutes ?? ''); setClosing(true); }}>Close meeting</Button> : undefined}
            createdAt={m.createdAt}
            updatedAt={m.updatedAt}
          >
            <RecordRibbon columns={5} items={[
              { label: 'When', value: fmtDateTime(m.scheduledAt), hint: relativeTime(m.scheduledAt) },
              { label: 'Chair', value: m.chairName ?? 'Not set' },
              { label: 'On the agenda', value: String(items.length) },
              { label: 'Awaiting a decision', value: String(counts.pending), tone: counts.pending ? 'warn' : 'good' },
              { label: 'Decided', value: `${counts.approved} approved · ${counts.rejected} rejected · ${counts.deferred} deferred` },
            ]} />
          </RecordHeader>
        }
        main={
          <div className="card overflow-x-auto">
            {items.length === 0 ? (
              <EmptyState icon={<Gavel className="h-5 w-5" />} title="Nothing on the agenda" description="Add the changes the board should decide on." action={canEdit ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add change</Button> : undefined} />
            ) : (
              <table className="table w-full table-fixed">
                <thead>
                  <tr>
                    <th className="w-[30%]">Change</th>
                    <th className="w-[17%]">Window</th>
                    <th className="w-[9%]">Risk</th>
                    <th className="w-[15%]">Approval</th>
                    <th className="w-[17%]">Decision</th>
                    {canEdit && <th className="w-[12%]"></th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} data-testid="cab-item">
                      <td className="min-w-0">
                        <Link to={`/tickets/${i.ticketId}?tab=plan`} className="font-mono text-[12.5px] font-medium text-brand-700 hover:underline">{i.number}</Link>
                        <Badge color="slate" className="ml-1.5">{i.changeType}</Badge>
                        <div className="truncate text-[13px]" title={i.title}>{i.title}</div>
                        <div className="text-[11.5px] text-muted truncate">{i.customerName ?? '—'}{i.assigneeName ? ` · ${i.assigneeName}` : ''}{i.status.label ? ` · ${i.status.label}` : ''}</div>
                      </td>
                      <td className="text-[12.5px] text-muted">{i.scheduledStart ? <>{fmtDateTime(i.scheduledStart)}{i.scheduledEnd ? ` – ${new Date(i.scheduledEnd).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}</> : 'not scheduled'}</td>
                      <td>{i.riskLevel ? <Badge color={CHANGE_RISK_COLORS[i.riskLevel]}>{i.riskLevel}{i.riskScore != null ? ` · ${i.riskScore}` : ''}</Badge> : i.riskLabel ? <Badge color="slate">{i.riskLabel}</Badge> : <span className="text-subtle">—</span>}</td>
                      <td>
                        {i.approvalStatus ? <Badge color={APPROVAL_STATUS_COLORS[i.approvalStatus] ?? 'slate'} dot>{APPROVAL_LABEL[i.approvalStatus] ?? i.approvalStatus}</Badge> : <span className="text-subtle text-[12px]">not requested</span>}
                        {i.pendingApproval && <div className="text-[11px] text-muted">step: {i.pendingApproval.stepName ?? i.pendingApproval.step}</div>}
                      </td>
                      <td>
                        <Badge color={DECISION_COLOR[i.decision]} dot>{DECISION_LABEL[i.decision]}</Badge>
                        {i.decidedAt && <div className="text-[11px] text-muted">{i.decidedByName ?? '—'} · {relativeTime(i.decidedAt)}</div>}
                        {i.notes && <div className="text-[11.5px] text-muted max-w-[260px] truncate" title={i.notes}>{i.notes}</div>}
                      </td>
                      {canEdit && (
                        <td className="whitespace-nowrap">
                          <div className="flex items-center gap-1 justify-end">
                            <Button size="sm" variant="ghost" className="px-2 text-emerald-700" icon={<Check className="h-3.5 w-3.5" />} title="Approve" aria-label="Approve" onClick={() => { setNotes(''); setDeciding({ item: i, decision: 'approved' }); }} />
                            <Button size="sm" variant="ghost" className="px-2 text-red-600" icon={<X className="h-3.5 w-3.5" />} title="Reject" aria-label="Reject" onClick={() => { setNotes(''); setDeciding({ item: i, decision: 'rejected' }); }} />
                            <Button size="sm" variant="ghost" className="px-2 text-amber-700" icon={<Clock className="h-3.5 w-3.5" />} title="Defer" aria-label="Defer" onClick={() => { setNotes(''); setDeciding({ item: i, decision: 'deferred' }); }} />
                            <Button size="sm" variant="ghost" className="px-2" icon={<Trash2 className="h-3.5 w-3.5" />} title="Remove from the agenda" aria-label="Remove" onClick={() => remove.mutate(i.id)} />
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        }
        aside={
          <>
            <RailCard title="Minutes">
              {open && m.canDecide ? (
                <div className="flex flex-col gap-2">
                  <Textarea rows={8} value={minutes ?? m.minutes ?? ''} onChange={(e) => setMinutes(e.target.value)} placeholder="Who attended, what was discussed, the decisions and their conditions…" />
                  <div className="flex justify-end"><Button size="sm" variant="outline" loading={saveMinutes.isPending} disabled={minutes === null || minutes === (m.minutes ?? '')} onClick={() => saveMinutes.mutate()}>Save minutes</Button></div>
                </div>
              ) : (
                <div className={cn('text-[13px] whitespace-pre-wrap', !m.minutes && 'text-subtle')}>{m.minutes || 'No minutes recorded.'}</div>
              )}
            </RailCard>
            <RailCard title="Meeting">
              <RailRows rows={[{ label: 'Scheduled', value: fmtDateTime(m.scheduledAt) }, { label: 'Chair', value: m.chairName ?? '—' }, { label: 'Closed', value: m.closedAt ? fmtDateTime(m.closedAt) : null, hidden: !m.closedAt }]} />
            </RailCard>
          </>
        }
        asideWidth={340}
      />
      <Dialog open={!!deciding} onClose={() => setDeciding(null)} title={deciding ? `${DECISION_LABEL[deciding.decision]}: ${deciding.item.number}` : ''} width="max-w-md" footer={<><Button variant="ghost" onClick={() => setDeciding(null)}>Cancel</Button><Button loading={decide.isPending} onClick={() => deciding && decide.mutate({ itemId: deciding.item.id, decision: deciding.decision, notes })}>Record decision</Button></>}>
        {deciding && (
          <div className="flex flex-col gap-3 text-[13px]">
            <p>{deciding.item.title}</p>
            {deciding.decision !== 'deferred' && deciding.item.pendingApproval && <p className="text-muted">The pending approval step "{deciding.item.pendingApproval.stepName ?? deciding.item.pendingApproval.step}" is decided with it.</p>}
            {deciding.decision !== 'deferred' && !deciding.item.pendingApproval && <p className="text-muted">No approval step is pending on this change; only the board's decision is recorded.</p>}
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Conditions, who asked for what, why…" />
          </div>
        )}
      </Dialog>
      <AddChangeDialog open={adding} onClose={() => setAdding(false)} onPick={async (ticketId) => { try { await changesApi.addItem(id, { ticketId }); toast.success('Added to the agenda'); setAdding(false); await refresh(); } catch (e) { fail(e as Error); } }} exclude={items.map((i) => i.ticketId)} />
      <Dialog open={closing} onClose={() => setClosing(false)} title="Close the meeting" width="max-w-lg" footer={<><Button variant="ghost" onClick={() => setClosing(false)}>Cancel</Button><Button loading={close.isPending} onClick={() => close.mutate()}>Close meeting</Button></>}>
        <div className="flex flex-col gap-3 text-[13px]">
          <p>Changes still pending are marked deferred. The minutes are kept with the meeting.</p>
          <Textarea rows={6} value={minutes ?? ''} onChange={(e) => setMinutes(e.target.value)} placeholder="Minutes…" />
        </div>
      </Dialog>
    </>
  );
}

/** Finds a change by number or title and adds it to the agenda. */
function AddChangeDialog({ open, onClose, onPick, exclude }: { open: boolean; onClose: () => void; onPick: (ticketId: string) => void; exclude: string[] }) {
  const [qText, setQText] = useState('');
  const search = useQuery({ queryKey: ['tickets', 'cab-search', qText], queryFn: () => ticketsApi.list({ type: 'change', q: qText || undefined, pageSize: 10, sort: 'createdAt', order: 'desc', statusCategory: 'new,open,pending' }), enabled: open, staleTime: 10_000 });
  const rows = (search.data?.items ?? []).filter((t) => !exclude.includes(t.id));
  return (
    <Dialog open={open} onClose={onClose} title="Add a change to the agenda" width="max-w-lg" footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-2">
        <div className="relative">
          <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-subtle" />
          <Input autoFocus value={qText} onChange={(e) => setQText(e.target.value)} placeholder="Change number or title…" className="pl-8" />
        </div>
        <div className="flex flex-col divide-y divide-[var(--border)] max-h-72 overflow-y-auto">
          {search.isLoading && <div className="text-[12.5px] text-subtle py-2">Searching…</div>}
          {!search.isLoading && rows.length === 0 && <div className="text-[12.5px] text-subtle py-2">No open change matches.</div>}
          {rows.map((t) => (
            <button key={t.id} type="button" className="text-left py-2 hover:bg-surface-2 px-1 rounded-md" onClick={() => onPick(t.id)}>
              <div className="text-[12.5px]"><span className="font-mono font-medium text-brand-700">{t.number}</span> <span>{t.title}</span></div>
              <div className="text-[11.5px] text-muted">{t.customerName ?? '—'} · {t.status.label}{t.approvalStatus ? ` · ${APPROVAL_LABEL[t.approvalStatus] ?? t.approvalStatus}` : ''}</div>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
