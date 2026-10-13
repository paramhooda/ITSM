import { get, post } from '@/api/client';

/** Daily briefings (mirrors apps/api/src/modules/briefings). */

export type BriefingRole = 'engineer' | 'noc_manager' | 'soc_manager' | 'service_manager' | 'account_manager' | 'customer';
export type BriefingChannel = 'email' | 'in_app';

export interface BriefingPrefs {
  enabled: boolean;
  time: string;
  role: 'auto' | BriefingRole;
  channels: BriefingChannel[];
}

export type BriefingItemKind = 'ticket' | 'customer' | 'contract' | 'entitlement' | 'integration' | 'sla' | 'visit' | 'maintenance' | 'change' | 'approval' | 'announcement' | 'known_error';

/** A count with the list it opens: `href` null means a figure (no list reproduces it), so it renders as a plain chip. */
export interface BriefingDoor {
  label: string;
  value: number;
  href: string | null;
}

export interface BriefingItem {
  ref: string;
  title: string;
  /** The one-line details the email prints; the panel shows the typed fields instead and falls back to this line. */
  meta?: string | null;
  link?: string | null;
  kind?: BriefingItemKind;
  priority?: { key: string | null; label: string | null; color: string | null } | null;
  customer?: string | null;
  /** The owner's name; null for the portal (never a staff name) and for unowned tickets. */
  assignee?: string | null;
  team?: string | null;
  dueAt?: string | null;
  breachRisk?: 'low' | 'medium' | 'high' | null;
  sentiment?: string | null;
  status?: string | null;
  /** An ISO instant or a YYYY-MM-DD day, shown as given. */
  when?: string | null;
  /** Per-row doors (the account manager's customers). */
  doors?: BriefingDoor[] | null;
}

export interface BriefingSection {
  key: string;
  title: string;
  /** The deterministic lead sentence, written from the door values. */
  summary?: string | null;
  doors: BriefingDoor[];
  items: BriefingItem[];
}

export interface BriefingKpi {
  key: string;
  label: string;
  value: number | string;
  tone: 'good' | 'warn' | 'bad' | null;
  href: string | null;
  hint?: string | null;
}

/** What the model phrased, bounded and grounded against the facts; `source` says whether any of it survived. */
export interface BriefingNarrative {
  greeting: string;
  summary: string;
  sections: { key: string; lead: string; picks: string[] }[];
  source: 'model' | 'facts';
}

export interface BriefingFacts {
  role: BriefingRole;
  roleLabel: string;
  day: string;
  timezone: string;
  generatedAt: string;
  headline: string[];
  kpis: BriefingKpi[];
  sections: BriefingSection[];
  narrative?: BriefingNarrative | null;
}

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
  /** The narrative beside the facts (from the facts when none was stored). */
  narrative: BriefingNarrative | null;
  channels: string[];
  generations: number;
  generatedAt: string;
  deliveredAt: string | null;
}

/** The daily cap and the cooldown on generating a briefing on request. */
export interface BriefingUsage {
  maxPerDay: number;
  cooldownMinutes: number;
  used: number;
  remaining: number | null;
  nextAllowedAt: string | null;
  exhausted: boolean;
  cooling: boolean;
}

export interface GenerateResult {
  briefing: Briefing;
  /** True when the stored briefing came back without a new model call. */
  reused: boolean;
  reason: 'cooldown' | 'limit' | null;
  usage: BriefingUsage;
}

export interface BriefingToday {
  day: string;
  briefing: Briefing | null;
  usage: BriefingUsage;
  prefs: BriefingPrefs;
  role: BriefingRole;
  roles: { key: BriefingRole; label: string; description: string; allowed: boolean }[];
}

export const briefingKeys = { today: ['briefings', 'today'] as const };
export const briefingsApi = {
  today: () => get<BriefingToday>('/briefings/today'),
  generate: (role?: BriefingRole) => post<GenerateResult>('/briefings/generate', role ? { role } : {}),
};

/** Half-hour steps between 05:00 and 21:30 for the time picker. */
export const BRIEFING_TIMES = Array.from({ length: 34 }, (_, i) => { const h = 5 + Math.floor(i / 2); const m = i % 2 ? '30' : '00'; return `${String(h).padStart(2, '0')}:${m}`; });
