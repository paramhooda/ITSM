import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Principal } from '@itsm/shared';
import { get, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { Card, ErrorBlock, LoadingBlock } from '@/components/ui';
import { briefingKeys } from '@/components/briefings/api';
import { notificationPrefsApi, notificationPrefsKeys, type PrefChannel, type PreferenceMatrix } from './api';
import { WhatsAppBlock } from './WhatsAppBlock';
import { PreferenceMatrix as Matrix } from './PreferenceMatrix';

interface CellChange {
  key: string;
  channel: PrefChannel;
  value: boolean;
}

const CELL_MUTATION = ['notifications', 'preferences', 'cell'];
const cellId = (c: CellChange) => `${c.key}:${c.channel}`;

/** The cached matrix with one cell set. */
const withCell = (m: PreferenceMatrix, { key, channel }: CellChange, on: boolean): PreferenceMatrix => ({ ...m, rows: m.rows.map((r) => (r.key === key ? { ...r, [channel]: { ...r[channel], on } } : r)) });

/**
 * The Notifications card of the profile page, for staff and portal users
 * alike: the WhatsApp block, then the preference matrix of the person's
 * audience. Each cell is saved on click: optimistic, every in-flight cell
 * shows busy, a refusal rolls back that cell with the server's message, and
 * two quick clicks never undo each other (the last answer wins).
 */
export function NotificationsCard({ onUser }: { onUser?: (user: Principal) => void }) {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user)!;
  const setUser = useAuthStore((s) => s.setUser);
  const applyUser = (u: Principal) => {
    setUser(u);
    onUser?.(u);
  };
  const q = useQuery({ queryKey: notificationPrefsKeys.matrix, queryFn: () => notificationPrefsApi.matrix() });
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const update = useMutation({
    mutationKey: CELL_MUTATION,
    mutationFn: ({ key, channel, value }: CellChange) => notificationPrefsApi.update({ [key]: { [channel]: value } }),
    onMutate: async (change) => {
      setPending((prev) => new Set(prev).add(cellId(change)));
      await qc.cancelQueries({ queryKey: notificationPrefsKeys.matrix });
      const prev = qc.getQueryData<PreferenceMatrix>(notificationPrefsKeys.matrix);
      const before = prev?.rows.find((r) => r.key === change.key)?.[change.channel].on;
      if (prev) qc.setQueryData<PreferenceMatrix>(notificationPrefsKeys.matrix, withCell(prev, change, change.value));
      return { before };
    },
    onError: (err, change, ctx) => {
      // Only the refused cell goes back; another cell saved meanwhile keeps its state.
      if (ctx?.before !== undefined) qc.setQueryData<PreferenceMatrix>(notificationPrefsKeys.matrix, (m) => (m ? withCell(m, change, ctx.before!) : m));
      toast.error(err instanceof ApiError ? err.message : 'Could not save the preference');
    },
    onSuccess: (matrix, change) => {
      const last = qc.isMutating({ mutationKey: CELL_MUTATION }) <= 1;
      if (last) qc.setQueryData(notificationPrefsKeys.matrix, matrix);
      else {
        // Another cell is still saving: take this row and the WhatsApp state from the answer, keep the other cell's optimistic value.
        const row = matrix.rows.find((r) => r.key === change.key);
        qc.setQueryData<PreferenceMatrix>(notificationPrefsKeys.matrix, (m) => (m && row ? { ...m, whatsapp: matrix.whatsapp, rows: m.rows.map((r) => (r.key === row.key ? row : r)) } : matrix));
      }
      if (change.key === 'briefing') void qc.invalidateQueries({ queryKey: briefingKeys.today });
    },
    onSettled: (_m, _e, change) => {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(cellId(change));
        return next;
      });
    },
  });

  const onVerified = async (matrix: PreferenceMatrix) => {
    qc.setQueryData(notificationPrefsKeys.matrix, matrix);
    try {
      const res = await get<{ user: Principal }>('/auth/me');
      applyUser(res.user);
    } catch {
      /* the badge already shows from the matrix; the principal refreshes on the next load */
    }
  };

  const customer = (q.data?.audience ?? (user.userType === 'customer' ? 'customer' : 'staff')) === 'customer';

  return (
    <Card title="Notifications">
      {q.isLoading ? (
        <LoadingBlock />
      ) : q.error || !q.data ? (
        <ErrorBlock error={q.error} retry={() => void q.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <WhatsAppBlock matrix={q.data} user={user} onUser={applyUser} onVerified={onVerified} />
          <Matrix matrix={q.data} pending={pending} onChange={(key, channel, value) => update.mutate({ key, channel, value })} />
          <p className="text-[12px] text-muted">
            Your choices only remove a channel; in-app notifications are always on and account messages (welcome, password reset, verification codes) are always sent.{' '}
            {customer ? 'Which events exist and which channels they may use is set by the service desk.' : "Which events exist and which channels they may use is set by your administrator's notification rules."}
          </p>
        </div>
      )}
    </Card>
  );
}
