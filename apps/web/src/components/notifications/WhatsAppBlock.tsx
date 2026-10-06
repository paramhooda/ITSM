import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShieldCheck } from 'lucide-react';
import type { Principal } from '@itsm/shared';
import { patch, ApiError } from '@/api/client';
import { Badge, Button, ConfirmDialog, Toggle } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { notificationPrefsKeys, type PreferenceMatrix } from './api';
import { VerifyPhoneDialog } from './VerifyPhoneDialog';

export const VERIFY_HELP = 'Proves the number is yours; needed to chat with Grady on WhatsApp, not for notifications.';

const messageOf = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * The WhatsApp block of the Notifications card: the mobile number from the
 * Profile card, the opt-in toggle (consent to notifications), the Verified
 * badge or the Verify number button, and Remove number. Verification never
 * changes the opt-in.
 */
export function WhatsAppBlock({ matrix, user, onUser, onVerified }: { matrix: PreferenceMatrix; user: Principal; onUser: (user: Principal) => void; onVerified: (matrix: PreferenceMatrix) => void }) {
  const qc = useQueryClient();
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const { phone, optIn, verifiedAt, channelEnabled } = matrix.whatsapp;

  const setMatrixWhatsApp = (next: Partial<PreferenceMatrix['whatsapp']>) =>
    qc.setQueryData<PreferenceMatrix>(notificationPrefsKeys.matrix, (m) => (m ? { ...m, whatsapp: { ...m.whatsapp, ...next } } : m));

  const saveOptIn = useMutation({
    mutationFn: (whatsappOptIn: boolean) => patch<{ user: Principal }>('/auth/me', { whatsappOptIn }),
    onSuccess: (res) => {
      onUser(res.user);
      setMatrixWhatsApp({ optIn: !!res.user.whatsappOptIn, phone: res.user.phone ?? null });
      void qc.invalidateQueries({ queryKey: notificationPrefsKeys.matrix });
      toast.success(res.user.whatsappOptIn ? 'WhatsApp notifications on' : 'WhatsApp notifications off');
    },
    onError: (err) => toast.error(messageOf(err, 'Could not update WhatsApp notifications')),
  });

  const removeNumber = useMutation({
    mutationFn: () => patch<{ user: Principal }>('/auth/me', { phone: '', whatsappOptIn: false }),
    onSuccess: (res) => {
      setRemoveOpen(false);
      onUser(res.user);
      setMatrixWhatsApp({ phone: null, optIn: false, verifiedAt: null });
      void qc.invalidateQueries({ queryKey: notificationPrefsKeys.matrix });
      toast.success('Mobile number removed');
    },
    onError: (err) => toast.error(messageOf(err, 'Could not remove the number')),
  });

  const verifyDisabled = !phone || !channelEnabled;
  const verifyLabel = !channelEnabled ? 'WhatsApp is not set up on this platform' : 'Verify number';

  return (
    <div className="rounded-lg border border-default bg-surface-2/40 px-4 py-3" data-testid="whatsapp-block">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">WhatsApp</div>
          <div className="text-[12.5px] text-muted">
            {phone ? (
              <>
                Mobile number <span className="font-mono text-default">{phone}</span>
              </>
            ) : (
              'Save a mobile number in your profile first.'
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {verifiedAt ? (
            <Badge color="green" data-testid="whatsapp-verified" title={`Verified on ${fmtDate(verifiedAt)}`}>
              <ShieldCheck className="h-3.5 w-3.5" /> Verified · {fmtDate(verifiedAt)}
            </Badge>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setVerifyOpen(true)} disabled={verifyDisabled} title={!phone ? 'Save a mobile number in your profile first' : undefined} data-testid="verify-number">
              {verifyLabel}
            </Button>
          )}
          {phone && (
            <Button size="sm" variant="ghost" onClick={() => setRemoveOpen(true)} data-testid="remove-number">
              Remove number
            </Button>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        <span data-testid="whatsapp-opt-in">
          <Toggle
            checked={optIn}
            onChange={(v) => saveOptIn.mutate(v)}
            disabled={!phone || saveOptIn.isPending}
            title={!phone ? 'Save a mobile number in your profile first' : undefined}
            label={
              <span>
                WhatsApp notifications <span className="text-subtle">— the categories ticked below, on {phone ?? 'your mobile number'}</span>
              </span>
            }
          />
        </span>
        {!verifiedAt && <div className="text-[12px] text-subtle">{VERIFY_HELP}</div>}
      </div>
      <VerifyPhoneDialog key={phone ?? ''} open={verifyOpen} onClose={() => setVerifyOpen(false)} onVerified={onVerified} />
      <ConfirmDialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        onConfirm={() => removeNumber.mutate()}
        title="Remove your mobile number?"
        description="WhatsApp notifications stop and the verification is cleared. You can add a number again on the Profile card."
        confirmLabel="Remove number"
        danger
        loading={removeNumber.isPending}
      />
    </div>
  );
}
