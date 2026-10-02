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
  if (!delta || delta.deltaPct === null) return <span className="text-subtle inline-flex items-center gap-0.5"><Minus className="h-3 w-3" /> vs previous period</span>;
  const up = delta.deltaPct > 0;
  const good = lowerIsBetter ? !up : up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('inline-flex items-center gap-0.5 tnum', delta.deltaPct === 0 ? 'text-subtle' : good ? 'text-emerald-600' : 'text-red-600')} title={`Previous period: ${delta.previous ?? '—'}`}>
      <Icon className="h-3 w-3" /> {Math.abs(delta.deltaPct)}% vs previous
    </span>
  );
}

/** Hero row of at most four KPIs; the number is the chart. */
export function KpiGrid({ items, columns = 4 }: { items: KpiItem[]; columns?: 2 | 3 | 4 }) {
  const cols = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' }[columns];
  return (
    <div className={cn('grid grid-cols-2 gap-4', cols)}>
      {items.map((k, i) => (
        <StatTile key={i} label={k.label} value={k.value} tone={k.tone} onClick={k.onClick} hint={k.delta !== undefined ? <DeltaBadge delta={k.delta} lowerIsBetter={k.lowerIsBetter} /> : k.hint} />
      ))}
    </div>
  );
}
