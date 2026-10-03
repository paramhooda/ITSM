import { get, post } from '@/api/client';

/** Daily briefings (mirrors apps/api/src/modules/briefings). */

export type BriefingRole = 'engineer' | 'noc_manager' | 'soc_manager' | 'service_manager' | 'account_manager';
export type BriefingChannel = 'email' | 'in_app';

export interface BriefingPrefs {
  enabled: boolean;
  time: string;
  role: 'auto' | BriefingRole;
  channels: BriefingChannel[];
}

export interface BriefingItem { ref: string; title: string; meta?: string | null; link?: string | null }
export interface BriefingSection { key: string; title: string; summary?: string | null; items: BriefingItem[] }
export interface BriefingFacts { role: BriefingRole; roleLabel: string; day: string; timezone: string; generatedAt: string; headline: string[]; sections: BriefingSection[] }

export interface Briefing {
  id: string;
  userId: string;
  role: BriefingRole;
  roleLabel: string;
  day: string;
  text: string;
  html: string;
  ai: boolean;
  facts: BriefingFacts | null;
  channels: string[];
  generatedAt: string;
  deliveredAt: string | null;
}

export interface BriefingToday {
  day: string;
  briefing: Briefing | null;
  prefs: BriefingPrefs;
  role: BriefingRole;
  roles: { key: BriefingRole; label: string; description: string; allowed: boolean }[];
}

export const briefingKeys = { today: ['briefings', 'today'] as const };
export const briefingsApi = {
  today: () => get<BriefingToday>('/briefings/today'),
  generate: (role?: BriefingRole) => post<Briefing>('/briefings/generate', role ? { role } : {}),
};

/** Half-hour steps between 05:00 and 21:30 for the time picker. */
export const BRIEFING_TIMES = Array.from({ length: 34 }, (_, i) => { const h = 5 + Math.floor(i / 2); const m = i % 2 ? '30' : '00'; return `${String(h).padStart(2, '0')}:${m}`; });
