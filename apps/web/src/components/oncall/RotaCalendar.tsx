import { useMemo } from 'react';
import { ChevronLeft, ChevronRight, Repeat } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { startOfWeek, addDays, ymd } from '@/components/field/VisitCalendar';
import type { Rota, Shift } from './api';

const hm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

/** A shift cut to one calendar day (local time). */
interface DayChip {
  shift: Shift;
  start: Date;
  end: Date;
  startsToday: boolean;
  endsToday: boolean;
}

/** Deterministic tone per person so the same name reads the same across the grid. */
const TONES = [
  'border-blue-300 bg-blue-50 text-blue-900',
  'border-emerald-300 bg-emerald-50 text-emerald-900',
  'border-violet-300 bg-violet-50 text-violet-900',
  'border-amber-300 bg-amber-50 text-amber-900',
  'border-teal-300 bg-teal-50 text-teal-900',
  'border-rose-300 bg-rose-50 text-rose-900',
  'border-indigo-300 bg-indigo-50 text-indigo-900',
  'border-sky-300 bg-sky-50 text-sky-900',
];
export const toneFor = (id: string | null) => {
  if (!id) return 'border-dashed border-default bg-surface-2 text-muted';
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length]!;
};

/**
 * Week grid: one row per rota, one column per day, a chip per shift segment
 * (the person, the hours when the segment does not cover the whole day, a
 * cover marker when an override decides it). Clicking a chip offers cover.
 */
export function RotaCalendar({ weekStart, rotas, shifts, onWeekChange, onSelect, loading }: { weekStart: Date; rotas: Rota[]; shifts: Shift[]; onWeekChange: (d: Date) => void; onSelect?: (shift: Shift, day: Date) => void; loading?: boolean }) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const today = ymd(new Date());
  const grid = useMemo(() => {
    const byRota = new Map<string, Record<string, DayChip[]>>();
    for (const s of shifts) {
      const start = new Date(s.start);
      const end = new Date(s.end);
      const row = byRota.get(s.rotaId) ?? {};
      for (const d of days) {
        const dayStart = d;
        const dayEnd = addDays(d, 1);
        const a = start > dayStart ? start : dayStart;
        const b = end < dayEnd ? end : dayEnd;
        if (b <= a) continue;
        (row[ymd(d)] ??= []).push({ shift: s, start: a, end: b, startsToday: a.getTime() > dayStart.getTime(), endsToday: b.getTime() < dayEnd.getTime() });
      }
      byRota.set(s.rotaId, row);
    }
    return byRota;
  }, [shifts, days]);
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
        <div className="flex items-center gap-3 text-[11.5px] text-muted">
          <span className="inline-flex items-center gap-1"><Repeat className="h-3 w-3" /> cover (override)</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-dashed border-default bg-surface-2" /> nobody</span>
          {loading && <span>· loading…</span>}
        </div>
      </div>
      <div className="overflow-auto">
        <div className="grid min-w-[900px]" style={{ gridTemplateColumns: '200px repeat(7, minmax(0, 1fr))' }}>
          <div className="px-3 py-2 text-[11.5px] uppercase tracking-wide text-subtle font-medium border-b border-default bg-surface-2">Rota</div>
          {days.map((d) => {
            const key = ymd(d);
            return (
              <div key={key} className={cn('px-2 py-2 text-center text-[12px] font-medium border-b border-l border-default bg-surface-2', key === today && 'text-brand-700')}>
                <div className="uppercase text-[10.5px] text-subtle">{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                <div>{d.getDate()}</div>
              </div>
            );
          })}
          {rotas.length === 0 && <div className="col-span-8 py-10 text-center text-[13px] text-muted">This team has no active rota yet.</div>}
          {rotas.map((r) => {
            const row = grid.get(r.id) ?? {};
            return (
              <div key={r.id} className="contents">
                <div className="px-3 py-2 border-b border-default text-[13px] flex flex-col justify-center">
                  <span className="font-medium truncate">{r.name}</span>
                  <span className="text-[11px] text-subtle truncate">{r.participants.length} in rotation · {r.timezone}</span>
                </div>
                {days.map((d) => {
                  const key = ymd(d);
                  const chips = row[key] ?? [];
                  return (
                    <div key={key} className={cn('min-h-[64px] p-1 border-b border-l border-default flex flex-col gap-1', key === today && 'bg-brand-50/40')}>
                      {chips.length === 0 && <span className="m-auto text-[11px] text-subtle">—</span>}
                      {chips.map((c, i) => (
                        <button
                          key={`${c.shift.start}-${i}`}
                          type="button"
                          onClick={onSelect ? () => onSelect(c.shift, d) : undefined}
                          className={cn('text-left rounded-md border px-1.5 py-1 text-[11.5px] leading-tight', toneFor(c.shift.userId), onSelect && 'hover:brightness-95 cursor-pointer')}
                          title={`${c.shift.userName ?? 'Nobody'} · ${hm(c.shift.start)} → ${hm(c.shift.end)}${c.shift.overrideId ? ' (cover)' : ''}`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="truncate font-medium">{c.shift.userName ?? 'Nobody on call'}</span>
                            {c.shift.overrideId && <Repeat className="h-3 w-3 shrink-0" aria-label="cover" />}
                          </div>
                          {(c.startsToday || c.endsToday) && (
                            <div className="font-mono opacity-75">{c.startsToday ? hm(c.start.toISOString()) : '00:00'} – {c.endsToday ? hm(c.end.toISOString()) : '24:00'}</div>
                          )}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
