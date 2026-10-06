import { Check, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MatrixRow, PrefChannel, PreferenceMatrix as Matrix } from './api';

export const LOCKED_TITLE = 'Always on (set by your administrator)';

/** Why the WhatsApp column is disabled as a whole, or null when every WhatsApp cell may be ticked. */
export function whatsappColumnReason(m: Matrix): string | null {
  if (!m.whatsapp.channelEnabled) return 'WhatsApp is not set up on this platform';
  if (!m.whatsapp.phone || !m.whatsapp.optIn) return 'Turn on WhatsApp notifications above';
  return null;
}

const COLS = 'sm:grid-cols-[minmax(0,1fr)_88px_88px_72px]';

/** A small label shown beside each cell under `sm`, where the header row is hidden. */
const CellLabel = ({ children }: { children: string }) => <span className="text-[11px] text-subtle sm:hidden">{children}</span>;

function Cell({ row, channel, reason, pending, onChange }: { row: MatrixRow; channel: PrefChannel; reason: string | null; pending: boolean; onChange: (value: boolean) => void }) {
  const cell = row[channel];
  const label = channel === 'email' ? 'Email' : 'WhatsApp';
  if (channel === 'whatsapp' && !row.whatsapp.available) {
    return (
      <div className="flex items-center justify-between sm:justify-center" title={`${row.label} is not sent over WhatsApp`}>
        <CellLabel>{label}</CellLabel>
        <span className="text-subtle" aria-label={`${row.label} is not sent over WhatsApp`}>—</span>
      </div>
    );
  }
  if (cell.locked) {
    return (
      <div className="flex items-center justify-between sm:justify-center">
        <CellLabel>{label}</CellLabel>
        <span role="img" aria-label={`${row.label} by ${label}: ${LOCKED_TITLE}`} title={LOCKED_TITLE} data-locked={`${row.key}:${channel}`} className="inline-flex h-4 w-4 items-center justify-center text-subtle">
          <Lock className="h-3.5 w-3.5" />
        </span>
      </div>
    );
  }
  const disabled = pending || (channel === 'whatsapp' && !!reason);
  return (
    <div className="flex items-center justify-between sm:justify-center" title={channel === 'whatsapp' && reason ? reason : undefined}>
      <CellLabel>{label}</CellLabel>
      <input
        type="checkbox"
        className={cn('h-4 w-4 rounded border-strong accent-brand-600', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', pending && 'animate-pulse')}
        checked={cell.on}
        disabled={disabled}
        aria-label={`${row.label} by ${label}`}
        data-cell={`${row.key}:${channel}`}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}

/**
 * One row per notification category the person is offered, columns Email,
 * WhatsApp and In-app. A cell is a checkbox saved on click; a locked cell is a
 * lock icon; the WhatsApp column is disabled as a whole until the person has a
 * number and the opt-in (or while the channel is not set up); in-app is a
 * fixed, muted tick. Stacks under `sm`.
 */
export function PreferenceMatrix({ matrix, onChange, pending }: { matrix: Matrix; onChange: (key: string, channel: PrefChannel, value: boolean) => void; pending?: ReadonlySet<string> }) {
  const reason = whatsappColumnReason(matrix);
  return (
    <div className="rounded-lg border border-default" data-testid="preference-matrix">
      <div className={cn('hidden sm:grid', COLS, 'gap-3 border-b border-default bg-surface-2/60 px-3 py-2 text-[11px] uppercase tracking-wide text-subtle')}>
        <div>Category</div>
        <div className="text-center">Email</div>
        <div className="text-center" title={reason ?? undefined}>WhatsApp</div>
        <div className="text-center">In-app</div>
      </div>
      {reason && (
        <div className="border-b border-default px-3 py-1.5 text-[12px] text-amber-700" data-testid="whatsapp-column-reason">
          WhatsApp column off: {reason}.
        </div>
      )}
      <div className="divide-y divide-[var(--border)]">
        {matrix.rows.map((row) => (
          <div key={row.key} className={cn('grid grid-cols-1', COLS, 'gap-2 px-3 py-2.5 sm:items-center sm:gap-3')} data-row={row.key}>
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{row.label}</div>
              <div className="text-[12px] text-muted">{row.description}</div>
            </div>
            <div className="flex items-center gap-5 sm:contents">
              <Cell row={row} channel="email" reason={null} pending={!!pending?.has(`${row.key}:email`)} onChange={(v) => onChange(row.key, 'email', v)} />
              <Cell row={row} channel="whatsapp" reason={reason} pending={!!pending?.has(`${row.key}:whatsapp`)} onChange={(v) => onChange(row.key, 'whatsapp', v)} />
              <div className="flex items-center justify-between sm:justify-center" title="Always on">
                <CellLabel>In-app</CellLabel>
                <span role="img" aria-label={`${row.label} in-app: always on`} className="inline-flex h-4 w-4 items-center justify-center text-subtle">
                  <Check className="h-3.5 w-3.5" />
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
