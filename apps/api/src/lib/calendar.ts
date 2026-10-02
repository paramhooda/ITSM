import { DateTime } from 'luxon';

/**
 * Business calendar engine used for SLA calculations.
 *
 * A calendar is a timezone, weekly working intervals and a set of holiday
 * dates. Calculations iterate day by day, which is simple, exact and fast
 * enough for SLA targets measured in hours/days.
 */
export interface CalendarDef {
  timezone: string;
  is24x7: boolean;
  /** { mon: [["09:00","18:00"]], ... } (keys: mon..sun) */
  hours: Record<string, [string, string][]>;
  /** ISO dates (YYYY-MM-DD) */
  holidays: string[];
}

export const CALENDAR_24X7: CalendarDef = { timezone: 'UTC', is24x7: true, hours: {}, holidays: [] };

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MAX_DAYS = 800;

function parseHm(hm: string) {
  const [h, m] = hm.split(':').map((x) => parseInt(x, 10));
  return { h: h || 0, m: m || 0 };
}

/** Working intervals (as DateTime pairs) for the local calendar day containing `dt`. */
function intervalsForDay(dayStart: DateTime, cal: CalendarDef): [DateTime, DateTime][] {
  const key = DAY_KEYS[dayStart.weekday - 1];
  if (cal.holidays.includes(dayStart.toISODate()!)) return [];
  const spans = cal.hours[key] ?? [];
  return spans
    .map(([a, b]) => {
      const s = parseHm(a);
      const e = parseHm(b);
      const start = dayStart.set({ hour: s.h, minute: s.m, second: 0, millisecond: 0 });
      let end = dayStart.set({ hour: e.h, minute: e.m, second: 0, millisecond: 0 });
      if (e.h === 24 || (e.h === 0 && e.m === 0 && (s.h > 0 || s.m > 0))) end = dayStart.plus({ days: 1 }).startOf('day');
      return [start, end] as unknown as [DateTime, DateTime];
    })
    .filter(([s, e]) => e > s)
    .sort((x, y) => x[0].toMillis() - y[0].toMillis());
}

/** Adds `minutes` of working time to `start` according to the calendar. */
export function addWorkingMinutes(start: Date, minutes: number, cal: CalendarDef): Date {
  if (cal.is24x7 || minutes <= 0) return new Date(start.getTime() + minutes * 60_000);
  let remaining = minutes;
  let cursor: DateTime = DateTime.fromJSDate(start, { zone: cal.timezone });
  let day: DateTime = cursor.startOf("day");
  for (let i = 0; i < MAX_DAYS; i++) {
    for (const [s, e] of intervalsForDay(day, cal)) {
      if (e <= cursor) continue;
      const from = s > cursor ? s : cursor;
      const available = e.diff(from, 'minutes').minutes;
      if (available >= remaining) return from.plus({ minutes: remaining }).toJSDate();
      remaining -= available;
      cursor = e;
    }
    day = day.plus({ days: 1 });
    cursor = day;
  }
  // Calendar has no working time: fall back to elapsed time so a due date always exists.
  return new Date(start.getTime() + minutes * 60_000);
}

/** Working minutes elapsed between two instants. */
export function workingMinutesBetween(start: Date, end: Date, cal: CalendarDef): number {
  if (end <= start) return 0;
  if (cal.is24x7) return (end.getTime() - start.getTime()) / 60_000;
  const endDt = DateTime.fromJSDate(end, { zone: cal.timezone });
  let cursor: DateTime = DateTime.fromJSDate(start, { zone: cal.timezone });
  let day: DateTime = cursor.startOf("day");
  let total = 0;
  for (let i = 0; i < MAX_DAYS && day < endDt; i++) {
    for (const [s, e] of intervalsForDay(day, cal)) {
      if (e <= cursor) continue;
      const from = s > cursor ? s : cursor;
      const to = e < endDt ? e : endDt;
      if (to > from) total += to.diff(from, 'minutes').minutes;
      if (e >= endDt) return total;
    }
    day = day.plus({ days: 1 });
    cursor = day;
  }
  return total;
}

/** Is `at` inside working hours? */
export function isWorkingTime(at: Date, cal: CalendarDef): boolean {
  if (cal.is24x7) return true;
  const dt = DateTime.fromJSDate(at, { zone: cal.timezone });
  return intervalsForDay(dt.startOf('day'), cal).some(([s, e]) => dt >= s && dt < e);
}

export const DEFAULT_BUSINESS_HOURS: Record<string, [string, string][]> = {
  mon: [['09:00', '18:00']],
  tue: [['09:00', '18:00']],
  wed: [['09:00', '18:00']],
  thu: [['09:00', '18:00']],
  fri: [['09:00', '18:00']],
};
