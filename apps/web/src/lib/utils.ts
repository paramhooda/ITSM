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

/** Tailwind colour classes for configurable option colours. */
export const COLOR_CLASSES: Record<string, string> = {
  red: 'bg-red-100 text-red-800',
  orange: 'bg-orange-100 text-orange-800',
  amber: 'bg-amber-100 text-amber-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  green: 'bg-emerald-100 text-emerald-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  teal: 'bg-teal-100 text-teal-800',
  cyan: 'bg-cyan-100 text-cyan-800',
  sky: 'bg-sky-100 text-sky-800',
  blue: 'bg-blue-100 text-blue-800',
  indigo: 'bg-indigo-100 text-indigo-800',
  violet: 'bg-violet-100 text-violet-800',
  purple: 'bg-purple-100 text-purple-800',
  rose: 'bg-rose-100 text-rose-800',
  lime: 'bg-lime-100 text-lime-800',
  slate: 'bg-slate-100 text-slate-600',
  gray: 'bg-gray-100 text-gray-600',
};
export const colorClass = (c?: string | null) => COLOR_CLASSES[c ?? ''] ?? COLOR_CLASSES.slate;
