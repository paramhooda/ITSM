import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button, Dialog, Field, Select, Textarea } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { changesApi, changeKeys } from './api';

/** Puts a change on the agenda of an upcoming CAB meeting, with a note for the board. */
export function CabPickerDialog({ open, onClose, ticketId, ticketNumber }: { open: boolean; onClose: () => void; ticketId: string; ticketNumber?: string }) {
  const qc = useQueryClient();
  const params = { status: 'upcoming', page: 1, pageSize: 20 };
  const meetings = useQuery({ queryKey: changeKeys.meetings(params), queryFn: () => changesApi.meetings(params), enabled: open, staleTime: 15_000 });
  const [meetingId, setMeetingId] = useState('');
  const [notes, setNotes] = useState('');
  const items = meetings.data?.items ?? [];
  useEffect(() => {
    if (open) setNotes('');
  }, [open]);
  useEffect(() => {
    if (!meetingId && items.length) setMeetingId(items[0]!.id);
  }, [items, meetingId]);
  const add = useMutation({
    mutationFn: () => changesApi.addItem(meetingId, { ticketId, notes: notes.trim() || null }),
    onSuccess: (m) => {
      toast.success(`Added to the agenda of ${m.title}`);
      void qc.invalidateQueries({ queryKey: ['tickets', ticketId] });
      void qc.invalidateQueries({ queryKey: ['cab'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Add ${ticketNumber ?? 'the change'} to a CAB meeting`}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={add.isPending} disabled={!meetingId} onClick={() => add.mutate()}>Add to the agenda</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        {meetings.isLoading ? (
          <div className="text-subtle">Loading the upcoming meetings…</div>
        ) : items.length === 0 ? (
          <div className="text-muted">
            No CAB meeting is scheduled. <Link to="/operations/cab" className="text-brand-700 underline underline-offset-2">Create one</Link> first.
          </div>
        ) : (
          <Field label="Meeting" required>
            <Select value={meetingId} onChange={(e) => setMeetingId(e.target.value)} options={items.map((m) => ({ value: m.id, label: `${m.title} · ${fmtDateTime(m.scheduledAt)}${m.items ? ` · ${m.items} on the agenda` : ''}` }))} />
          </Field>
        )}
        <Field label="Notes for the board" hint="What the board should know: the risk, the customer's ask, the evidence to bring">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Needs the DR evidence; the customer asked for the Saturday window." />
        </Field>
        <p className="text-[12px] text-subtle">The requester and the assignee are told the change is on the agenda.</p>
      </div>
    </Dialog>
  );
}
