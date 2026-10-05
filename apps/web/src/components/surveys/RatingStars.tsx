import { useState, type KeyboardEvent } from 'react';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CSAT_RATING_COLORS } from '@/lib/statusColors';
import { RATING_LABELS } from './api';

/** Ink for a filled star: the rating colour of the chosen value, so one star reads red and five read green. */
const STAR_INK: Record<string, string> = { red: 'text-red-500', orange: 'text-orange-500', amber: 'text-amber-500', green: 'text-emerald-500', emerald: 'text-emerald-600', slate: 'text-zinc-300' };
const starInk = (value: number | null | undefined) => STAR_INK[CSAT_RATING_COLORS[value ?? 0] ?? 'slate'] ?? STAR_INK.slate;
const SIZE = { sm: { btn: 'h-6 w-6', icon: 'h-3.5 w-3.5' }, md: { btn: 'h-8 w-8', icon: 'h-5 w-5' }, lg: { btn: 'h-11 w-11', icon: 'h-7 w-7' } };

/**
 * Five stars: a radio group when `onChange` is given (arrow keys move the selection, 44 px targets at `lg`
 * for phones and the public page), a plain read-only row otherwise.
 */
export function RatingStars({ value, onChange, size = 'md', readOnly, className, labels = true }: { value: number | null | undefined; onChange?: (v: number) => void; size?: 'sm' | 'md' | 'lg'; readOnly?: boolean; className?: string; labels?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const interactive = !!onChange && !readOnly;
  const shown = hover ?? value ?? 0;
  const ink = starInk(shown || null);
  const s = SIZE[size];
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, n: number) => {
    if (!interactive) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onChange!(Math.min(5, n + 1)); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onChange!(Math.max(1, n - 1)); }
  };
  return (
    <div className={cn('inline-flex items-center gap-0.5', className)} role={interactive ? 'radiogroup' : 'img'} aria-label={interactive ? 'Rating' : value ? `${value} out of 5, ${RATING_LABELS[value]}` : 'Not rated'} onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= shown;
        const star = <Star className={cn(s.icon, 'transition-colors', filled ? cn(ink, 'fill-current') : 'text-zinc-300')} aria-hidden />;
        if (!interactive) return <span key={n} className={cn('inline-flex items-center justify-center', s.btn)}>{star}</span>;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} out of 5, ${RATING_LABELS[n]}`}
            title={labels ? RATING_LABELS[n] : undefined}
            tabIndex={value ? (value === n ? 0 : -1) : n === 1 ? 0 : -1}
            onClick={() => onChange!(n)}
            onKeyDown={(e) => onKey(e, n)}
            onMouseEnter={() => setHover(n)}
            onFocus={() => setHover(null)}
            className={cn('inline-flex items-center justify-center rounded-lg hover:bg-surface-2 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-500/30 transition-colors', s.btn)}
          >
            {star}
          </button>
        );
      })}
    </div>
  );
}
