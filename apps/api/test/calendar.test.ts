import { describe, it, expect } from 'vitest';
import { addWorkingMinutes, workingMinutesBetween, isWorkingTime, type CalendarDef, CALENDAR_24X7 } from '../src/lib/calendar';

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
