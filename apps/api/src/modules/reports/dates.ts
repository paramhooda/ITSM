import { ValidationError } from '@/core/errors';

/** Date range presets understood by schedules and the report runner. */
export const DATE_RANGE_PRESETS = ['last_day', 'last_7_days', 'last_30_days', 'last_90_days', 'month_to_date', 'last_month', 'quarter_to_date', 'last_quarter', 'year_to_date', 'custom'] as const;
export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export interface DateRange {
  /** Inclusive first day (YYYY-MM-DD). */
  from: string;
  /** Inclusive last day (YYYY-MM-DD). */
  to: string;
  preset: DateRangePreset;
  label: string;
}

const DAY = 86_400_000;
export const toDay = (d: Date) => d.toISOString().slice(0, 10);
export const parseDay = (s: string) => {
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(t)) throw new ValidationError(`Invalid date: ${s}`);
  return new Date(t);
};
export const addDays = (s: string, n: number) => toDay(new Date(parseDay(s).getTime() + n * DAY));
export const daysBetween = (from: string, to: string) => Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / DAY);

/** "Today" in a timezone (the schedule's), as YYYY-MM-DD. */
export function todayIn(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return toDay(now);
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const quarterStart = (day: string) => {
  const m = Number(day.slice(5, 7));
  const qm = Math.floor((m - 1) / 3) * 3 + 1;
  return `${day.slice(0, 4)}-${String(qm).padStart(2, '0')}-01`;
};
const addMonths = (day: string, n: number) => {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) - 1 + n;
  const d = new Date(Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12, 1));
  return toDay(d);
};

/**
 * Resolves a preset (or explicit from/to) into an inclusive day range.
 * Ranges are relative to `today` (the caller's/schedule's timezone).
 */
export function resolveDateRange(preset: string | undefined, custom: { from?: string | null; to?: string | null } = {}, today = toDay(new Date())): DateRange {
  const p = (preset && (DATE_RANGE_PRESETS as readonly string[]).includes(preset) ? preset : custom.from || custom.to ? 'custom' : 'last_30_days') as DateRangePreset;
  const yesterday = addDays(today, -1);
  switch (p) {
    case 'last_day':
      return { from: yesterday, to: yesterday, preset: p, label: `Yesterday (${yesterday})` };
    case 'last_7_days':
      return { from: addDays(today, -6), to: today, preset: p, label: `Last 7 days (${addDays(today, -6)} to ${today})` };
    case 'last_30_days':
      return { from: addDays(today, -29), to: today, preset: p, label: `Last 30 days (${addDays(today, -29)} to ${today})` };
    case 'last_90_days':
      return { from: addDays(today, -89), to: today, preset: p, label: `Last 90 days (${addDays(today, -89)} to ${today})` };
    case 'month_to_date':
      return { from: monthStart(today), to: today, preset: p, label: `Month to date (${monthStart(today)} to ${today})` };
    case 'last_month': {
      const start = addMonths(monthStart(today), -1);
      const end = addDays(monthStart(today), -1);
      return { from: start, to: end, preset: p, label: `${start.slice(0, 7)} (${start} to ${end})` };
    }
    case 'quarter_to_date':
      return { from: quarterStart(today), to: today, preset: p, label: `Quarter to date (${quarterStart(today)} to ${today})` };
    case 'last_quarter': {
      const start = addMonths(quarterStart(today), -3);
      const end = addDays(quarterStart(today), -1);
      return { from: start, to: end, preset: p, label: `Last quarter (${start} to ${end})` };
    }
    case 'year_to_date':
      return { from: `${today.slice(0, 4)}-01-01`, to: today, preset: p, label: `Year to date (${today.slice(0, 4)}-01-01 to ${today})` };
    case 'custom': {
      const from = custom.from ? toDay(parseDay(custom.from)) : addDays(custom.to ? toDay(parseDay(custom.to)) : today, -29);
      const to = custom.to ? toDay(parseDay(custom.to)) : today;
      if (parseDay(from) > parseDay(to)) throw new ValidationError('from must be on or before to');
      if (daysBetween(from, to) > 731) throw new ValidationError('Date range cannot exceed two years');
      return { from, to, preset: p, label: `${from} to ${to}` };
    }
  }
}
