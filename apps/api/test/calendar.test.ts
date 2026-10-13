import { describe, it, expect } from 'vitest';
import { addWorkingMinutes, workingMinutesBetween, isWorkingTime, type CalendarDef, CALENDAR_24X7 } from '../src/lib/calendar';
import { ukBankHolidays, easterSunday, holidaysFor, INDIA_MOVABLE } from '../src/seed/holidays';

const biz: CalendarDef = {
  timezone: 'Asia/Kolkata',
  is24x7: false,
  hours: { mon: [['09:00', '18:00']], tue: [['09:00', '18:00']], wed: [['09:00', '18:00']], thu: [['09:00', '18:00']], fri: [['09:00', '18:00']] },
  holidays: ['2026-10-02'],
};

// 2026-10-01 is a Thursday. 09:00 IST = 03:30Z
const thu0900 = new Date('2026-10-01T03:30:00Z');

describe('business calendar', () => {
  it('24x7 adds elapsed minutes', () => {
    expect(addWorkingMinutes(thu0900, 90, CALENDAR_24X7).toISOString()).toBe('2026-10-01T05:00:00Z'.replace('Z', '.000Z'));
  });

  it('adds working minutes within a day', () => {
    expect(addWorkingMinutes(thu0900, 120, biz).toISOString()).toBe('2026-10-01T05:30:00.000Z');
  });

  it('rolls over the holiday and weekend to Monday', () => {
    // 8h on Thu uses the whole day (09-18 = 9h, so 8h ends 17:00). 10h spills 1h into next working day.
    // Fri 2026-10-02 is a holiday, Sat/Sun off => Monday 2026-10-05 09:00 + 1h = 10:00 IST = 04:30Z
    expect(addWorkingMinutes(thu0900, 600, biz).toISOString()).toBe('2026-10-05T04:30:00.000Z');
  });

  it('starts counting from the next working period when started outside hours', () => {
    const thu2000 = new Date('2026-10-01T14:30:00Z'); // 20:00 IST
    expect(addWorkingMinutes(thu2000, 60, biz).toISOString()).toBe('2026-10-05T04:30:00.000Z');
  });

  it('measures elapsed working minutes', () => {
    const monday1000 = new Date('2026-10-05T04:30:00Z');
    expect(workingMinutesBetween(thu0900, monday1000, biz)).toBe(600);
    expect(workingMinutesBetween(thu0900, new Date('2026-10-01T05:30:00Z'), biz)).toBe(120);
    expect(workingMinutesBetween(thu0900, thu0900, biz)).toBe(0);
  });

  it('detects working time', () => {
    expect(isWorkingTime(thu0900, biz)).toBe(true);
    expect(isWorkingTime(new Date('2026-10-01T14:30:00Z'), biz)).toBe(false);
    expect(isWorkingTime(new Date('2026-10-02T05:00:00Z'), biz)).toBe(false); // holiday
  });

  it('falls back to elapsed time when the calendar has no hours', () => {
    const empty: CalendarDef = { timezone: 'UTC', is24x7: false, hours: {}, holidays: [] };
    expect(addWorkingMinutes(thu0900, 30, empty).getTime()).toBe(thu0900.getTime() + 30 * 60_000);
  });
});

describe('seeded holiday rules', () => {
  const dates = (year: number) => ukBankHolidays(year).map((h) => h.date);

  it('computes the England and Wales bank holidays of 2026 and 2027 by rule, substitutes included', () => {
    expect(dates(2026)).toEqual(['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28']);
    // Christmas Day falls on a Saturday and Boxing Day on a Sunday: Monday 27 and Tuesday 28 are the substitute days.
    expect(dates(2027)).toEqual(['2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28']);
    expect(ukBankHolidays(2027).filter((h) => h.name.includes('substitute')).map((h) => h.date)).toEqual(['2027-12-27', '2027-12-28']);
  });

  it('places the 2028 Easter in a leap year and substitutes a Saturday New Year', () => {
    expect(easterSunday(2028)).toBe('2028-04-16');
    expect(dates(2028)).toEqual(['2028-01-03', '2028-04-14', '2028-04-17', '2028-05-01', '2028-05-29', '2028-08-28', '2028-12-25', '2028-12-26']);
    expect(ukBankHolidays([2026, 2027])).toHaveLength(16);
  });

  it('keeps Boxing Day on Monday 26 and moves the Christmas substitute to Tuesday 27 when Christmas Day is a Sunday', () => {
    const late = (year: number) => ukBankHolidays(year).filter((h) => h.date >= `${year}-12-20`);
    expect(late(2033)).toEqual([{ date: '2033-12-26', name: 'Boxing Day' }, { date: '2033-12-27', name: 'Christmas Day (substitute day)' }]);
    expect(late(2022)).toEqual([{ date: '2022-12-26', name: 'Boxing Day' }, { date: '2022-12-27', name: 'Christmas Day (substitute day)' }]);
  });

  it('gives India the four fixed dates for any year plus the movable table where it has the year', () => {
    expect(holidaysFor([2026]).map((h) => h.date)).toEqual(['2026-01-26', '2026-03-04', '2026-03-21', '2026-08-15', '2026-10-02', '2026-10-20', '2026-11-08', '2026-12-25']);
    expect(holidaysFor([2040])).toHaveLength(4);
    for (const rows of Object.values(INDIA_MOVABLE)) expect(rows.map(([, name]) => name).sort()).toEqual(['Diwali', 'Dussehra', 'Eid al-Fitr', 'Holi']);
  });
});
