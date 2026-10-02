import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export function initials(name?: string | null) {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function truncate(s: string | null | undefined, n = 80) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Tailwind colour classes for configurable option colours: soft tint, saturated ink. */
export const COLOR_CLASSES: Record<string, string> = {
  red: 'bg-red-50 text-red-700',
  orange: 'bg-orange-50 text-orange-700',
  amber: 'bg-amber-50 text-amber-700',
  yellow: 'bg-yellow-50 text-yellow-700',
  green: 'bg-emerald-50 text-emerald-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  teal: 'bg-teal-50 text-teal-700',
  cyan: 'bg-cyan-50 text-cyan-700',
  sky: 'bg-sky-50 text-sky-700',
  blue: 'bg-blue-50 text-blue-700',
  indigo: 'bg-indigo-50 text-indigo-700',
  violet: 'bg-violet-50 text-violet-700',
  purple: 'bg-purple-50 text-purple-700',
  rose: 'bg-rose-50 text-rose-700',
  lime: 'bg-lime-50 text-lime-700',
  slate: 'bg-zinc-100 text-zinc-600',
  gray: 'bg-zinc-100 text-zinc-600',
};
export const colorClass = (c?: string | null) => COLOR_CLASSES[c ?? ''] ?? COLOR_CLASSES.slate;

/** Solid dot / accent colours for the same option palette (charts, timeline markers). */
export const COLOR_DOT: Record<string, string> = {
  red: 'bg-red-500', orange: 'bg-orange-500', amber: 'bg-amber-500', yellow: 'bg-yellow-500', green: 'bg-emerald-500', emerald: 'bg-emerald-500', teal: 'bg-teal-500', cyan: 'bg-cyan-500', sky: 'bg-sky-500', blue: 'bg-blue-500', indigo: 'bg-indigo-500', violet: 'bg-violet-500', purple: 'bg-purple-500', rose: 'bg-rose-500', lime: 'bg-lime-500', slate: 'bg-zinc-400', gray: 'bg-zinc-400',
};
export const dotClass = (c?: string | null) => COLOR_DOT[c ?? ''] ?? COLOR_DOT.slate;
