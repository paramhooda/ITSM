import { useState, type ReactNode } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { KpiGrid, type KpiItem } from './KpiGrid';
import { KpiSkeleton } from './Panel';

const key = (id: string) => `itsm.insights.${id}`;

/**
 * The "stats and charts" band of a module page: a KPI row and a panel row that
 * reflect the filters above them and sit above the list. Collapsible, and it
 * remembers the choice per page.
 */
export function InsightBand({ id, summary, kpis, panels, loading, columns, className }: { id: string; summary?: ReactNode; kpis: KpiItem[]; panels?: ReactNode; loading?: boolean; columns?: 2 | 3 | 4 | 5; className?: string }) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key(id)) !== 'closed';
    } catch {
      return true;
    }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(key(id), next ? 'open' : 'closed');
    } catch {
      /* ignore */
    }
  };
  return (
    <section className={cn('flex flex-col gap-3', className)} aria-label="Insights">
      <button type="button" onClick={toggle} aria-expanded={open} className="group inline-flex items-center gap-2 self-start text-[12.5px] text-muted hover:text-default transition-colors">
        <Sparkles className="h-3.5 w-3.5 text-brand-600" />
        <span className="font-medium">Insights</span>
        {summary && <span className="text-subtle">· {summary}</span>}
        <ChevronDown className={cn('h-3.5 w-3.5 text-subtle transition-transform', !open && '-rotate-90')} />
      </button>
      {open && (
        <div className="flex flex-col gap-4">
          {loading && kpis.length === 0 ? <KpiSkeleton count={columns ?? 4} /> : <KpiGrid items={kpis} columns={columns} />}
          {panels && <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 [&>*:first-child]:lg:col-span-2">{panels}</div>}
        </div>
      )}
    </section>
  );
}
