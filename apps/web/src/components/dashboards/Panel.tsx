import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Dashboard card: quiet title, optional one-line subtitle, optional "View all" link. */
export function Panel({ title, subtitle, action, to, toLabel = 'View all', children, className, padded = true }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; to?: string; toLabel?: string; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cn('card flex flex-col', className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-5 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-default leading-tight tracking-[-0.01em]">{title}</h2>
          {subtitle && <p className="text-[12.5px] text-muted mt-0.5">{subtitle}</p>}
        </div>
        {/* The controls wrap under the title on a narrow card instead of widening it (a Segmented and a link side by side can exceed a phone's width). */}
        <div className="flex flex-wrap items-center gap-2 max-w-full">
          {action}
          {to && <ViewAll to={to} label={toLabel} />}
        </div>
      </header>
      <div className={cn('flex-1 min-h-0', padded ? 'px-5 pb-5' : 'pb-1')}>{children}</div>
    </section>
  );
}

export function ViewAll({ to, label = 'View all' }: { to: string; label?: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-default whitespace-nowrap transition-colors">
      {label} <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  );
}

/** Pulsing placeholder bars so layouts do not jump while loading. */
export function Skeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('animate-pulse flex flex-col gap-2.5 py-1', className)} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-3 rounded-full bg-surface-3" style={{ width: `${88 - (i % 3) * 14}%` }} />
      ))}
    </div>
  );
}

export function KpiSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-5 animate-pulse" aria-hidden>
          <div className="h-3 w-24 rounded-full bg-surface-3" />
          <div className="h-7 w-16 rounded-md bg-surface-3 mt-3" />
          <div className="h-2.5 w-28 rounded-full bg-surface-3 mt-3" />
        </div>
      ))}
    </div>
  );
}

export interface RowItem {
  key: string;
  primary: ReactNode;
  secondary?: ReactNode;
  right?: ReactNode;
  href?: string;
  leading?: ReactNode;
}

/** Hairline-separated list rows: primary text, muted secondary line, right-aligned value. */
export function RowList({ items, empty = 'Nothing to show', dense }: { items: RowItem[]; empty?: ReactNode; dense?: boolean }) {
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="flex flex-col">
      {items.map((it) => {
        const body = (
          <>
            {it.leading && <span className="shrink-0 mt-0.5">{it.leading}</span>}
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] text-default font-medium truncate leading-snug">{it.primary}</span>
              {it.secondary && <span className="block text-[12.5px] text-muted truncate mt-0.5">{it.secondary}</span>}
            </span>
            {it.right !== undefined && <span className="shrink-0 text-[12.5px] text-muted tnum text-right">{it.right}</span>}
          </>
        );
        const cls = cn('flex items-start gap-3 border-b border-default last:border-b-0 -mx-5 px-5', dense ? 'py-2' : 'py-2.5', it.href && 'hover:bg-surface-2/70 transition-colors');
        return <li key={it.key}>{it.href ? <Link to={it.href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>}</li>;
      })}
    </ul>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-[13px] text-subtle py-6 text-center">{children}</div>;
}

/** Inline stat for "at a glance" strips. */
export function Stat({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: 'default' | 'good' | 'warn' | 'bad' }) {
  const cls = { default: 'text-default', good: 'text-emerald-600', warn: 'text-amber-600', bad: 'text-red-600' }[tone ?? 'default'];
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-muted truncate">{label}</div>
      <div className={cn('text-[18px] font-semibold tnum tracking-[-0.02em] mt-0.5', cls)}>{value}</div>
    </div>
  );
}

/** Segmented control (period, filters). */
export function Segmented<T extends string | number>({ options, value, onChange, size = 'md' }: { options: { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; size?: 'sm' | 'md' }) {
  return (
    <div className={cn('inline-flex items-center rounded-lg bg-surface-2 p-0.5 border border-default', size === 'sm' ? 'h-8' : 'h-9')}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn('inline-flex items-center gap-1.5 rounded-md px-3 h-full text-[12.5px] font-medium whitespace-nowrap transition-colors', value === o.value ? 'bg-white text-default shadow-[0_1px_2px_rgba(9,9,11,0.08)] border border-default' : 'text-muted hover:text-default border border-transparent')}
        >
          {o.label}
          {o.count !== undefined && <span className={cn('tnum text-[11.5px]', value === o.value ? 'text-muted' : 'text-subtle')}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Updated({ at, fetching }: { at?: string | Date | null; fetching?: boolean }) {
  if (!at) return null;
  const d = typeof at === 'string' ? new Date(at) : at;
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  return <span className="text-[12px] text-subtle tnum">{fetching ? 'Refreshing…' : s < 5 ? 'Updated just now' : s < 60 ? `Updated ${s}s ago` : `Updated ${Math.round(s / 60)}m ago`}</span>;
}
