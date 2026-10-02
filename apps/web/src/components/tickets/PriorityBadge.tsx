import { Badge } from '@/components/ui';
import type { OptionLabel } from './types';

const LEVEL_COLORS: Record<number, string> = { 1: 'red', 2: 'orange', 3: 'amber', 4: 'blue', 5: 'slate' };

/** Priority chip: colour from the option, falling back to the numeric level. */
export function PriorityBadge({ priority, className, compact }: { priority: OptionLabel | null | undefined; className?: string; compact?: boolean }) {
  if (!priority) return <span className="text-subtle text-xs">—</span>;
  const color = priority.color ?? (priority.level ? LEVEL_COLORS[priority.level] : null) ?? 'slate';
  const label = compact ? priority.label.split(' ')[0] : priority.label;
  return (
    <Badge color={color} className={className} title={priority.label}>
      {label}
    </Badge>
  );
}
