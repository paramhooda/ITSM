import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { Button, Dialog, Field, Input } from '@/components/ui';
import { notificationPrefsApi, type PreferenceMatrix, type VerifyStart } from './api';

const RESEND_AFTER_S = 60;

const messageOf = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * Sends a six-digit code to the person's mobile number over WhatsApp when it
 * opens and checks the code they type. A code that is still live when the
 * dialog is closed and reopened is kept rather than sent again; "Send again"
 * waits a minute. Every send counts towards the three an hour, so a 429 shows
 * the server's message. The parent keys the dialog by the number, so a new
 * number starts afresh.
 */
export function VerifyPhoneDialog({ open, onClose, onVerified }: { open: boolean; onClose: () => void; onVerified: (matrix: PreferenceMatrix) => void }) {
  const [sent, setSent] = useState<VerifyStart | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  const start = useMutation({
    mutationFn: () => notificationPrefsApi.verifyStart(),
    onSuccess: (res) => {
      const at = Date.now();
      setSent(res);
      setSentAt(at);
      setNow(at);
      setError(null);
      setCode('');
      setTimeout(() => inputRef.current?.focus(), 50);
    },
    onError: (err) => setError(messageOf(err, 'Could not send the code')),
  });
  const confirm = useMutation({
    mutationFn: (c: string) => notificationPrefsApi.verifyConfirm(c),
    onSuccess: (matrix) => {
      toast.success('Number verified');
      setSent(null);
      setSentAt(null);
      onVerified(matrix);
      onClose();
    },
    onError: (err) => setError(messageOf(err, 'Could not check the code')),
  });

  // On open: keep a code that is still live (closing the dialog must not spend the hourly allowance); otherwise send one.
  const startRef = useRef(start.mutate);
  startRef.current = start.mutate;
  const sentRef = useRef(sent);
  sentRef.current = sent;
  useEffect(() => {
    if (!open) return;
    setCode('');
    setError(null);
    const live = sentRef.current && new Date(sentRef.current.expiresAt).getTime() > Date.now();
    if (live) {
      setNow(Date.now());
      setTimeout(() => inputRef.current?.focus(), 50);
      return;
    }
    setSent(null);
    setSentAt(null);
    startRef.current();
  }, [open]);

  useEffect(() => {
    if (!open || !sentAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, sentAt]);

  const waitLeft = sentAt ? Math.min(RESEND_AFTER_S, Math.max(0, RESEND_AFTER_S - Math.floor((now - sentAt) / 1000))) : 0;
  const minutesLeft = sent ? Math.max(1, Math.ceil((new Date(sent.expiresAt).getTime() - now) / 60_000)) : 0;
  const canConfirm = !!sent && /^\d{6}$/.test(code) && !confirm.isPending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Verify your mobile number"
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => confirm.mutate(code)} disabled={!canConfirm} loading={confirm.isPending}>
            Confirm
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canConfirm) confirm.mutate(code);
        }}
      >
        <div className="text-[13px] text-muted" data-testid="verify-status">
          {sent ? (
            <>
              We sent a code to <span className="font-mono text-default">{sent.sentTo}</span> on WhatsApp. It expires in {minutesLeft} {minutesLeft === 1 ? 'minute' : 'minutes'}.
            </>
          ) : start.isPending ? (
            'Sending a code to your number…'
          ) : (
            'No code was sent.'
          )}
        </div>
        <Field label="Six-digit code" error={error}>
          <Input ref={inputRef} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" placeholder="123456" className="font-mono tracking-[0.3em]" disabled={!sent} aria-label="Six-digit code" />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-subtle">Did not get it? Codes are limited to three an hour.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => start.mutate()} disabled={start.isPending || waitLeft > 0} loading={start.isPending}>
            {waitLeft > 0 ? `Send again (${waitLeft} s)` : 'Send again'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
