import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, AlertTriangle, Ban, Gavel } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { startOfWeek, addDays, ymd } from '@/components/field/VisitCalendar';
import type { CalendarChange, Blackout, CalendarMeeting } from './api';

export type CalendarView = 'week' | 'month';

/** Chip tone by status category; a conflict adds a red ring, a blackout day an amber wash. */
const TONE: Record<string, string> = {
  new: 'bg-slate-100 text-slate-800 border-slate-200',
  open: 'bg-blue-50 text-blue-900 border-blue-200',
  pending: 'bg-amber-50 text-amber-900 border-amber-200',
  resolved: 'bg-emerald-50 text-emerald-900 border-emerald-200',
  closed: 'bg-zinc-100 text-zinc-600 border-zinc-200',
  cancelled: 'bg-zinc-100 text-zinc-500 border-zinc-200 line-through',
};
const RISK_DOT: Record<string, string> = { low: 'bg-emerald-500', medium: 'bg-amber-500', high: 'bg-red-500' };
const hhmm = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
export const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);

interface Segment {
  change: CalendarChange;
  start: Date;
  end: Date;
  startsToday: boolean;
  endsToday: boolean;
}

/** Cuts each window into one segment per day it touches. */
function segmentsByDay(items: CalendarChange[], days: Date[]) {
  const map = new Map<string, Segment[]>();
  for (const d of days) map.set(ymd(d), []);
  for (const c of items) {
    const start = new Date(c.scheduledStart);
    const end = c.scheduledEnd ? new Date(c.scheduledEnd) : new Date(start.getTime() + 3600_000);
    for (const d of days) {
      const ds = dayStart(d);
      const de = addDays(ds, 1);
      if (start >= de || end <= ds) continue;
      const a = start > ds ? start : ds;
      const b = end < de ? end : de;
      map.get(ymd(d))!.push({ change: c, start: a, end: b, startsToday: start >= ds, endsToday: end <= de });
    }
  }
  for (const list of map.values()) list.sort((x, y) => x.start.getTime() - y.start.getTime());
  return map;
}

function blackoutsByDay(blackouts: Blackout[], days: Date[]) {
  const map = new Map<string, Blackout[]>();
  for (const d of days) {
    const ds = dayStart(d);
    const de = addDays(ds, 1);
    map.set(ymd(d), blackouts.filter((b) => new Date(b.startsAt) < de && new Date(b.endsAt) > ds));
  }
  return map;
}

function meetingsByDay(meetings: CalendarMeeting[], days: Date[]) {
  const map = new Map<string, CalendarMeeting[]>();
  for (const d of days) map.set(ymd(d), []);
  for (const m of meetings) {
    const key = ymd(new Date(m.scheduledAt));
    map.get(key)?.push(m);
  }
  for (const list of map.values()) list.sort((x, y) => new Date(x.scheduledAt).getTime() - new Date(y.scheduledAt).getTime());
  return map;
}

/** A CAB meeting on its day: a small gavel pill that opens the meeting. */
function MeetingPill({ m, compact }: { m: CalendarMeeting; compact?: boolean }) {
  const when = new Date(m.scheduledAt);
  const title = `CAB · ${m.title}\n${when.toLocaleString()}\n${m.items} on the agenda${m.pending ? `, ${m.pending} pending` : ''}${m.status === 'closed' ? '\nClosed' : ''}`;
  return (
    <Link
      to={`/operations/cab/${m.id}`}
      title={title}
      className={cn('w-full rounded-md border border-default bg-surface-2 text-default px-1.5 py-0.5 text-[11px] inline-flex items-center gap-1 hover:border-strong hover:shadow-sm transition-shadow min-w-0', m.status === 'closed' && 'opacity-70')}
      data-testid="cab-pill"
    >
      <Gavel className="h-3 w-3 shrink-0 text-purple-700" />
      <span className="truncate">{compact ? `CAB · ${m.items}` : `CAB · ${m.title} · ${m.items} item${m.items === 1 ? '' : 's'}`}</span>
      {!compact && <span className="ml-auto tabular-nums opacity-70 shrink-0">{hhmm(when)}</span>}
    </Link>
  );
}

function Chip({ seg, compact, onSelect }: { seg: Segment; compact?: boolean; onSelect: (id: string) => void }) {
  const c = seg.change;
  const tone = TONE[c.status.category ?? 'open'] ?? TONE.open;
  const conflicts = c.conflicts.length;
  const title = `${c.number} · ${c.title}\n${c.customerName ?? ''}\n${new Date(c.scheduledStart).toLocaleString()}${c.scheduledEnd ? ` – ${new Date(c.scheduledEnd).toLocaleString()}` : ''}${conflicts ? `\n${c.conflicts.map((x) => x.text).join('\n')}` : ''}`;
  return (
    <button
      type="button"
      onClick={() => onSelect(c.ticketId)}
      title={title}
      className={cn('w-full text-left rounded-md border px-1.5 py-1 text-[11.5px] leading-tight hover:shadow-sm transition-shadow', tone, conflicts && 'ring-1 ring-red-400', !seg.startsToday && 'rounded-l-none border-l-0', !seg.endsToday && 'rounded-r-none border-r-0')}
      data-testid="change-chip"
    >
      <div className="flex items-center gap-1 min-w-0">
        {c.riskLevel && <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', RISK_DOT[c.riskLevel])} title={`Risk ${c.riskLevel}`} />}
        <span className="font-mono font-medium truncate">{c.number}</span>
        {conflicts > 0 && <AlertTriangle className="h-3 w-3 text-red-600 shrink-0" />}
        {c.changeType === 'emergency' && <span className="text-[10px] uppercase font-semibold text-red-700 shrink-0">Emer</span>}
      </div>
      {!compact && <div className="truncate">{c.title}</div>}
      {!compact && <div className="opacity-70 tabular-nums">{seg.startsToday ? hhmm(seg.start) : '…'} – {seg.endsToday ? hhmm(seg.end) : '…'}{c.customerName ? ` · ${c.customerName}` : ''}</div>}
    </button>
  );
}

function BlackoutBar({ b }: { b: Blackout }) {
  return (
    <div className="rounded-md border border-dashed border-amber-400 bg-amber-100/60 text-amber-900 px-1.5 py-0.5 text-[11px] inline-flex items-center gap-1 w-full" title={`${b.name}${b.reason ? ` · ${b.reason}` : ''}\n${new Date(b.startsAt).toLocaleString()} – ${new Date(b.endsAt).toLocaleString()}${b.allowEmergency ? '\nEmergency changes allowed' : ''}`}>
      <Ban className="h-3 w-3 shrink-0" />
      <span className="truncate">{b.name}{b.customerId ? '' : ' · all customers'}</span>
    </div>
  );
}

/**
 * The change calendar: a week of day columns with each window cut into per-day segments, or a
 * month grid with the first few chips per day. Blackout windows and CAB meetings are drawn above the chips.
 */
export function ChangeCalendar({ view, anchor, items, blackouts, meetings = [], onNavigate, onSelect, loading }: { view: CalendarView; anchor: Date; items: CalendarChange[]; blackouts: Blackout[]; meetings?: CalendarMeeting[]; onNavigate: (d: Date) => void; onSelect: (ticketId: string) => void; loading?: boolean }) {
  const today = ymd(new Date());
  const days = useMemo(() => {
    if (view === 'week') {
      const ws = startOfWeek(anchor);
      return Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    }
    const first = startOfMonth(anchor);
    const gridStart = startOfWeek(first);
    const last = addMonths(first, 1);
    const n = Math.ceil((addDays(last, 6).getTime() - gridStart.getTime()) / 86_400_000);
    const count = Math.min(42, Math.ceil(n / 7) * 7);
    return Array.from({ length: count }, (_, i) => addDays(gridStart, i));
  }, [view, anchor]);
  const segs = useMemo(() => segmentsByDay(items, days), [items, days]);
  const bl = useMemo(() => blackoutsByDay(blackouts, days), [blackouts, days]);
  const mt = useMemo(() => meetingsByDay(meetings, days), [meetings, days]);
  const label =
    view === 'week'
      ? `${days[0]!.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${days[6]!.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
      : anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const step = (n: number) => onNavigate(view === 'week' ? addDays(startOfWeek(anchor), 7 * n) : addMonths(startOfMonth(anchor), n));
  const month = anchor.getMonth();
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-default">
        <Button size="sm" variant="ghost" className="px-2" aria-label="Previous" onClick={() => step(-1)}><ChevronLeft className="h-4 w-4" /></Button>
        <Button size="sm" variant="outline" onClick={() => onNavigate(new Date())}>Today</Button>
        <Button size="sm" variant="ghost" className="px-2" aria-label="Next" onClick={() => step(1)}><ChevronRight className="h-4 w-4" /></Button>
        <span className="text-[13px] font-medium ml-1">{label}</span>
        {loading && <span className="text-[12px] text-subtle">loading…</span>}
        <span className="ml-auto text-[11.5px] text-subtle inline-flex items-center gap-3">
          <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-red-600" /> conflict</span>
          <span className="inline-flex items-center gap-1"><Ban className="h-3 w-3 text-amber-700" /> blackout</span>
          <span className="inline-flex items-center gap-1"><Gavel className="h-3 w-3 text-purple-700" /> CAB</span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className={cn('grid min-w-[900px]', view === 'week' ? 'grid-cols-7' : 'grid-cols-7')}>
          {days.slice(0, 7).map((d) => (
            <div key={`h-${ymd(d)}`} className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-subtle border-b border-default bg-surface-2">
              {d.toLocaleDateString(undefined, { weekday: 'short' })}
            </div>
          ))}
          {days.map((d) => {
            const key = ymd(d);
            const list = segs.get(key) ?? [];
            const bls = bl.get(key) ?? [];
            const mts = mt.get(key) ?? [];
            const isToday = key === today;
            const outside = view === 'month' && d.getMonth() !== month;
            const shown = view === 'week' ? list : list.slice(0, 3);
            return (
              <div key={key} className={cn('border-b border-r border-default p-1.5 flex flex-col gap-1', view === 'week' ? 'min-h-[320px]' : 'min-h-[96px]', isToday && 'bg-brand-50/40', bls.length && 'bg-amber-50/40', outside && 'opacity-50')} data-day={key}>
                <div className={cn('text-[11.5px] tabular-nums', isToday ? 'font-semibold text-brand-700' : 'text-muted')}>{d.getDate()}{view === 'week' ? ` ${d.toLocaleDateString(undefined, { month: 'short' })}` : ''}</div>
                {mts.map((m) => <MeetingPill key={m.id} m={m} compact={view === 'month'} />)}
                {bls.map((b) => <BlackoutBar key={b.id} b={b} />)}
                {shown.map((seg) => <Chip key={`${seg.change.ticketId}-${key}`} seg={seg} compact={view === 'month'} onSelect={onSelect} />)}
                {view === 'month' && list.length > 3 && <div className="text-[11px] text-subtle">+{list.length - 3} more</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
