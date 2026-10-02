import { cn } from '@/lib/utils';
import type { StatusChip } from './api';

const CHIPS: { key: StatusChip; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'awaiting', label: 'Awaiting your reply' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
];

/** Pill filter for the portal ticket list; counts come from the list response. */
export function StatusChips({ value, onChange, counts, className }: { value: StatusChip; onChange: (v: StatusChip) => void; counts?: Partial<Record<StatusChip, number>>; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)} role="tablist">
      {CHIPS.map((c) => {
        const active = value === c.key;
        const n = counts?.[c.key];
        const attention = c.key === 'awaiting' && (n ?? 0) > 0 && !active;
        return (
          <button
            key={c.key}
            role="tab"
            aria-selected={active}
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
