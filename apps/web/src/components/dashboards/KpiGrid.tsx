import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { StatTile } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Delta } from './types';

export interface KpiItem {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  /** Period-over-period change; `lowerIsBetter` flips the colouring. */
  delta?: Delta | null;
  lowerIsBetter?: boolean;
  onClick?: () => void;
}

export function DeltaBadge({ delta, lowerIsBetter }: { delta?: Delta | null; lowerIsBetter?: boolean }) {
  if (!delta || delta.deltaPct === null) return <span className="text-subtle inline-flex items-center gap-0.5"><Minus className="h-3 w-3" /> vs prev.</span>;
  const up = delta.deltaPct > 0;
  const good = lowerIsBetter ? !up : up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('inline-flex items-center gap-0.5 tabular-nums', delta.deltaPct === 0 ? 'text-subtle' : good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')} title={`Previous period: ${delta.previous ?? '—'}`}>
      <Icon className="h-3 w-3" /> {Math.abs(delta.deltaPct)}% vs prev.
    </span>
  );
}

/** Dense grid of stat tiles; the number is the chart. */
export function KpiGrid({ items, columns = 6 }: { items: KpiItem[]; columns?: 3 | 4 | 5 | 6 }) {
  const cols = { 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4', 5: 'sm:grid-cols-3 lg:grid-cols-5', 6: 'sm:grid-cols-3 lg:grid-cols-6' }[columns];
  return (
    <div className={cn('grid grid-cols-2 gap-3', cols)}>
      {items.map((k, i) => (
        <StatTile key={i} label={k.label} value={k.value} tone={k.tone} onClick={k.onClick} hint={k.delta !== undefined ? <DeltaBadge delta={k.delta} lowerIsBetter={k.lowerIsBetter} /> : k.hint} />
      ))}
    </div>
  );
}
