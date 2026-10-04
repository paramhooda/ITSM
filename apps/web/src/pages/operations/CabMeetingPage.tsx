import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Gavel, Plus, Trash2, Check, X, Clock, Lock, Search, Pencil, ArrowUp, ArrowDown, MapPin, Ban, Users } from 'lucide-react';
import { Badge, Button, Dialog, Input, Textarea, LoadingBlock, ErrorBlock, EmptyState, Avatar } from '@/components/ui';
import { RecordLayout, RecordHeader, RecordRibbon, RailCard, RailRows } from '@/components/record';
import { FormDialog, type FieldSpec } from '@/components/admin/FormDialog';
import { useEngineers } from '@/hooks/useLookups';
import { useUiStore } from '@/stores/ui';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { APPROVAL_STATUS_COLORS, CHANGE_RISK_COLORS, CAB_STATUS_COLORS, CAB_DECISION_COLORS } from '@/lib/statusColors';
import { ticketsApi } from '@/components/tickets/api';
import { changesApi, changeKeys, type CabItem } from '@/components/changes/api';
import { QueueRow } from '@/components/changes/CabQueueDrawer';
import { CAB_STATUS_LABEL } from './CabMeetingsPage';

const DECISION_LABEL: Record<string, string> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', deferred: 'Deferred' };
const APPROVAL_LABEL: Record<string, string> = { pending: 'Approval pending', approved: 'Approved', rejected: 'Rejected', not_required: 'Pre-approved' };
type Values = Record<string, unknown>;
const pad = (n: number) => String(n).padStart(2, '0');
/** ISO → the value a datetime-local input takes (local time). */
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * One CAB meeting: the agenda in the board's order, a decision per item (which also decides the
 * pending approval step), notes for the board, the minutes (typed, or generated on close), and the
 * meeting's own details (edit, cancel).
 */
export default function CabMeetingPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const engineers = useEngineers();
  const q = useQuery({ queryKey: changeKeys.meeting(id), queryFn: () => changesApi.meeting(id), enabled: !!id });
  const m = q.data;
  useEffect(() => {
    if (m) setAssistantContext({ label: m.title, entityType: 'cab_meeting', entityId: m.id });
    return () => setAssistantContext(null);
  }, [m?.id, m?.title, setAssistantContext, m]);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['cab'] }), qc.invalidateQueries({ queryKey: ['tickets'] }), qc.invalidateQueries({ queryKey: ['changes'] })]);
  const fail = (e: Error) => toast.error(e.message);
  const [deciding, setDeciding] = useState<{ item: CabItem; decision: 'approved' | 'rejected' | 'deferred' } | null>(null);
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [editingNotes, setEditingNotes] = useState<CabItem | null>(null);
  const [itemNotes, setItemNotes] = useState('');
  const [minutes, setMinutes] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (p: { itemId: string; decision: 'approved' | 'rejected' | 'deferred'; notes: string }) => changesApi.decideItem(id, p.itemId, { decision: p.decision, notes: p.notes || null }),
    onSuccess: (r) => {
      toast.success(r.approval.note ? `Decision recorded · ${r.approval.note}` : 'Decision recorded');
      setDeciding(null);
      setNotes('');
      void refresh();
    },
    onError: fail,
  });
  const remove = useMutation({ mutationFn: (itemId: string) => changesApi.removeItem(id, itemId), onSuccess: () => { toast.success('Removed from the agenda'); void refresh(); }, onError: fail });
  const close = useMutation({ mutationFn: () => changesApi.closeMeeting(id, minutes?.trim() ? minutes : null), onSuccess: (r) => { toast.success(r.minutes && !minutes?.trim() ? 'Meeting closed · minutes generated' : 'Meeting closed'); setClosing(false); setMinutes(null); void refresh(); }, onError: fail });
  const saveMinutes = useMutation({ mutationFn: () => changesApi.updateMeeting(id, { minutes }), onSuccess: () => { toast.success('Minutes saved'); void refresh(); }, onError: fail });
  const reorder = useMutation({ mutationFn: (itemIds: string[]) => changesApi.reorderItems(id, itemIds), onSuccess: () => void refresh(), onError: fail });
  const saveItemNotes = useMutation({ mutationFn: () => changesApi.updateItem(id, editingNotes!.id, { notes: itemNotes.trim() || null }), onSuccess: () => { toast.success('Notes saved'); setEditingNotes(null); void refresh(); }, onError: fail });
  const update = useMutation({
    mutationFn: (v: Values) => changesApi.updateMeeting(id, { title: String(v.title), scheduledAt: new Date(String(v.scheduledAt)).toISOString(), chairUserId: (v.chairUserId as string) || null, location: ((v.location as string) || '').trim() || null, attendeeUserIds: (v.attendeeUserIds as string[]) ?? [] }),
    onSuccess: () => { toast.success('Meeting updated'); setEditing(false); void refresh(); },
    onError: fail,
  });
  const cancel = useMutation({ mutationFn: () => changesApi.cancelMeeting(id, { reason: cancelReason.trim() || null }), onSuccess: () => { toast.success('Meeting cancelled'); setCancelling(false); void refresh(); }, onError: fail });

  if (q.isLoading) return <LoadingBlock label="Opening the meeting…" />;
  if (q.isError || !m) return <ErrorBlock error={q.error ?? new Error('Meeting not found')} retry={() => q.refetch()} />;
  const open = m.status !== 'closed' && m.status !== 'cancelled';
  const canEdit = m.canDecide && open;
  const items = m.items;
  const counts = { approved: items.filter((i) => i.decision === 'approved').length, rejected: items.filter((i) => i.decision === 'rejected').length, deferred: items.filter((i) => i.decision === 'deferred').length, pending: items.filter((i) => i.decision === 'pending').length };
  const move = (i: CabItem, dir: -1 | 1) => {
    const ids = items.map((x) => x.id);
    const at = ids.indexOf(i.id);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to]!, ids[at]!];
    reorder.mutate(ids);
  };
  const engineerOpts = (engineers.data ?? []).map((e) => ({ value: e.id, label: e.name }));
  const editFields: FieldSpec<Values>[] = [
    { key: 'title', label: 'Title', type: 'text', required: true, span: 2 },
    { key: 'scheduledAt', label: 'When', type: 'datetime', required: true },
    { key: 'chairUserId', label: 'Chair', type: 'select', options: engineerOpts },
    { key: 'location', label: 'Location or bridge', type: 'text', span: 2, placeholder: 'Room 4, or the bridge link' },
    { key: 'attendeeUserIds', label: 'Attendees', type: 'multiselect', options: engineerOpts, hint: 'Listed in the generated minutes' },
  ];

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'Changes', to: '/operations/change-calendar' }, { label: 'CAB', to: '/operations/cab' }, { label: m.title }]}
            title={m.title}
            badges={<Badge color={CAB_STATUS_COLORS[m.status] ?? 'slate'} dot data-testid="cab-status">{CAB_STATUS_LABEL[m.status] ?? m.status}</Badge>}
            primary={canEdit ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add change</Button> : undefined}
            controls={canEdit ? <Button variant="outline" icon={<Lock className="h-4 w-4" />} onClick={() => { setMinutes(m.minutes ?? ''); setClosing(true); }}>Close meeting</Button> : undefined}
            menu={canEdit ? [
              { label: 'Edit meeting…', icon: <Pencil className="h-4 w-4" />, onClick: () => setEditing(true) },
              { label: 'Cancel meeting…', icon: <Ban className="h-4 w-4" />, danger: true, onClick: () => { setCancelReason(''); setCancelling(true); } },
            ] : undefined}
            createdAt={m.createdAt}
            updatedAt={m.updatedAt}
          >
            <RecordRibbon columns={5} items={[
              { label: 'When', value: fmtDateTime(m.scheduledAt), hint: relativeTime(m.scheduledAt) },
              { label: 'Chair', value: m.chairName ?? 'Not set' },
              { label: 'On the agenda', value: String(items.length) },
              { label: 'Awaiting a decision', value: String(counts.pending), tone: counts.pending ? 'warn' : 'good' },
              { label: 'Approved · rejected · deferred', value: `${counts.approved} · ${counts.rejected} · ${counts.deferred}`, hint: `${counts.approved + counts.rejected + counts.deferred} decided` },
            ]} />
          </RecordHeader>
        }
        main={
          <div className="card overflow-x-auto">
            {items.length === 0 ? (
              <EmptyState icon={<Gavel className="h-5 w-5" />} title="Nothing on the agenda" description="Add the changes the board should decide on." action={canEdit ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add change</Button> : undefined} />
            ) : (
              <table className="table w-full table-fixed min-w-[760px]">
                <thead>
                  <tr>
                    <th className="w-[29%]">Change</th>
                    <th className="w-[16%]">Window</th>
                    <th className="w-[11%]">Risk</th>
                    <th className="w-[15%]">Approval</th>
                    <th className="w-[17%]">Decision</th>
                    {canEdit && <th className="w-[12%]"></th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map((i, idx) => (
                    <tr key={i.id} data-testid="cab-item" data-number={i.number}>
                      <td className="min-w-0">
                        <span className="text-[11px] text-subtle tabular-nums mr-1.5">{idx + 1}.</span>
                        <Link to={`/tickets/${i.ticketId}?tab=plan`} className="font-mono text-[12.5px] font-medium text-brand-700 hover:underline">{i.number}</Link>
                        <Badge color="slate" className="ml-1.5 capitalize">{i.changeType}</Badge>
                        <div className="truncate text-[13px]" title={i.title}>{i.title}</div>
                        <div className="text-[11.5px] text-muted truncate">{i.customerName ?? '—'}{i.assigneeName ? ` · ${i.assigneeName}` : ''}{i.status.label ? ` · ${i.status.label}` : ''}</div>
                        {i.notes && <div className="text-[11.5px] text-default/80 mt-0.5 whitespace-pre-wrap" data-testid="cab-item-notes" title="Notes for the board">{i.notes}</div>}
                      </td>
                      <td className="text-[12.5px] text-muted">{i.scheduledStart ? <>{fmtDateTime(i.scheduledStart)}{i.scheduledEnd ? ` – ${new Date(i.scheduledEnd).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}</> : 'not scheduled'}</td>
                      <td>{i.riskLevel ? <Badge color={CHANGE_RISK_COLORS[i.riskLevel]}>{i.riskLevel}{i.riskScore != null ? ` · ${i.riskScore}` : ''}</Badge> : i.riskLabel ? <Badge color="slate">{i.riskLabel}</Badge> : <span className="text-subtle">—</span>}</td>
                      <td>
                        {i.approvalStatus ? <Badge color={APPROVAL_STATUS_COLORS[i.approvalStatus] ?? 'slate'} dot>{APPROVAL_LABEL[i.approvalStatus] ?? i.approvalStatus}</Badge> : <span className="text-subtle text-[12px]">not requested</span>}
                        {i.pendingApproval && <div className="text-[11px] text-muted">step: {i.pendingApproval.stepName ?? i.pendingApproval.step}</div>}
                      </td>
                      <td>
                        <Badge color={CAB_DECISION_COLORS[i.decision] ?? 'slate'} dot>{DECISION_LABEL[i.decision]}</Badge>
                        {i.decidedAt && <div className="text-[11px] text-muted">{i.decidedByName ?? '—'} · {relativeTime(i.decidedAt)}</div>}
                      </td>
                      {canEdit && (
                        <td className="whitespace-nowrap">
                          {/* Two rows: the decision first, then the housekeeping (order, notes, remove). */}
                          <div className="flex flex-col items-end gap-0.5">
                            <div className="flex items-center gap-0.5">
                              <Button size="sm" variant="ghost" className="px-1.5 text-emerald-700" icon={<Check className="h-3.5 w-3.5" />} title="Approve" aria-label="Approve" onClick={() => { setNotes(''); setDeciding({ item: i, decision: 'approved' }); }} />
                              <Button size="sm" variant="ghost" className="px-1.5 text-red-600" icon={<X className="h-3.5 w-3.5" />} title="Reject" aria-label="Reject" onClick={() => { setNotes(''); setDeciding({ item: i, decision: 'rejected' }); }} />
                              <Button size="sm" variant="ghost" className="px-1.5 text-amber-700" icon={<Clock className="h-3.5 w-3.5" />} title="Defer" aria-label="Defer" onClick={() => { setNotes(''); setDeciding({ item: i, decision: 'deferred' }); }} />
                            </div>
                            <div className="flex items-center gap-0.5">
                              <Button size="sm" variant="ghost" className="px-1.5" icon={<ArrowUp className="h-3.5 w-3.5" />} title="Move up" aria-label="Move up" disabled={idx === 0 || reorder.isPending} onClick={() => move(i, -1)} />
                              <Button size="sm" variant="ghost" className="px-1.5" icon={<ArrowDown className="h-3.5 w-3.5" />} title="Move down" aria-label="Move down" disabled={idx === items.length - 1 || reorder.isPending} onClick={() => move(i, 1)} />
                              <Button size="sm" variant="ghost" className="px-1.5" icon={<Pencil className="h-3.5 w-3.5" />} title="Edit notes for the board" aria-label="Edit notes" onClick={() => { setItemNotes(i.notes ?? ''); setEditingNotes(i); }} />
                              <Button size="sm" variant="ghost" className="px-1.5" icon={<Trash2 className="h-3.5 w-3.5" />} title="Remove from the agenda" aria-label="Remove" onClick={() => remove.mutate(i.id)} />
                            </div>
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
                  <Textarea rows={8} value={minutes ?? m.minutes ?? ''} onChange={(e) => setMinutes(e.target.value)} placeholder="Who attended, what was discussed, the decisions and their conditions… Leave empty and the minutes are generated when the meeting is closed." />
                  <div className="flex justify-end"><Button size="sm" variant="outline" loading={saveMinutes.isPending} disabled={minutes === null || minutes === (m.minutes ?? '')} onClick={() => saveMinutes.mutate()}>Save minutes</Button></div>
                </div>
              ) : (
                <div className={cn('text-[13px] whitespace-pre-wrap', !m.minutes && 'text-subtle')} data-testid="cab-minutes">{m.minutes || 'No minutes recorded.'}</div>
              )}
            </RailCard>
            <RailCard title="Meeting">
              <RailRows rows={[
                { label: 'Scheduled', value: fmtDateTime(m.scheduledAt) },
                { label: 'Chair', value: m.chairName ?? '—' },
                { label: 'Location', value: m.location ? <span className="inline-flex items-center gap-1 min-w-0"><MapPin className="h-3 w-3 text-subtle shrink-0" /><span className="truncate" data-testid="cab-location">{m.location}</span></span> : <span className="text-subtle">Not set</span> },
                { label: m.status === 'cancelled' ? 'Cancelled' : 'Closed', value: m.closedAt ? fmtDateTime(m.closedAt) : null, hidden: !m.closedAt },
              ]} />
              <div className="mt-3">
                <div className="text-[11.5px] font-semibold uppercase tracking-wide text-subtle mb-1.5 inline-flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> Attendees</div>
                {m.attendees.length === 0 ? (
                  <div className="text-[12.5px] text-subtle">Nobody listed yet.</div>
                ) : (
                  <ul className="flex flex-col gap-1.5" data-testid="cab-attendees">
                    {m.attendees.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 text-[12.5px]"><Avatar name={a.name} size="xs" /> <span className="truncate">{a.name}</span></li>
                    ))}
                  </ul>
                )}
              </div>
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
            {deciding.decision === 'approved' && !deciding.item.pendingApproval && <p className="text-muted">No approval step is pending on this change; only the board's decision is recorded.</p>}
            {deciding.decision === 'rejected' && !deciding.item.pendingApproval && <p className="text-muted">No approval step is pending on this change; the change moves to Rejected and the requester is told.</p>}
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Conditions, who asked for what, why…" />
          </div>
        )}
      </Dialog>
      <AddChangeDialog
        open={adding}
        onClose={() => setAdding(false)}
        onPick={async (ticketId, picked) => {
          try {
            await changesApi.addItem(id, { ticketId, notes: picked.trim() || null });
            toast.success('Added to the agenda');
            setAdding(false);
            await refresh();
          } catch (e) {
            fail(e as Error);
          }
        }}
        exclude={items.map((i) => i.ticketId)}
      />
      <Dialog open={closing} onClose={() => setClosing(false)} title="Close the meeting" width="max-w-lg" footer={<><Button variant="ghost" onClick={() => setClosing(false)}>Cancel</Button><Button loading={close.isPending} onClick={() => close.mutate()}>Close meeting</Button></>}>
        <div className="flex flex-col gap-3 text-[13px]">
          <p>Changes still pending are marked deferred. Leave the minutes empty and they are generated from the attendees and the decisions taken.</p>
          <Textarea rows={6} value={minutes ?? ''} onChange={(e) => setMinutes(e.target.value)} placeholder="Minutes… (empty = generated)" />
        </div>
      </Dialog>
      <Dialog open={!!editingNotes} onClose={() => setEditingNotes(null)} title={editingNotes ? `Notes for the board: ${editingNotes.number}` : ''} width="max-w-md" footer={<><Button variant="ghost" onClick={() => setEditingNotes(null)}>Cancel</Button><Button loading={saveItemNotes.isPending} onClick={() => saveItemNotes.mutate()}>Save notes</Button></>}>
        <Textarea rows={4} value={itemNotes} onChange={(e) => setItemNotes(e.target.value)} placeholder="What the board should know before deciding…" />
      </Dialog>
      <Dialog open={cancelling} onClose={() => setCancelling(false)} title="Cancel the meeting" width="max-w-md" footer={<><Button variant="ghost" onClick={() => setCancelling(false)}>Keep it</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel meeting</Button></>}>
        <div className="flex flex-col gap-3 text-[13px]">
          <p>The changes on the agenda are released (their CAB slot is cleared and a note is written on each) so they can be tabled at another meeting.</p>
          <Textarea rows={3} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Reason (kept with the meeting)…" />
        </div>
      </Dialog>
      <FormDialog<Values>
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit meeting"
        fields={editFields}
        initial={{ title: m.title, scheduledAt: toLocalInput(m.scheduledAt), chairUserId: m.chairUserId ?? '', location: m.location ?? '', attendeeUserIds: m.attendeeUserIds }}
        onSubmit={(v) => update.mutateAsync(v).then(() => undefined)}
        submitLabel="Save"
      />
    </>
  );
}

/** The queue (changes awaiting the board) when nothing is typed, else a search over open changes; a note for the board travels with the pick. */
function AddChangeDialog({ open, onClose, onPick, exclude }: { open: boolean; onClose: () => void; onPick: (ticketId: string, notes: string) => void; exclude: string[] }) {
  const [qText, setQText] = useState('');
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (open) {
      setQText('');
      setNotes('');
    }
  }, [open]);
  const queue = useQuery({ queryKey: changeKeys.queue({ limit: 20 }), queryFn: () => changesApi.queue({ limit: 20 }), enabled: open && !qText, staleTime: 10_000 });
  const search = useQuery({ queryKey: ['tickets', 'cab-search', qText], queryFn: () => ticketsApi.list({ type: 'change', q: qText || undefined, pageSize: 10, sort: 'createdAt', order: 'desc', statusCategory: 'new,open,pending' }), enabled: open && !!qText, staleTime: 10_000 });
  const queued = (queue.data?.items ?? []).filter((t) => !exclude.includes(t.ticketId));
  const rows = (search.data?.items ?? []).filter((t) => !exclude.includes(t.id));
  const pick = (ticketId: string) => onPick(ticketId, notes);
  return (
    <Dialog open={open} onClose={onClose} title="Add a change to the agenda" width="max-w-lg" footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-subtle" />
          <Input autoFocus value={qText} onChange={(e) => setQText(e.target.value)} placeholder="Change number or title… (empty: the changes awaiting the board)" className="pl-8" />
        </div>
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes for the board (sent with the change you pick)…" data-testid="cab-add-notes" />
        <div className="flex flex-col divide-y divide-[var(--border)] max-h-72 overflow-y-auto">
          {!qText && (
            <>
              <div className="text-[11.5px] font-semibold uppercase tracking-wide text-subtle py-1">Awaiting the board</div>
              {queue.isLoading && <div className="text-[12.5px] text-subtle py-2">Looking…</div>}
              {!queue.isLoading && queued.length === 0 && <div className="text-[12.5px] text-subtle py-2">Nothing is waiting for the board; search for a change by number or title.</div>}
              {queued.map((t) => <QueueRow key={t.ticketId} r={t} action={<Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => pick(t.ticketId)}>Add</Button>} />)}
            </>
          )}
          {qText && search.isLoading && <div className="text-[12.5px] text-subtle py-2">Searching…</div>}
          {qText && !search.isLoading && rows.length === 0 && <div className="text-[12.5px] text-subtle py-2">No open change matches.</div>}
          {qText && rows.map((t) => (
            <button key={t.id} type="button" className="text-left py-2 hover:bg-surface-2 px-1 rounded-md" onClick={() => pick(t.id)}>
              <div className="text-[12.5px]"><span className="font-mono font-medium text-brand-700">{t.number}</span> <span>{t.title}</span></div>
              <div className="text-[11.5px] text-muted">{t.customerName ?? '—'} · {t.status.label}{t.approvalStatus ? ` · ${APPROVAL_LABEL[t.approvalStatus] ?? t.approvalStatus}` : ''}</div>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
