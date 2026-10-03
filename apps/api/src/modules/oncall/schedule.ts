import { DateTime } from 'luxon';

/**
 * Pure rota arithmetic: who a rota puts on call at an instant and how a rota
 * expands into shifts over a range. Everything is computed in the rota's own
 * timezone from its start date and handoff time, so daylight-saving changes
 * move the handoff with the clock rather than by a fixed number of hours.
 */

export interface RotaDef {
  id: string;
  timezone: string;
  rotation: string;
  rotationDays: number;
  handoffTime: string;
  shiftStart: string | null;
  shiftEnd: string | null;
  /** YYYY-MM-DD, the first handoff */
  startDate: string;
}

export interface Participant {
  userId: string;
  position: number;
}

export interface OverrideDef {
  id: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
}

export interface Shift {
  rotaId: string;
  userId: string | null;
  start: Date;
  end: Date;
  /** Set when an override, not the rotation, decides the person. */
  overrideId: string | null;
  cycle: number | null;
}

export interface OnCallResolution {
  userId: string | null;
  override: OverrideDef | null;
  /** When the current person's cover ends (null when nobody is on call and nothing is scheduled). */
  until: Date | null;
  cycle: number;
}

export const ROTATIONS = ['weekly', 'daily', 'custom'] as const;
const MAX_SEGMENTS = 2000;

export const periodDays = (r: Pick<RotaDef, 'rotation' | 'rotationDays'>) => (r.rotation === 'daily' ? 1 : r.rotation === 'weekly' ? 7 : Math.max(1, Math.min(365, r.rotationDays || 7)));

const hm = (s: string | null | undefined) => {
  const [h, m] = String(s ?? '').split(':').map((x) => parseInt(x, 10));
  return { hour: Number.isFinite(h) ? Math.min(23, Math.max(0, h!)) : 0, minute: Number.isFinite(m) ? Math.min(59, Math.max(0, m!)) : 0 };
};

export const isValidZone = (zone: string) => DateTime.local().setZone(zone).isValid;
export const isHm = (s: unknown) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** The instant cycle `n` starts (cycle 0 begins on the start date at the handoff time). */
export function handoffAt(rota: RotaDef, n: number): DateTime {
  const base = DateTime.fromISO(rota.startDate, { zone: rota.timezone }).set({ ...hm(rota.handoffTime), second: 0, millisecond: 0 });
  return n === 0 ? base : base.plus({ days: n * periodDays(rota) });
}

/** Which cycle contains `at` (negative before the start date, so the rotation still resolves). */
export function cycleAt(rota: RotaDef, at: Date): number {
  const base = handoffAt(rota, 0);
  const days = DateTime.fromJSDate(at, { zone: rota.timezone }).diff(base, 'days').days;
  let n = Math.floor(days / periodDays(rota));
  for (let i = 0; i < 4 && handoffAt(rota, n + 1).toMillis() <= at.getTime(); i++) n++;
  for (let i = 0; i < 4 && handoffAt(rota, n).toMillis() > at.getTime(); i++) n--;
  return n;
}

const byPosition = (ps: Participant[]) => [...ps].sort((a, b) => a.position - b.position);

/** The participant the rotation puts on in cycle `n`. */
export function participantFor(participants: Participant[], n: number): string | null {
  const ps = byPosition(participants);
  if (!ps.length) return null;
  const idx = ((n % ps.length) + ps.length) % ps.length;
  return ps[idx]!.userId;
}

/** Local-day window [start, end) for the day containing `local`, or null when the rota has no window. */
function windowFor(rota: RotaDef, local: DateTime): [DateTime, DateTime] | null {
  if (!rota.shiftStart || !rota.shiftEnd) return null;
  const s = hm(rota.shiftStart);
  const e = hm(rota.shiftEnd);
  const day = local.startOf('day');
  const start = day.set(s);
  let end = day.set(e);
  if (end <= start) end = end.plus({ days: 1 });
  // An overnight window may have started yesterday.
  if (local < start) {
    const prevStart = start.minus({ days: 1 });
    const prevEnd = end.minus({ days: 1 });
    if (local >= prevStart && local < prevEnd) return [prevStart, prevEnd];
  }
  return [start, end];
}

export function inShiftWindow(rota: RotaDef, at: Date): boolean {
  const local = DateTime.fromJSDate(at, { zone: rota.timezone });
  const w = windowFor(rota, local);
  if (!w) return true;
  return local >= w[0] && local < w[1];
}

/** The override covering `at` (the one that started last wins when several overlap). */
export function overrideAt(overrides: OverrideDef[], at: Date): OverrideDef | null {
  const t = at.getTime();
  const hits = overrides.filter((o) => o.startsAt.getTime() <= t && o.endsAt.getTime() > t);
  if (!hits.length) return null;
  return hits.sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0]!;
}

/** Who the rota puts on call at `at`: an override first, then the rotation within the shift window. */
export function resolveOnCall(rota: RotaDef, participants: Participant[], overrides: OverrideDef[], at: Date): OnCallResolution {
  const cycle = cycleAt(rota, at);
  const o = overrideAt(overrides, at);
  if (o) return { userId: o.userId, override: o, until: o.endsAt, cycle };
  const local = DateTime.fromJSDate(at, { zone: rota.timezone });
  const w = windowFor(rota, local);
  if (w && !(local >= w[0] && local < w[1])) {
    // Outside the window: nobody until the next window opens.
    const next = local < w[0] ? w[0] : w[0].plus({ days: 1 });
    return { userId: null, override: null, until: next.toJSDate(), cycle };
  }
  const userId = participantFor(participants, cycle);
  const cycleEnd = handoffAt(rota, cycle + 1);
  const until = w ? (w[1] < cycleEnd ? w[1] : cycleEnd) : cycleEnd;
  return { userId, override: null, until: userId ? until.toJSDate() : null, cycle };
}

const clamp = (s: DateTime, e: DateTime, from: Date, to: Date): [Date, Date] | null => {
  const a = Math.max(s.toMillis(), from.getTime());
  const b = Math.min(e.toMillis(), to.getTime());
  return b > a ? [new Date(a), new Date(b)] : null;
};

/**
 * Expands a rota into shifts between `from` and `to`: rotation cycles, cut to
 * the daily window when there is one, with overrides laid on top (an override
 * replaces whatever the rotation says for its whole period).
 */
export function expandSchedule(rota: RotaDef, participants: Participant[], overrides: OverrideDef[], from: Date, to: Date): Shift[] {
  if (to <= from) return [];
  const base: Shift[] = [];
  const n0 = cycleAt(rota, from);
  for (let n = n0, guard = 0; guard < MAX_SEGMENTS; n++, guard++) {
    const start = handoffAt(rota, n);
    if (start.toMillis() >= to.getTime()) break;
    const end = handoffAt(rota, n + 1);
    const userId = participantFor(participants, n);
    if (!rota.shiftStart || !rota.shiftEnd) {
      const c = clamp(start, end, from, to);
      if (c) base.push({ rotaId: rota.id, userId, start: c[0], end: c[1], overrideId: null, cycle: n });
      continue;
    }
    // Daily windows inside the cycle.
    const first = start.startOf('day').minus({ days: 1 });
    for (let d = first, g = 0; d < end && g < MAX_SEGMENTS; d = d.plus({ days: 1 }), g++) {
      const w = windowFor(rota, d.set(hm(rota.shiftStart)))!;
      const ws = w[0] > start ? w[0] : start;
      const we = w[1] < end ? w[1] : end;
      if (we <= ws) continue;
      const c = clamp(ws, we, from, to);
      if (c) base.push({ rotaId: rota.id, userId, start: c[0], end: c[1], overrideId: null, cycle: n });
    }
  }
  // Overlay overrides: subtract each from the base segments, then add its own segment.
  let shifts = base;
  const inRange = overrides.filter((o) => o.endsAt > from && o.startsAt < to).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (const o of inRange) {
    const os = Math.max(o.startsAt.getTime(), from.getTime());
    const oe = Math.min(o.endsAt.getTime(), to.getTime());
    const next: Shift[] = [];
    for (const s of shifts) {
      const ss = s.start.getTime();
      const se = s.end.getTime();
      if (se <= os || ss >= oe) {
        next.push(s);
        continue;
      }
      if (ss < os) next.push({ ...s, end: new Date(os) });
      if (se > oe) next.push({ ...s, start: new Date(oe) });
    }
    next.push({ rotaId: rota.id, userId: o.userId, start: new Date(os), end: new Date(oe), overrideId: o.id, cycle: null });
    shifts = next;
  }
  return shifts.filter((s) => s.end > s.start).sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, MAX_SEGMENTS);
}
