import { useEffect, useState } from 'react';
import { Dialog, Button, Field, Select, Textarea } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import type { ScopeStatus, TicketDetail } from '../types';

export function ResolveDialog({ open, onClose, onSubmit, busy, ticket }: { open: boolean; onClose: () => void; onSubmit: (v: { resolutionCodeId: string | null; resolutionNotes: string }) => void; busy: boolean; ticket: TicketDetail }) {
  const { options } = useLookups();
  const codes = options('resolution_code');
  const [code, setCode] = useState('');
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (open) {
      setCode(codes.find((c) => c.isDefault)?.id ?? '');
      setNotes(ticket.resolutionNotes ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const verb = ticket.type === 'request' ? 'Fulfil' : ticket.type === 'change' ? 'Mark implemented' : 'Resolve';
  return (
    <Dialog open={open} onClose={onClose} title={`${verb} ${ticket.number}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => onSubmit({ resolutionCodeId: code || null, resolutionNotes: notes.trim() })} disabled={!notes.trim()} loading={busy}>{verb}</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Resolution code">
          <Select value={code} onChange={(e) => setCode(e.target.value)} placeholder="—" options={codes.map((c) => ({ value: c.id, label: c.label }))} />
        </Field>
        <Field label="Resolution notes" required hint="Visible to the customer and included in the resolution email.">
          <Textarea autoFocus value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-[110px]" placeholder="What was done to resolve the issue" />
        </Field>
      </div>
    </Dialog>
  );
}

export function CommentDialog({ open, onClose, onSubmit, busy, title, label = 'Comment', confirmLabel = 'Confirm', danger, required, codes }: { open: boolean; onClose: () => void; onSubmit: (v: { comment: string; codeId: string | null }) => void; busy: boolean; title: string; label?: string; confirmLabel?: string; danger?: boolean; required?: boolean; codes?: { id: string; label: string }[] }) {
  const [comment, setComment] = useState('');
  const [code, setCode] = useState('');
  useEffect(() => {
    if (open) {
      setComment('');
      setCode('');
    }
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title={title} width="max-w-md" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} onClick={() => onSubmit({ comment: comment.trim(), codeId: code || null })} disabled={required && !comment.trim()} loading={busy}>{confirmLabel}</Button></>}>
      <div className="flex flex-col gap-3">
        {codes && codes.length > 0 && (
          <Field label="Closure code">
            <Select value={code} onChange={(e) => setCode(e.target.value)} placeholder="Default" options={codes.map((c) => ({ value: c.id, label: c.label }))} />
          </Field>
        )}
        <Field label={label} required={required}>
          <Textarea autoFocus value={comment} onChange={(e) => setComment(e.target.value)} className="min-h-[90px]" />
        </Field>
      </div>
    </Dialog>
  );
}

export function ScopeDialog({ open, onClose, onSubmit, busy, ticket }: { open: boolean; onClose: () => void; onSubmit: (v: { scopeStatus: ScopeStatus; scopeNote: string }) => void; busy: boolean; ticket: TicketDetail }) {
  const [status, setStatus] = useState<ScopeStatus>(ticket.scopeStatus);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) {
      setStatus(ticket.scopeStatus);
      setNote(ticket.scopeClassifiedBy ? ticket.scopeNote ?? '' : '');
    }
  }, [open, ticket]);
  return (
    <Dialog open={open} onClose={onClose} title="Override scope classification" width="max-w-md" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => onSubmit({ scopeStatus: status, scopeNote: note.trim() })} loading={busy}>Save</Button></>}>
      <div className="flex flex-col gap-3">
        <div className="text-[12.5px] text-muted">
          Automatic classification: <span className="font-medium text-default">{ticket.scopeStatus.replace(/_/g, ' ')}</span>
          {ticket.scopeNote && !ticket.scopeClassifiedBy ? ` — ${ticket.scopeNote}` : ''}
        </div>
        <Field label="Scope">
          <Select value={status} onChange={(e) => setStatus(e.target.value as ScopeStatus)} options={[{ value: 'in_scope', label: 'In scope' }, { value: 'out_of_scope', label: 'Out of scope' }, { value: 'unknown', label: 'Unknown' }]} />
        </Field>
        <Field label="Reason" hint="Recorded in the timeline and audit trail. Scope never blocks work on the ticket.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} className="min-h-[80px]" placeholder="Why is this classification correct?" />
        </Field>
      </div>
    </Dialog>
  );
}
