import { useEffect, useState } from 'react';
import { Dialog, Button, Field, Select, Textarea, Checkbox, Input } from '@/components/ui';
import { reasonRequiredFor, useLifecycleSettings } from '@/hooks/useLookups';
import { pauseWords, type PauseRule, type PendingBody, type WaitingOn } from '../types';

/** The one shape every entry point hands the dialog: the status option's key, label and whether it pauses the clocks. */
export interface PendingTarget {
  id: string;
  key: string;
  label: string;
  pausesSla?: boolean;
}

const WAIT_BY_KEY: Record<string, WaitingOn> = { pending_customer: 'customer', pending_vendor: 'vendor', pending_change: 'change' };
const HOLD_CHOICES: { value: WaitingOn; label: string }[] = [
  { value: 'agreement', label: 'Agreed with the customer' },
  { value: 'internal', label: 'Internal (resources, another team)' },
];

/**
 * Putting a ticket on hold: the party waited on is always recorded and the reason is required
 * only when the lifecycle setting says (by default for a customer wait, where the reason is the
 * message the customer reads); On Hold asks who the hold waits on (agreed with the customer, or
 * internal); a supplier or change wait takes a reference; "Tell the customer" posts the reason as
 * a reply they can read (on by default for a customer wait, never for an internal hold). The line
 * under the form says which clocks stop, from the ticket's SLA policy (`pauseRule`); the boards
 * and the bulk bar carry no policy and say the policy decides.
 */
export function PendingDialog({ open, onClose, onSubmit, busy, ticketNumber, status, count, pauseRule }: { open: boolean; onClose: () => void; onSubmit: (body: PendingBody) => void; busy: boolean; ticketNumber: string; status: PendingTarget | null; /** The bulk bar: how many tickets the one reason applies to. */ count?: number; /** The record: the clock rule of the ticket's SLA policy; absent on the boards and the bulk bar. */ pauseRule?: PauseRule | null }) {
  const settings = useLifecycleSettings();
  const [reason, setReason] = useState('');
  const [waitingOn, setWaitingOn] = useState<WaitingOn | ''>('');
  const [expectedAt, setExpectedAt] = useState('');
  const [reference, setReference] = useState('');
  const [tell, setTell] = useState(false);
  const derived: WaitingOn | '' = status ? (WAIT_BY_KEY[status.key] ?? (status.key === 'on_hold' ? waitingOn : 'internal')) : '';
  const party: WaitingOn | '' = status?.key === 'on_hold' ? waitingOn : derived;
  useEffect(() => {
    if (open) {
      setReason('');
      setWaitingOn('');
      setExpectedAt('');
      setReference('');
      setTell(!!status && WAIT_BY_KEY[status.key] === 'customer');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, status?.id]);
  if (!status) return null;
  const isHold = status.key === 'on_hold';
  const internal = party === 'internal';
  const takesReference = status.key === 'pending_vendor' || status.key === 'pending_change';
  const reasonRequired = reasonRequiredFor(settings, party || null);
  const ready = (!reasonRequired || reason.trim().length > 0) && (!isHold || !!waitingOn);
  const slaLine = !status.pausesSla ? 'Clocks keep running: this status does not pause the SLA.' : pauseRule ? pauseWords(pauseRule, party) : "Clocks pause as the ticket's SLA policy says.";
  const submit = () =>
    onSubmit({
      statusId: status.id,
      pendingReason: reason.trim() || null,
      ...(isHold && waitingOn ? { waitingOn } : {}),
      expectedAt: expectedAt ? new Date(`${expectedAt}T00:00:00Z`).toISOString() : null,
      pendingReference: takesReference && reference.trim() ? reference.trim() : null,
      tellCustomer: internal ? false : tell,
    });
  return (
    <Dialog open={open} onClose={onClose} title={`Put ${count ? `${count} ticket${count > 1 ? 's' : ''}` : ticketNumber} on hold · ${status.label}`} width="max-w-md" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!ready} loading={busy} data-testid="pending-submit">{status.label}</Button></>}>
      <div className="flex flex-col gap-3" data-testid="pending-dialog">
        <Field label="Reason" required={reasonRequired} hint={reasonRequired ? 'What is being waited for; shown on the record and the timeline.' : 'Optional: what is being waited for; shown on the record and the timeline.'}>
          <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-[90px]" placeholder={status.key === 'pending_customer' ? 'What the customer needs to send or confirm' : 'What the ticket is waiting for'} data-testid="pending-reason" />
        </Field>
        {isHold && (
          <Field label="Waiting on" required hint="An agreed hold stops the clocks; an internal hold keeps them running and is not shown to the customer.">
            <Select value={waitingOn} onChange={(e) => setWaitingOn(e.target.value as WaitingOn | '')} placeholder="Choose…" options={HOLD_CHOICES} data-testid="pending-waiting-on" />
          </Field>
        )}
        <Field label="Expected by" hint="Optional: when the wait is expected to end.">
          <Input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} data-testid="pending-expected" />
        </Field>
        {takesReference && (
          <Field label="Reference" hint={status.key === 'pending_vendor' ? "The supplier's or third party's ticket or case number (staff only)." : 'The change number (staff only).'}>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} data-testid="pending-reference" />
          </Field>
        )}
        <Field hint={internal ? 'Kept as a work note: an internal hold is not shown to the customer.' : tell ? 'Posted as a reply the customer can read.' : 'Kept as a work note.'}>
          <Checkbox label="Tell the customer" checked={internal ? false : tell} disabled={internal} onChange={(e) => setTell(e.target.checked)} data-testid="pending-tell" />
        </Field>
        <p className="text-[12.5px] text-muted" data-testid="pending-sla-line">{slaLine}</p>
      </div>
    </Dialog>
  );
}
