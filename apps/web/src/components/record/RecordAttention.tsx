import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, AlertOctagon, Info, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type AttentionTone = 'bad' | 'warn' | 'info' | 'good';

export interface AttentionItem {
  /** Stable key for the flag (used for React keys and for tests). */
  key: string;
  tone: AttentionTone;
  /** One short clause: "Resolution SLA breached 3 h ago", "Unassigned for 2 days". */
  text: ReactNode;
  /** Optional one-click remedy: a route or a handler. */
  action?: { label: string; to?: string; onClick?: () => void };
  /** Hide the flag without removing it from the list (keeps call sites declarative). */
  hidden?: boolean;
}

const TONE: Record<AttentionTone, { icon: typeof AlertTriangle; rail: string; text: string; chip: string }> = {
  bad: { icon: AlertOctagon, rail: 'bg-red-500', text: 'text-red-700', chip: 'bg-red-50 text-red-700 border-red-200' },
  warn: { icon: AlertTriangle, rail: 'bg-amber-500', text: 'text-amber-700', chip: 'bg-amber-50 text-amber-800 border-amber-200' },
  info: { icon: Info, rail: 'bg-brand-500', text: 'text-brand-700', chip: 'bg-brand-50 text-brand-700 border-brand-200' },
  good: { icon: CheckCircle2, rail: 'bg-emerald-500', text: 'text-emerald-700', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};
const ORDER: AttentionTone[] = ['bad', 'warn', 'info', 'good'];

/**
 * "What needs my attention" strip for MSP staff and administrators, placed between the
 * record header and the form. Flags are sorted by severity and rendered as compact chips
 * with an optional one-click action, so the first glance at a record says what matters.
 * Renders nothing when there is nothing to flag (never an empty box).
 */
export function RecordAttention({ items, className, title = 'Needs attention' }: { items: AttentionItem[]; className?: string; title?: string }) {
  const shown = items.filter((i) => !i.hidden).sort((a, b) => ORDER.indexOf(a.tone) - ORDER.indexOf(b.tone));
  if (!shown.length) return null;
  const worst = shown[0]!.tone;
  return (
    <section className={cn('card relative overflow-hidden px-4 py-2.5', className)} aria-label={title} data-testid="record-attention">
      <span className={cn('absolute inset-y-0 left-0 w-[3px]', TONE[worst].rail)} aria-hidden />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted mr-1">{title}</span>
        {shown.map((it) => {
          const t = TONE[it.tone];
          const Icon = t.icon;
          return (
            <span key={it.key} className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 h-6 text-[12.5px] leading-none', t.chip)}>
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate max-w-[42ch]">{it.text}</span>
              {it.action && (it.action.to ? (
                <Link to={it.action.to} className="font-medium underline-offset-2 hover:underline whitespace-nowrap">{it.action.label}</Link>
              ) : (
                <button type="button" onClick={it.action.onClick} className="font-medium underline-offset-2 hover:underline whitespace-nowrap">{it.action.label}</button>
              ))}
            </span>
          );
        })}
      </div>
    </section>
  );
}
