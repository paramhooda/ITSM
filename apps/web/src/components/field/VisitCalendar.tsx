import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { STATUS_LABELS, type CalendarVisit, type VisitStatus } from './types';

const CHIP: Record<VisitStatus, string> = {
  requested: 'border-slate-300 bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-200 dark:border-slate-500/30',
  scheduled: 'border-blue-300 bg-blue-50 text-blue-800 dark:bg-blue-500/15 dark:text-blue-200 dark:border-blue-500/30',
  in_progress: 'border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30',
  completed: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-500/30',
  cancelled: 'border-gray-300 bg-gray-50 text-gray-500 line-through dark:bg-gray-500/10 dark:text-gray-400 dark:border-gray-500/30',
};

/** Monday of the week containing `d` (local time). */
export function startOfWeek(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow);
  return x;
}
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * Week grid: one row per engineer (plus "Unassigned"), one column per day.
 * Visits are chips coloured by status; clicking opens the visit.
 */
export function VisitCalendar({ weekStart, items, onWeekChange, onSelect, loading }: { weekStart: Date; items: CalendarVisit[]; onWeekChange: (d: Date) => void; onSelect: (id: string) => void; loading?: boolean }) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const today = ymd(new Date());
  const rows = useMemo(() => {
    const map = new Map<string, { id: string; name: string; byDay: Record<string, CalendarVisit[]>; total: number }>();
    const push = (key: string, name: string, v: CalendarVisit) => {
      const r = map.get(key) ?? { id: key, name, byDay: {}, total: 0 };
      const day = v.scheduledStart ? ymd(new Date(v.scheduledStart)) : '';
      (r.byDay[day] ??= []).push(v);
      r.total++;
      map.set(key, r);
    };
    for (const v of items) push(v.engineerId ?? 'unassigned', v.engineerName ?? 'Unassigned', v);
    return [...map.values()].sort((a, b) => (a.id === 'unassigned' ? 1 : b.id === 'unassigned' ? -1 : a.name.localeCompare(b.name)));
  }, [items]);
  const label = `${weekStart.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${addDays(weekStart, 6).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-default">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => onWeekChange(addDays(weekStart, -7))} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Button>
          <Button variant="ghost" size="sm" onClick={() => onWeekChange(startOfWeek(new Date()))}>Today</Button>
          <Button variant="ghost" size="icon" onClick={() => onWeekChange(addDays(weekStart, 7))} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Button>
          <span className="ml-2 text-[13px] font-medium">{label}</span>
        </div>
        <div className="flex items-center gap-2 text-[11.5px] text-muted">
          {(['scheduled', 'in_progress', 'completed', 'requested'] as VisitStatus[]).map((s) => (
            <span key={s} className="inline-flex items-center gap-1"><span className={cn('h-2.5 w-2.5 rounded-sm border', CHIP[s])} />{STATUS_LABELS[s]}</span>
          ))}
          {loading && <span>· loading…</span>}
        </div>
      </div>
      <div className="overflow-auto">
        <div className="grid min-w-[900px]" style={{ gridTemplateColumns: '180px repeat(7, minmax(0, 1fr))' }}>
          <div className="px-3 py-2 text-[11.5px] uppercase tracking-wide text-subtle font-medium border-b border-default bg-surface-2">Engineer</div>
          {days.map((d) => {
            const key = ymd(d);
            return (
              <div key={key} className={cn('px-2 py-2 text-center text-[12px] font-medium border-b border-l border-default bg-surface-2', key === today && 'text-brand-700 dark:text-brand-300')}>
                <div className="uppercase text-[10.5px] text-subtle">{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                <div>{d.getDate()}</div>
              </div>
            );
          })}
          {rows.length === 0 && <div className="col-span-8 py-10 text-center text-[13px] text-muted">No visits scheduled this week.</div>}
          {rows.map((r) => (
            <div key={r.id} className="contents">
              <div className="px-3 py-2 border-b border-default text-[13px] flex flex-col justify-center">
                <span className={cn('font-medium truncate', r.id === 'unassigned' && 'text-muted italic')}>{r.name}</span>
                <span className="text-[11px] text-subtle">{r.total} visit{r.total === 1 ? '' : 's'}</span>
              </div>
              {days.map((d) => {
                const key = ymd(d);
                const list = r.byDay[key] ?? [];
                return (
                  <div key={key} className={cn('min-h-[64px] p-1 border-b border-l border-default flex flex-col gap-1', key === today && 'bg-brand-50/40 dark:bg-brand-500/5')}>
                    {list.map((v) => (
                      <button key={v.id} onClick={() => onSelect(v.id)} className={cn('text-left rounded-md border px-1.5 py-1 text-[11.5px] leading-tight hover:brightness-95 dark:hover:brightness-125', CHIP[v.status])} title={`${v.number} · ${v.title}`}>
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-mono">{v.scheduledStart ? hm(v.scheduledStart) : ''}</span>
                          <span className="font-mono opacity-70">{v.number}</span>
                        </div>
                        <div className="truncate font-medium">{v.customerName ?? v.title}</div>
                        <div className="truncate opacity-80">{v.siteName ? `${v.siteName} · ` : ''}{v.typeLabel ?? v.title}</div>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
