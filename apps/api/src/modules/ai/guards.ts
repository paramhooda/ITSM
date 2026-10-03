import { inArray, sql } from 'drizzle-orm';
import { schema, type Tx } from '@/db/client';
import type { Ctx } from '@/core/context';
import { AppError, ServiceUnavailableError, TooManyRequestsError } from '@/core/errors';

/**
 * Operating limits for the assistant, all set by administrators in system
 * settings: a kill switch, per-feature switches, the autonomy mode, the
 * reasoning effort, a daily token budget per person and a wall-clock budget per
 * reply. Everything fails closed: a missing or malformed setting takes the
 * conservative default.
 */

export const AI_FEATURES = ['assistant', 'summarize', 'classify', 'assign', 'similar', 'suggest_kb', 'resolution', 'draft', 'duplicates', 'change_impact', 'problem_clusters', 'triage', 'sentiment', 'recommendations'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];
export type Autonomy = 'confirm_all' | 'auto_low';
export type Effort = 'low' | 'medium' | 'high';

export interface AiSettings {
  assistantEnabled: boolean;
  disabledFeatures: AiFeature[];
  autonomy: Autonomy;
  effort: Effort;
  dailyTokenBudget: number;
  turnTimeoutSeconds: number;
  retentionDays: number;
}

export const AI_SETTING_KEYS = ['ai.assistant.enabled', 'ai.disabled_features', 'ai.autonomy', 'ai.effort', 'ai.daily_token_budget', 'ai.turn_timeout_seconds', 'ai.conversation_retention_days'] as const;

export const DEFAULT_AI_SETTINGS: AiSettings = { assistantEnabled: true, disabledFeatures: [], autonomy: 'confirm_all', effort: 'low', dailyTokenBudget: 250_000, turnTimeoutSeconds: 90, retentionDays: 90 };

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

export function parseAiSettings(rows: { key: string; value: unknown }[]): AiSettings {
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const disabled = get('ai.disabled_features');
  const autonomy = get('ai.autonomy');
  const effort = get('ai.effort');
  return {
    assistantEnabled: get('ai.assistant.enabled') !== false,
    disabledFeatures: Array.isArray(disabled) ? disabled.filter((f): f is AiFeature => (AI_FEATURES as readonly string[]).includes(String(f))) : [],
    autonomy: autonomy === 'auto_low' ? 'auto_low' : 'confirm_all',
    effort: effort === 'medium' || effort === 'high' ? effort : 'low',
    dailyTokenBudget: num(get('ai.daily_token_budget'), DEFAULT_AI_SETTINGS.dailyTokenBudget, 0, 100_000_000),
    turnTimeoutSeconds: num(get('ai.turn_timeout_seconds'), DEFAULT_AI_SETTINGS.turnTimeoutSeconds, 15, 600),
    retentionDays: num(get('ai.conversation_retention_days'), DEFAULT_AI_SETTINGS.retentionDays, 0, 3650),
  };
}

export async function loadAiSettings(tx: Tx): Promise<AiSettings> {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, [...AI_SETTING_KEYS]));
  return parseAiSettings(rows);
}

export class AiDisabledError extends AppError {
  constructor(message = 'The AI assistant is not configured (set AI_PROVIDER and credentials)') {
    super(503, message, 'ai_disabled');
  }
}

/** The assistant answers only when a provider is configured and the administrator's switch is on. */
export function assertAssistantEnabled(settings: AiSettings, providerEnabled: boolean) {
  if (!providerEnabled) throw new AiDisabledError();
  if (!settings.assistantEnabled) throw new AiDisabledError('The AI assistant has been switched off by an administrator');
  if (settings.disabledFeatures.includes('assistant')) throw new AiDisabledError('The AI assistant has been switched off by an administrator');
}

export const featureEnabled = (settings: AiSettings, feature: AiFeature) => settings.assistantEnabled && !settings.disabledFeatures.includes(feature);

/** A per-feature switch (summaries, classification, drafts and so on) set by an administrator. */
export async function assertFeature(ctx: Ctx, feature: AiFeature): Promise<AiSettings> {
  const settings = await loadAiSettings(ctx.tx);
  if (!featureEnabled(settings, feature)) throw new ServiceUnavailableError('This AI feature has been switched off by an administrator', 'ai_feature_disabled');
  return settings;
}

/** Tokens the person has spent today, across all their conversations. */
export async function tokensUsedToday(ctx: Ctx): Promise<number> {
  const res = await ctx.tx.execute(sql`
    SELECT coalesce(sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0)), 0)::int AS used
    FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id
    WHERE c.user_id = ${ctx.user.id}::uuid AND m.created_at >= date_trunc('day', now())`);
  return Number((res.rows[0] as { used?: number } | undefined)?.used ?? 0);
}

export async function assertDailyBudget(ctx: Ctx, settings: AiSettings) {
  if (settings.dailyTokenBudget <= 0) return;
  const used = await tokensUsedToday(ctx);
  if (used >= settings.dailyTokenBudget) throw new TooManyRequestsError(`You have used today's AI allowance (${settings.dailyTokenBudget.toLocaleString('en-GB')} tokens). It resets at midnight UTC; an administrator can raise it.`, 'ai_budget_exceeded');
}
