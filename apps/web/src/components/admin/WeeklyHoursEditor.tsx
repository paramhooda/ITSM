import { Plus, X, Copy } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';

export type WeeklyHours = Record<string, [string, string][]>;

const DAYS: { key: string; label: string }[] = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

/** Per-day working ranges editor ({ mon: [["09:00","18:00"]], ... }). */
export function WeeklyHoursEditor({ value, onChange, disabled }: { value: WeeklyHours; onChange: (v: WeeklyHours) => void; disabled?: boolean }) {
  const setDay = (day: string, ranges: [string, string][]) => {
    const next = { ...value };
    if (ranges.length) next[day] = ranges;
    else delete next[day];
    onChange(next);
  };
  const copyToWeekdays = (day: string) => {
    const ranges = value[day] ?? [];
    const next = { ...value };
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri']) {
      if (ranges.length) next[d] = ranges.map((r) => [...r] as [string, string]);
      else delete next[d];
    }
    onChange(next);
  };
  return (
    <div className={cn('rounded-lg border border-default divide-y divide-[var(--border)]', disabled && 'opacity-60 pointer-events-none')}>
      {DAYS.map((d) => {
        const ranges = value[d.key] ?? [];
        const enabled = ranges.length > 0;
        return (
          <div key={d.key} className="flex flex-wrap items-start gap-3 px-3 py-2">
            <label className="flex items-center gap-2 w-28 shrink-0 pt-1 text-[13px] cursor-pointer select-none">
              <input type="checkbox" className="h-4 w-4 rounded border-default accent-brand-600" checked={enabled} onChange={(e) => setDay(d.key, e.target.checked ? [['09:00', '18:00']] : [])} />
              {d.label}
            </label>
            <div className="flex-1 flex flex-col gap-1.5 min-w-[240px]">
              {!enabled && <div className="text-[12.5px] text-subtle pt-1">Closed</div>}
              {ranges.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="time" className="input w-28 py-1" value={r[0]} onChange={(e) => setDay(d.key, ranges.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
                  <span className="text-subtle text-[12px]">to</span>
                  <input type="time" className="input w-28 py-1" value={r[1]} onChange={(e) => setDay(d.key, ranges.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
                  <button type="button" className="h-7 w-7 rounded-md text-subtle hover:text-red-600 hover:bg-surface-2 inline-flex items-center justify-center" title="Remove range" onClick={() => setDay(d.key, ranges.filter((_, j) => j !== i))}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            {enabled && (
              <div className="flex items-center gap-1 pt-0.5">
                <Button type="button" variant="ghost" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDay(d.key, [...ranges, [ranges[ranges.length - 1]?.[1] ?? '13:00', '18:00']])}>
                  Range
                </Button>
                <Button type="button" variant="ghost" size="sm" icon={<Copy className="h-3.5 w-3.5" />} title="Copy to Monday–Friday" onClick={() => copyToWeekdays(d.key)}>
                  Weekdays
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function summarizeHours(hours: WeeklyHours | null | undefined, is24x7?: boolean) {
  if (is24x7) return '24x7';
  if (!hours || !Object.keys(hours).length) return 'No working hours';
  const groups = new Map<string, string[]>();
  for (const d of DAYS) {
    const r = hours[d.key];
    if (!r?.length) continue;
    const sig = r.map((x) => `${x[0]}–${x[1]}`).join(', ');
    groups.set(sig, [...(groups.get(sig) ?? []), d.label.slice(0, 3)]);
  }
  return [...groups.entries()].map(([sig, days]) => `${days.length > 2 ? `${days[0]}–${days[days.length - 1]}` : days.join(', ')} ${sig}`).join('; ');
}
