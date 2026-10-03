import { DateTime } from 'luxon';

/**
 * Pure shift arithmetic. A shift is a local time window on given weekdays in
 * the team's timezone; `endTime` at or before `startTime` means the shift
 * crosses midnight and belongs to the day it starts on.
 */

export interface ShiftDef {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  days: number[];
  timezone: string;
  isActive?: boolean;
}

export interface ShiftInstance<T extends ShiftDef = ShiftDef> {
  shift: T;
  /** The local day the shift starts on (YYYY-MM-DD in the shift's timezone). */
  shiftDate: string;
  startsAt: Date;
  endsAt: Date;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isTime = (s: string) => TIME_RE.test(s);
export const isValidZone = (tz: string) => DateTime.local().setZone(tz).isValid;

const parts = (t: string) => {
  const m = TIME_RE.exec(t);
  if (!m) throw new Error(`Invalid time ${t}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
};

/** The instance of a shift that starts on `day` (a local date), or null when it does not run that weekday. */
export function instanceOn<T extends ShiftDef>(shift: T, day: DateTime): ShiftInstance<T> | null {
  if (!shift.days.includes(day.weekday)) return null;
  const s = parts(shift.startTime);
  const e = parts(shift.endTime);
  const start = day.set({ hour: s.hour, minute: s.minute, second: 0, millisecond: 0 });
  let end = day.set({ hour: e.hour, minute: e.minute, second: 0, millisecond: 0 });
  if (end <= start) end = end.plus({ days: 1 });
  return { shift, shiftDate: day.toISODate()!, startsAt: start.toJSDate(), endsAt: end.toJSDate() };
}

/** Every instance of the team's active shifts that overlaps [from, to], in start order. */
export function instancesBetween<T extends ShiftDef>(shifts: T[], from: Date, to: Date): ShiftInstance<T>[] {
  const out: ShiftInstance<T>[] = [];
  for (const shift of shifts) {
    if (shift.isActive === false || !isValidZone(shift.timezone)) continue;
    let day = DateTime.fromJSDate(from, { zone: shift.timezone }).startOf('day').minus({ days: 1 });
    const last = DateTime.fromJSDate(to, { zone: shift.timezone }).startOf('day');
    while (day <= last) {
      const inst = instanceOn(shift, day);
      if (inst && inst.endsAt > from && inst.startsAt < to) out.push(inst);
      day = day.plus({ days: 1 });
    }
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** The shift running at `at` (the one that started most recently when two overlap) and the next one to start. */
export function currentAndNext<T extends ShiftDef>(shifts: T[], at = new Date()): { current: ShiftInstance<T> | null; next: ShiftInstance<T> | null } {
  const window = instancesBetween(shifts, new Date(at.getTime() - 2 * 86_400_000), new Date(at.getTime() + 8 * 86_400_000));
  const running = window.filter((i) => i.startsAt <= at && i.endsAt > at);
  const current = running.sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0] ?? null;
  const next = window.find((i) => i.startsAt > at && (!current || i.shift.id !== current.shift.id || i.startsAt >= current.endsAt)) ?? null;
  return { current, next };
}

/** The most recent shift that has already ended at `at`: the one a late handover is for. */
export function previous<T extends ShiftDef>(shifts: T[], at = new Date()): ShiftInstance<T> | null {
  const window = instancesBetween(shifts, new Date(at.getTime() - 3 * 86_400_000), at);
  return window.filter((i) => i.endsAt <= at).sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0] ?? null;
}
