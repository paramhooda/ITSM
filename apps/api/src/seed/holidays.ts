/**
 * Holiday tables shared by the default seed and the demo dataset.
 *
 * India: four fixed-date national holidays computed for any year, plus the
 * movable (lunar) holidays as the one literal table in the seeds, kept for
 * 2026–2030 and checked against the published central-government lists. A year
 * outside the table contributes the fixed dates only; nothing fails.
 *
 * United Kingdom: the England and Wales bank holidays computed by rule (New
 * Year's Day, Good Friday and Easter Monday from the Gregorian Easter, the early
 * May, spring and summer Mondays, Christmas Day and Boxing Day with weekend
 * substitutes). One-off proclaimed holidays are outside the rule and the seed.
 */

export const INDIA_HOLIDAY_CALENDAR = 'India Public Holidays';
export const UK_HOLIDAY_CALENDAR = 'UK Bank Holidays';

export type HolidayRow = { date: string; name: string };

/** Fixed-date Indian national holidays as [MM-DD, name]. */
export const INDIA_FIXED: readonly [string, string][] = [
  ['01-26', 'Republic Day'],
  ['08-15', 'Independence Day'],
  ['10-02', 'Gandhi Jayanti'],
  ['12-25', 'Christmas Day'],
];

/** Movable Indian holidays by year as [MM-DD, name]; the gazetted dates for Delhi where published, otherwise the widely listed dates. */
export const INDIA_MOVABLE: Record<number, readonly [string, string][]> = {
  2026: [['03-04', 'Holi'], ['03-21', 'Eid al-Fitr'], ['10-20', 'Dussehra'], ['11-08', 'Diwali']],
  2027: [['03-10', 'Eid al-Fitr'], ['03-23', 'Holi'], ['10-09', 'Dussehra'], ['10-29', 'Diwali']],
  2028: [['02-27', 'Eid al-Fitr'], ['03-11', 'Holi'], ['09-27', 'Dussehra'], ['10-17', 'Diwali']],
  2029: [['02-15', 'Eid al-Fitr'], ['03-01', 'Holi'], ['10-16', 'Dussehra'], ['11-05', 'Diwali']],
  2030: [['02-04', 'Eid al-Fitr'], ['03-20', 'Holi'], ['10-06', 'Dussehra'], ['10-26', 'Diwali']],
};

/** Indian holidays for the given years: the fixed dates for every year plus the movable table where it has the year. */
export function holidaysFor(years: readonly number[]): HolidayRow[] {
  const rows: HolidayRow[] = [];
  for (const y of years) {
    for (const [md, name] of INDIA_FIXED) rows.push({ date: `${y}-${md}`, name });
    for (const [md, name] of INDIA_MOVABLE[y] ?? []) rows.push({ date: `${y}-${md}`, name });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const weekdayOf = (s: string) => new Date(`${s}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const plusDays = (s: string, days: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** Easter Sunday by the anonymous Gregorian algorithm. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** The next weekday on or after `s` that is not in `taken` (weekend substitutes). */
function substitute(s: string, taken: Set<string>): string {
  let d = s;
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6 || taken.has(d)) d = plusDays(d, 1);
  return d;
}

function nthMonday(year: number, month: number, nth: 1 | 'last'): string {
  if (nth === 'last') {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    let d = iso(year, month, lastDay);
    while (weekdayOf(d) !== 1) d = plusDays(d, -1);
    return d;
  }
  let d = iso(year, month, 1);
  while (weekdayOf(d) !== 1) d = plusDays(d, 1);
  return d;
}

/** England and Wales bank holidays of one year (eight rows) or of several years, computed by rule. */
export function ukBankHolidays(years: number | readonly number[]): HolidayRow[] {
  const list = typeof years === 'number' ? [years] : years;
  const rows: HolidayRow[] = [];
  for (const y of list) {
    const taken = new Set<string>();
    const add = (date: string, name: string) => {
      taken.add(date);
      rows.push({ date, name });
    };
    const newYear = substitute(iso(y, 1, 1), taken);
    add(newYear, newYear === iso(y, 1, 1) ? "New Year's Day" : "New Year's Day (substitute day)");
    const easter = easterSunday(y);
    add(plusDays(easter, -2), 'Good Friday');
    add(plusDays(easter, 1), 'Easter Monday');
    add(nthMonday(y, 5, 1), 'Early May bank holiday');
    add(nthMonday(y, 5, 'last'), 'Spring bank holiday');
    add(nthMonday(y, 8, 'last'), 'Summer bank holiday');
    // A day that falls on a weekday keeps its date; substitutes take the next free weekday after it. When Christmas Day
    // is a Sunday, Boxing Day keeps Monday 26 and the Christmas substitute is Tuesday 27 (the published convention).
    const weekend = (s: string) => weekdayOf(s) === 0 || weekdayOf(s) === 6;
    if (!weekend(iso(y, 12, 26))) taken.add(iso(y, 12, 26));
    const christmas = substitute(iso(y, 12, 25), taken);
    add(christmas, christmas === iso(y, 12, 25) ? 'Christmas Day' : 'Christmas Day (substitute day)');
    taken.delete(iso(y, 12, 26));
    const boxing = substitute(iso(y, 12, 26), taken);
    add(boxing, boxing === iso(y, 12, 26) ? 'Boxing Day' : 'Boxing Day (substitute day)');
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
