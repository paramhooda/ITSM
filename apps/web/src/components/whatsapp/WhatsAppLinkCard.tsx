import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExternalLink, MessageCircle, ShieldCheck } from 'lucide-react';
import type { Principal } from '@itsm/shared';
import { get, patch, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { Badge, Button, Card, Checkbox, ConfirmDialog, ErrorBlock, LoadingBlock } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { WHATSAPP_LINK_COLORS } from '@/lib/statusColors';
import { cn } from '@/lib/utils';
import { notificationPrefsApi, notificationPrefsKeys, type PreferenceMatrix, type VerifyStartTyped } from '@/components/notifications/api';
import { VerifyPhoneDialog } from '@/components/notifications/VerifyPhoneDialog';
import { linkStateOf, whatsappApi, whatsappKeys, type LinkStatus } from './api';

const messageOf = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const STATE_LABEL = { linked: 'Linked', verified: 'Verified · chat off', pending: 'Waiting for your code', none: 'Not verified' } as const;

/**
 * The profile card "WhatsApp chat with Grady", for staff and portal users
 * alike. "Linked" means two things: the person proved they own the number
 * (a code sent to the phone, or a code shown here and sent from the phone to
 * the business number) and switched the chat on. Turning the chat off keeps
 * the number verified; administrators revoke a number from the Users pages.
 * While a typed code is shown the card polls every five seconds until the
 * phone's message linked the number.
 */
export function WhatsAppLinkCard() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user)!;
  const setUser = useAuthStore((s) => s.setUser);
  const [typed, setTyped] = useState<VerifyStartTyped | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [offOpen, setOffOpen] = useState(false);

  const matrix = useQuery({ queryKey: notificationPrefsKeys.matrix, queryFn: () => notificationPrefsApi.matrix(), staleTime: 10_000 });
  const q = useQuery({
    queryKey: whatsappKeys.link,
    queryFn: () => whatsappApi.link(),
    staleTime: 10_000,
    // A typed code is on screen: watch for the phone's message until the number is linked (or the code expires).
    refetchInterval: (query) => {
      const d = query.state.data;
      return typed && !(d?.verifiedAt && d.assistant.on) ? 5000 : false;
    },
  });
  const s = q.data;

  const refreshUser = async () => {
    try {
      const res = await get<{ user: Principal }>('/auth/me');
      setUser(res.user);
    } catch {
      /* the card already shows the state; the principal refreshes on the next load */
    }
  };
  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: whatsappKeys.link });
    void qc.invalidateQueries({ queryKey: notificationPrefsKeys.matrix });
  };

  // The phone's message linked the number while the typed code was on screen.
  const linkedNow = !!typed && !!s?.verifiedAt && s.assistant.on;
  const announced = useRef(false);
  useEffect(() => {
    if (!linkedNow || announced.current) return;
    announced.current = true;
    setTyped(null);
    toast.success('WhatsApp linked');
    void qc.invalidateQueries({ queryKey: notificationPrefsKeys.matrix });
    void refreshUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedNow]);
  useEffect(() => {
    if (!typed) return;
    announced.current = false;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [typed]);
  const typedLeft = typed ? new Date(typed.expiresAt).getTime() - now : 0;
  useEffect(() => {
    if (typed && typedLeft <= 0) {
      setTyped(null);
      toast.message('The code expired; request a new one when you are ready.');
    }
  }, [typed, typedLeft]);

  const startTyped = useMutation({
    mutationFn: () => notificationPrefsApi.verifyStartTyped(),
    onSuccess: (res) => {
      setNow(Date.now());
      setTyped(res);
      void qc.invalidateQueries({ queryKey: whatsappKeys.link });
    },
    onError: (err) => toast.error(messageOf(err, 'Could not prepare a code')),
  });
  const turnOn = useMutation({
    mutationFn: () => whatsappApi.turnOn(),
    onSuccess: () => {
      qc.setQueryData<LinkStatus>(whatsappKeys.link, (prev) => (prev ? { ...prev, assistant: { ...prev.assistant, on: true } } : prev));
      invalidateAll();
      toast.success('Chat with Grady on WhatsApp is on');
    },
    onError: (err) => toast.error(messageOf(err, 'Could not switch the chat on')),
  });
  const turnOff = useMutation({
    mutationFn: () => whatsappApi.turnOff(),
    onSuccess: () => {
      setOffOpen(false);
      qc.setQueryData<LinkStatus>(whatsappKeys.link, (prev) => (prev ? { ...prev, assistant: { ...prev.assistant, on: false } } : prev));
      invalidateAll();
      toast.success('Chat with Grady on WhatsApp is off');
    },
    onError: (err) => toast.error(messageOf(err, 'Could not switch the chat off')),
  });
  const optIn = useMutation({
    mutationFn: () => patch<{ user: Principal }>('/auth/me', { whatsappOptIn: true }),
    onSuccess: (res) => {
      setUser(res.user);
      void qc.invalidateQueries({ queryKey: notificationPrefsKeys.matrix });
      toast.success('WhatsApp notifications on');
    },
    onError: (err) => toast.error(messageOf(err, 'Could not update WhatsApp notifications')),
  });

  // A code sent to the phone and confirmed in the dialog: the number is verified; the card switches the chat on.
  const onVerified = async (m: PreferenceMatrix) => {
    qc.setQueryData(notificationPrefsKeys.matrix, m);
    try {
      await whatsappApi.turnOn();
      toast.success('WhatsApp linked');
    } catch (err) {
      toast.error(messageOf(err, 'Verified, but the chat could not be switched on'));
    }
    invalidateAll();
    await refreshUser();
  };

  const state = s ? linkStateOf(s) : 'none';
  const channelEnabled = matrix.data?.whatsapp.channelEnabled ?? true;
  const notSetUp = !!s && !s.assistant.enabled && !s.verifiedAt && !typed;
  const business = s?.businessNumber ?? null;
  const since = s?.verifiedAt ? fmtDateTime(s.verifiedAt) : null;

  return (
    <Card title="WhatsApp chat with Grady" actions={<MessageCircle className="h-4 w-4 text-emerald-600" />} data-testid="whatsapp-link-card">
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error || !s ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : notSetUp ? (
        <p className="text-[13px] text-muted" data-testid="link-not-configured">
          WhatsApp chat is not set up on this platform yet.{user.userType === 'customer' ? ' The service desk switches it on.' : ' Your administrator switches it on under Administration → WhatsApp.'}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="min-w-0 flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge color={WHATSAPP_LINK_COLORS[state]} data-testid="link-state" dot>
                  {state === 'linked' && <ShieldCheck className="h-3.5 w-3.5" />}
                  {STATE_LABEL[state]}
                </Badge>
                {s.phone ? <span className="font-mono text-[12.5px] text-default">{s.phone}</span> : <span className="text-[12.5px] text-muted">Save a mobile number in your profile first.</span>}
                {since && <span className="text-[12px] text-subtle">since {since}</span>}
              </div>
              <div className="text-[12.5px] text-muted" data-testid="link-description">
                {state === 'linked' && (
                  <>
                    Message {business ? <span className="font-mono text-default">{business}</span> : 'the business WhatsApp number'} on WhatsApp to chat with Grady: the same tools and permissions as here. Reply YES or NO when it proposes a change; text STOP to switch the chat off from your phone.
                  </>
                )}
                {state === 'verified' && <>Your number is verified. Switch the chat on to message {business ? <span className="font-mono text-default">{business}</span> : 'the business WhatsApp number'} and get answers from Grady on your phone.</>}
                {state === 'pending' && s.pending?.method === 'sent' && !typed && 'A code is on its way to your phone; enter it under Notifications above, or request a new one here.'}
                {state === 'pending' && s.pending?.method === 'typed' && !typed && 'A code was shown earlier and is still live; request a new one if you lost it.'}
                {state === 'none' && 'Prove the number is yours, then switch the chat on: Grady answers you on WhatsApp with exactly what you may see and do here.'}
              </div>
              {(state === 'linked' || state === 'verified') && s.assistant.reason && (
                <div className="text-[12.5px] text-amber-700" data-testid="link-reason">
                  {s.assistant.reason}.
                </div>
              )}
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 shrink-0">
              {state === 'linked' && (
                <Button size="sm" variant="outline" onClick={() => setOffOpen(true)} data-testid="turn-off-chat">
                  Turn off chat
                </Button>
              )}
              {state === 'verified' && (
                <Button size="sm" onClick={() => turnOn.mutate()} loading={turnOn.isPending} data-testid="turn-on-chat">
                  Turn on chat
                </Button>
              )}
              {(state === 'none' || state === 'pending') && !typed && (
                <>
                  <Button size="sm" onClick={() => setVerifyOpen(true)} disabled={!s.phone || !channelEnabled} title={!s.phone ? 'Save a mobile number in your profile first' : !channelEnabled ? 'WhatsApp is not set up on this platform' : undefined} data-testid="send-code">
                    Send me a code
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => startTyped.mutate()} loading={startTyped.isPending} disabled={!s.phone} title={!s.phone ? 'Save a mobile number in your profile first' : undefined} data-testid="typed-start">
                    I'll send the code
                  </Button>
                </>
              )}
            </div>
          </div>

          {typed && (
            <div className="rounded-lg border border-default bg-surface-2/40 px-4 py-3 flex flex-col gap-3" data-testid="typed-code">
              <div className="text-[13px]">
                Send this code from <span className="font-mono text-default">{s.phone ?? 'your number'}</span> to {typed.businessNumber ? <span className="font-mono text-default">{typed.businessNumber}</span> : 'the business WhatsApp number'} on WhatsApp. Nothing else is needed: the number is linked the moment the message arrives.
              </div>
              <div className="font-mono text-[30px] leading-none tracking-[0.3em] text-default select-all" data-testid="typed-code-value" aria-label="Your one-time code">
                {typed.code}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {typed.waLink && (
                  <a href={typed.waLink} target="_blank" rel="noreferrer" className={cn('inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-default bg-white text-[12.5px] font-medium text-default hover:bg-surface-2 hover:border-strong')} data-testid="open-whatsapp">
                    <ExternalLink className="h-3.5 w-3.5" /> Open WhatsApp
                  </a>
                )}
                <span className="text-[12px] text-subtle inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Waiting for your message · expires in {mmss(typedLeft)}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setTyped(null)} className="sm:ml-auto">
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {(state === 'none' || state === 'pending') && !typed && <div className="text-[12px] text-subtle">Codes are limited to three an hour and expire after ten minutes; five wrong tries void a code.</div>}

          {state === 'linked' && !user.whatsappOptIn && s.phone && (
            <div data-testid="link-opt-in">
              <Checkbox label={<span>Also send me notifications on WhatsApp <span className="text-subtle">— the categories ticked under Notifications</span></span>} checked={false} onChange={() => optIn.mutate()} disabled={optIn.isPending} />
            </div>
          )}
        </div>
      )}

      <VerifyPhoneDialog key={s?.phone ?? ''} open={verifyOpen} onClose={() => setVerifyOpen(false)} onVerified={(m) => void onVerified(m)} />
      <ConfirmDialog
        open={offOpen}
        onClose={() => setOffOpen(false)}
        onConfirm={() => turnOff.mutate()}
        title="Turn off chat with Grady on WhatsApp?"
        description="Messages you send to the business number get a short notice instead of an answer. Your number stays verified, so you can switch the chat back on here at any time, or text START from your phone."
        confirmLabel="Turn off chat"
        loading={turnOff.isPending}
      />
    </Card>
  );
}
