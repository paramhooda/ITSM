import { useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * Record page skeleton: header on top, the form and related lists in the main column,
 * a sticky rail on the right for the activity stream and context.
 */
export function RecordLayout({ header, main, aside, asideWidth = 380, className }: { header: ReactNode; main: ReactNode; aside?: ReactNode; asideWidth?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3 max-w-[1560px]', className)}>
      {header}
      <div className="grid grid-cols-1 gap-3 items-start" style={aside ? { gridTemplateColumns: `minmax(0, 1fr) min(${asideWidth}px, 100%)` } : undefined}>
        <div className="min-w-0 flex flex-col gap-3">{main}</div>
        {aside && <aside className="min-w-0 xl:sticky xl:top-4 flex flex-col gap-3">{aside}</aside>}
      </div>
    </div>
  );
}

export interface RailTab {
  key: string;
  label: string;
  icon: LucideIcon;
  content: ReactNode;
  badge?: number | string | null;
  hidden?: boolean;
}

/** Icon-tabbed right rail (Activity · Details · Assist), like a workspace side panel. */
export function RailTabs({ tabs, defaultTab, className }: { tabs: RailTab[]; defaultTab?: string; className?: string }) {
  const visible = tabs.filter((t) => !t.hidden);
  const [active, setActive] = useState(defaultTab ?? visible[0]?.key ?? '');
  const current = visible.find((t) => t.key === active) ?? visible[0];
  if (!current) return null;
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="inline-flex items-center gap-1 rounded-lg bg-surface-2 p-0.5 border border-default self-start">
        {visible.map((t) => (
          <Tooltip key={t.key} label={t.label} side="bottom">
            <button
              type="button"
              onClick={() => setActive(t.key)}
              aria-pressed={current.key === t.key}
              aria-label={t.label}
              className={cn('relative inline-flex items-center gap-1.5 rounded-md px-2.5 h-7 text-[12.5px] font-medium transition-colors', current.key === t.key ? 'bg-white text-default shadow-[0_1px_2px_rgba(9,9,11,0.08)] border border-default' : 'text-muted hover:text-default border border-transparent')}
            >
              <t.icon className="h-3.5 w-3.5" />
              <span className="hidden 2xl:inline">{t.label}</span>
              {t.badge !== undefined && t.badge !== null && t.badge !== 0 && <span className="tnum text-[11px] text-subtle">{t.badge}</span>}
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="min-w-0 flex flex-col gap-3">{current.content}</div>
    </div>
  );
}

/** Small context card for the rail: quiet title, optional action, dense body. */
export function RailCard({ title, action, children, className, padded = true }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cn('card', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-2 px-4 py-2 border-b border-default">
          <h3 className="text-[12.5px] font-semibold text-default flex items-center gap-1.5 min-w-0 truncate">{title}</h3>
          {action}
        </header>
      )}
      <div className={cn(padded && 'px-4 py-3')}>{children}</div>
    </section>
  );
}

/** Rows for the rail: label left, value right, one line each. */
export function RailRows({ rows }: { rows: { label: ReactNode; value: ReactNode; hidden?: boolean }[] }) {
  const shown = rows.filter((r) => !r.hidden);
  if (!shown.length) return null;
  return (
    <dl className="flex flex-col">
      {shown.map((r, i) => (
        <div key={i} className="flex items-start justify-between gap-3 py-1 text-[12.5px] border-b border-default/60 last:border-b-0">
          <dt className="text-muted shrink-0">{r.label}</dt>
          <dd className="text-default text-right min-w-0 break-words">{r.value === null || r.value === undefined || r.value === '' ? <span className="text-subtle">—</span> : r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
