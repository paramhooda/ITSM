import { Star } from 'lucide-react';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { CSAT_RATING_COLORS } from '@/lib/statusColors';
import { RATING_LABELS } from './api';

/** "4/5" with a star glyph in the rating colour; lists and row lists use it. */
export function RatingBadge({ rating, className }: { rating: number | null | undefined; className?: string }) {
  if (rating == null) return <span className="text-subtle">—</span>;
  return (
    <Badge color={CSAT_RATING_COLORS[rating] ?? 'slate'} className={cn('gap-1 tnum', className)} title={RATING_LABELS[rating]}>
      <Star className="h-3 w-3 fill-current" aria-hidden /> {rating}/5
    </Badge>
  );
}
