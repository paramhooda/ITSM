import type { ReactNode } from 'react';
import { CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Segmented } from './Panel';

/** The one period control every home view shares: 7, 30 or 90 days (any other value from the URL is offered too). */
const PERIODS = [7, 30, 90];
export function PeriodPicker({ days, onChange, size = 'sm' }: { days: number; onChange: (d: number) => void; size?: 'sm' | 'md' }) {
  const options = PERIODS.includes(days) ? PERIODS : [...PERIODS, days].sort((a, b) => a - b);
  return <Segmented size={size} options={options.map((d) => ({ value: d, label: `${d} days` }))} value={days} onChange={onChange} />;
}

/**
 * The dashboard header: a soft colour wash with the greeting or view title, the date,
 * the view switcher on the right and the period (and scope) controls on a second line.
 * The same band heads the staff dashboards and the customer portal home.
 */
export function DashboardHero({ title, subtitle, right, children, className }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode; children?: ReactNode; className?: string }) {
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <section className={cn('relative overflow-hidden rounded-2xl border border-default bg-surface bg-hero mb-6 shadow-card', className)} data-testid="dashboard-hero">
      <div className="absolute inset-0 bg-dots opacity-40 pointer-events-none" aria-hidden />
      <div className="absolute -top-28 -right-20 h-64 w-64 rounded-full bg-grad-brand opacity-[0.14] blur-3xl pointer-events-none" aria-hidden />
      <div className="relative flex flex-wrap items-end justify-between gap-4 px-6 pt-5 pb-4">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted">
            <CalendarDays className="h-3.5 w-3.5 text-brand-500" />
            {today}
          </div>
          <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-[-0.025em] text-default">{title}</h1>
          {subtitle && <div className="text-[13.5px] text-muted mt-1">{subtitle}</div>}
        </div>
        {right && <div className="flex flex-wrap items-center gap-2 shrink-0">{right}</div>}
      </div>
      {children && (
        <div className="relative flex flex-wrap items-center gap-2 px-6 py-2.5 border-t border-[rgba(9,9,11,0.06)] bg-white/55">
          <span className="text-[12px] text-subtle mr-1">Period</span>
          {children}
        </div>
      )}
    </section>
  );
}
