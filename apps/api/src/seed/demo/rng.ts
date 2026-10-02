/**
 * Deterministic pseudo-random helpers for the demo dataset (mulberry32).
 * The same seed always yields the same sequence, so re-runs on a fresh
 * database produce identical data (relative to the run date).
 */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** Uniform [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  /** Float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error('pick from empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }
  /** Picks one entry according to its weight. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r < 0) return item;
    }
    return items[items.length - 1]![0];
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
  /** Picks `n` distinct items. */
  sample<T>(items: readonly T[], n: number): T[] {
    return this.shuffle(items).slice(0, Math.max(0, Math.min(n, items.length)));
  }
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);
export const addMinutes = (d: Date, m: number) => addMs(d, m * MINUTE);
export const addDays = (d: Date, days: number) => addMs(d, days * DAY);
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const minDate = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);
export const maxDate = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

/** Civil date arithmetic on YYYY-MM-DD strings. */
export const shiftDate = (d: string, days: number) => isoDate(addDays(new Date(`${d}T00:00:00Z`), days));

const IST_OFFSET_MIN = 330;

/** Sets the IST wall-clock time of a UTC instant's calendar day. */
export function atIst(d: Date, hour: number, minute = 0): Date {
  const local = new Date(d.getTime() + IST_OFFSET_MIN * MINUTE);
  local.setUTCHours(hour, minute, 0, 0);
  return new Date(local.getTime() - IST_OFFSET_MIN * MINUTE);
}

export function istWeekday(d: Date): number {
  return new Date(d.getTime() + IST_OFFSET_MIN * MINUTE).getUTCDay(); // 0 = Sunday
}

/** Random instant on the IST calendar day of `d`, biased to business hours unless `anyHour`. */
export function randomTimeOfDay(rng: Rng, d: Date, anyHour = false): Date {
  const hour = anyHour ? rng.int(0, 23) : rng.weighted<number>([[9, 2], [10, 4], [11, 5], [12, 4], [13, 3], [14, 4], [15, 4], [16, 4], [17, 3], [18, 1], [8, 1], [20, 0.5]]);
  return atIst(d, hour, rng.int(0, 59));
}

/** Short deterministic hash → hex (serial numbers, MAC addresses). */
export function hashHex(input: string, length = 8): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let out = '';
  let x = h;
  while (out.length < length) {
    out += (x >>> 0).toString(16).padStart(8, '0');
    x = Math.imul(x ^ (x >>> 13), 0x5bd1e995) >>> 0;
  }
  return out.slice(0, length).toUpperCase();
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
