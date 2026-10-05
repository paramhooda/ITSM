import type { OptionLabel } from '@/components/tickets/types';
import type { CardPriority, CardStatus } from './api';

/** "3d", "5h", "12m": the age of a card from its minutes. */
export function shortAge(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "in 2h", "1d" (for "overdue 1d"): the distance between now and a date, rounded like the age. */
export function shortDistance(iso: string, now = Date.now()): { minutes: number; text: string } {
  const minutes = (new Date(iso).getTime() - now) / 60_000;
  return { minutes, text: shortAge(Math.abs(minutes)) };
}

/** The card's status or priority as the badge components expect it (the list's left joins may leave the label empty). */
export function asOption(o: CardStatus | CardPriority | null | undefined): OptionLabel | null {
  if (!o || !o.label) return null;
  return { id: o.id, key: o.key ?? '', label: o.label, color: o.color, category: 'category' in o ? o.category : undefined, level: 'level' in o ? o.level : undefined };
}
