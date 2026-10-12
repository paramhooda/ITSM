import { cn } from '@/lib/utils';

/**
 * The portal list's status vocabulary, one exclusive chip each. The chips are
 * presentational: the page maps a click to the list keys (`statusCategory`,
 * `statusId`, `csat`) and derives which chip is on from the URL, so a link
 * that arrives with the same keys lights the same chip.
 */
export type PortalStatusChip = 'open' | 'awaiting' | 'resolved' | 'closed' | 'rate' | 'any';

export const PORTAL_STATUS_CHIPS: { key: PortalStatusChip; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'awaiting', label: 'Awaiting your reply' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
  { key: 'rate', label: 'To rate' },
  { key: 'any', label: 'Any status' },
];

export const chipLabel = (key: PortalStatusChip) => PORTAL_STATUS_CHIPS.find((c) => c.key === key)?.label ?? key;

/** Exclusive status chips for the portal ticket list; `value` is null when the URL holds a status no chip stands for. Counts come from `GET /portal/tickets/stats`. */
export function StatusChips({ value, onChange, counts, className }: { value: PortalStatusChip | null; onChange: (v: PortalStatusChip) => void; counts?: Partial<Record<PortalStatusChip, number>>; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)} role="tablist" aria-label="Status">
      {PORTAL_STATUS_CHIPS.map((c) => {
        const active = value === c.key;
        const n = counts?.[c.key];
        const attention = (c.key === 'awaiting' || c.key === 'rate') && (n ?? 0) > 0 && !active;
        return (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`chip-${c.key}`}
            data-active={active || undefined}
            onClick={() => onChange(c.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors',
              active ? 'bg-brand-600 border-brand-600 text-white' : attention ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-default bg-surface text-muted hover:text-default hover:bg-surface-2',
            )}
          >
            {c.label}
            {n !== undefined && <span className={cn('rounded-full px-1.5 text-[11px] tabular-nums', active ? 'bg-white/20' : 'bg-surface-2')}>{n}</span>}
          </button>
        );
      })}
    </div>
  );
}
