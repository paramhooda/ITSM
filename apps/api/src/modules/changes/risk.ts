import type { RiskOption } from '@/db/schema/changes';

/**
 * Change risk scoring: every answered question contributes its chosen
 * option's score times the question's weight; the total is scaled to 0..100
 * against the highest score the questionnaire can produce and mapped to
 * low / medium / high with the thresholds from `changes.risk_thresholds`.
 * Pure: the service loads the questions and the setting, the scorer decides.
 */

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskQuestion {
  id: string;
  key: string;
  question: string;
  weight: number;
  options: RiskOption[];
  isActive?: boolean;
}

export interface RiskThresholds {
  /** Scores at or above this are medium. */
  medium: number;
  /** Scores at or above this are high. */
  high: number;
}

export const DEFAULT_THRESHOLDS: RiskThresholds = { medium: 35, high: 65 };

export interface RiskResult {
  /** 0..100 */
  score: number;
  level: RiskLevel;
  /** Raw weighted total and the maximum the questionnaire allows. */
  points: number;
  maxPoints: number;
  answered: number;
  /** Questions without a (valid) answer. */
  missing: string[];
  /** The answered questions, highest contribution first, for the explanation. */
  drivers: { key: string; question: string; option: string; points: number }[];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export const levelOf = (score: number, t: RiskThresholds = DEFAULT_THRESHOLDS): RiskLevel => (score >= t.high ? 'high' : score >= t.medium ? 'medium' : 'low');

export function parseThresholds(raw: unknown): RiskThresholds {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const medium = Number(o.medium);
  const high = Number(o.high);
  const m = Number.isFinite(medium) ? clamp(medium, 1, 99) : DEFAULT_THRESHOLDS.medium;
  const h = Number.isFinite(high) ? clamp(high, m + 1, 100) : Math.max(m + 1, DEFAULT_THRESHOLDS.high);
  return { medium: m, high: h };
}

/** Scores a set of answers (question key → option key) against the active questionnaire. */
export function scoreChange(questions: RiskQuestion[], answers: Record<string, string> | null | undefined, thresholds: RiskThresholds = DEFAULT_THRESHOLDS): RiskResult {
  const active = questions.filter((q) => q.isActive !== false && q.options.length > 0);
  let points = 0;
  let maxPoints = 0;
  const missing: string[] = [];
  const drivers: RiskResult['drivers'] = [];
  for (const q of active) {
    const weight = Math.max(0, q.weight || 0);
    const top = Math.max(...q.options.map((o) => o.score));
    maxPoints += weight * Math.max(0, top);
    const chosen = answers?.[q.key];
    const opt = chosen ? q.options.find((o) => o.key === chosen) : undefined;
    if (!opt) {
      missing.push(q.key);
      continue;
    }
    const p = weight * opt.score;
    points += p;
    drivers.push({ key: q.key, question: q.question, option: opt.label, points: p });
  }
  drivers.sort((a, b) => b.points - a.points);
  const score = maxPoints > 0 ? Math.round(clamp((points / maxPoints) * 100, 0, 100)) : 0;
  return { score, level: levelOf(score, thresholds), points, maxPoints, answered: drivers.length, missing, drivers };
}
