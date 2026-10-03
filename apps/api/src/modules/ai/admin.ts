import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { ForbiddenError } from '@/core/errors';
import { updateSettings } from '@/modules/config/service';
import { AI_FEATURES, loadAiSettings, type AiSettings } from './guards';
import { loadTriageSettings, type TriageSettings } from './triage';

/**
 * The administrator's control surface: the operating settings of the assistant
 * (kill switch, feature switches, autonomy, effort, budgets, retention) and a
 * usage report built from the stored messages and the audit trail.
 */

/** The assistant's own per-person limit on /ai/chat (routes.ts); shown read-only. */
export const CHAT_RATE_LIMIT_PER_MINUTE = 30;

export const aiSettingsBodySchema = z
  .object({
    assistantEnabled: z.boolean().optional(),
    disabledFeatures: z.array(z.enum(AI_FEATURES)).max(AI_FEATURES.length).optional(),
    autonomy: z.enum(['confirm_all', 'auto_low']).optional(),
    effort: z.enum(['low', 'medium', 'high']).optional(),
    dailyTokenBudget: z.number().int().min(0).max(100_000_000).optional(),
    turnTimeoutSeconds: z.number().int().min(15).max(600).optional(),
    retentionDays: z.number().int().min(0).max(3650).optional(),
    triageAutoApplyConfidence: z.number().int().min(50).max(100).optional(),
    stormWindowMinutes: z.number().int().min(5).max(1440).optional(),
    stormThreshold: z.number().int().min(2).max(50).optional(),
    stormAutoLink: z.boolean().optional(),
  })
  .refine((b) => b.retentionDays === undefined || b.retentionDays === 0 || b.retentionDays >= 7, { message: 'Retention is 0 (keep forever) or at least 7 days', path: ['retentionDays'] });
export type AiSettingsBody = z.infer<typeof aiSettingsBodySchema>;

export const usageQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const requireAdmin = (ctx: Ctx) => {
  if (!ctx.can('admin:system') && !ctx.can('admin:config')) throw new ForbiddenError('Missing permission: admin:system or admin:config');
};

export interface AiAdminSettings extends AiSettings {
  features: readonly string[];
  rateLimitPerMinute: number;
  triage: TriageSettings;
}

export async function getAiSettings(ctx: Ctx): Promise<AiAdminSettings> {
  requireAdmin(ctx);
  return { ...(await loadAiSettings(ctx.tx)), features: AI_FEATURES, rateLimitPerMinute: CHAT_RATE_LIMIT_PER_MINUTE, triage: await loadTriageSettings(ctx.tx) };
}

/** Writes only the keys given, through the settings service (audited as a settings update). */
export async function updateAiSettings(ctx: Ctx, patch: AiSettingsBody): Promise<AiAdminSettings> {
  ctx.require('admin:system');
  const map: Record<string, unknown> = {};
  if (patch.assistantEnabled !== undefined) map['ai.assistant.enabled'] = patch.assistantEnabled;
  if (patch.disabledFeatures !== undefined) map['ai.disabled_features'] = [...new Set(patch.disabledFeatures)];
  if (patch.autonomy !== undefined) map['ai.autonomy'] = patch.autonomy;
  if (patch.effort !== undefined) map['ai.effort'] = patch.effort;
  if (patch.dailyTokenBudget !== undefined) map['ai.daily_token_budget'] = patch.dailyTokenBudget;
  if (patch.turnTimeoutSeconds !== undefined) map['ai.turn_timeout_seconds'] = patch.turnTimeoutSeconds;
  if (patch.retentionDays !== undefined) map['ai.conversation_retention_days'] = patch.retentionDays;
  if (patch.triageAutoApplyConfidence !== undefined) map['ai.triage.auto_apply_confidence'] = patch.triageAutoApplyConfidence;
  if (patch.stormWindowMinutes !== undefined) map['ai.triage.storm_window_minutes'] = patch.stormWindowMinutes;
  if (patch.stormThreshold !== undefined) map['ai.triage.storm_threshold'] = patch.stormThreshold;
  if (patch.stormAutoLink !== undefined) map['ai.triage.storm_auto_link'] = patch.stormAutoLink;
  if (Object.keys(map).length) await updateSettings(ctx, map);
  return getAiSettings(ctx);
}

export interface UsageDay {
  day: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  toolCalls: number;
  up: number;
  down: number;
  avgDurationMs: number;
}

const n = (v: unknown) => Number(v ?? 0) || 0;

/** Turns, tokens, tool calls, feedback and guardrail events over the last `days` days (today included). */
export async function usage(ctx: Ctx, q: { days: number }) {
  requireAdmin(ctx);
  const days = Math.min(365, Math.max(1, q.days));
  const from = sql`date_trunc('day', now()) - make_interval(days => ${days - 1})`;
  const [series, totals, byTool, guard] = await Promise.all([
    ctx.tx.execute(sql`
      SELECT to_char(date_trunc('day', m.created_at), 'YYYY-MM-DD') AS day,
        count(*) FILTER (WHERE m.role = 'assistant')::int AS turns,
        coalesce(sum(m.input_tokens), 0)::bigint AS input_tokens,
        coalesce(sum(m.output_tokens), 0)::bigint AS output_tokens,
        coalesce(sum(m.cache_read_tokens), 0)::bigint AS cache_read_tokens,
        coalesce(sum(jsonb_array_length(m.tool_calls)), 0)::int AS tool_calls,
        count(*) FILTER (WHERE m.feedback = 'up')::int AS up,
        count(*) FILTER (WHERE m.feedback = 'down')::int AS down,
        coalesce(avg(m.duration_ms) FILTER (WHERE m.role = 'assistant'), 0)::int AS avg_duration_ms
      FROM ai_messages m WHERE m.created_at >= ${from}
      GROUP BY 1 ORDER BY 1`),
    ctx.tx.execute(sql`
      SELECT count(*) FILTER (WHERE m.role = 'assistant')::int AS turns,
        count(DISTINCT c.user_id)::int AS users,
        count(DISTINCT c.id)::int AS conversations,
        coalesce(sum(m.input_tokens), 0)::bigint AS input_tokens,
        coalesce(sum(m.output_tokens), 0)::bigint AS output_tokens,
        coalesce(sum(m.cache_read_tokens), 0)::bigint AS cache_read_tokens,
        coalesce(sum(jsonb_array_length(m.tool_calls)), 0)::int AS tool_calls,
        count(*) FILTER (WHERE m.feedback = 'up')::int AS up,
        count(*) FILTER (WHERE m.feedback = 'down')::int AS down,
        coalesce(avg(m.duration_ms) FILTER (WHERE m.role = 'assistant'), 0)::int AS avg_duration_ms
      FROM ai_messages m JOIN ai_conversations c ON c.id = m.conversation_id WHERE m.created_at >= ${from}`),
    ctx.tx.execute(sql`
      SELECT t->>'name' AS tool, count(*)::int AS calls,
        count(*) FILTER (WHERE t->>'ok' = 'true' AND coalesce(t->>'proposed', 'false') <> 'true')::int AS ok,
        count(*) FILTER (WHERE t->>'proposed' = 'true')::int AS proposed,
        count(*) FILTER (WHERE coalesce(t->>'ok', 'false') <> 'true')::int AS failed,
        bool_or(t->>'action' = 'true') AS action
      FROM ai_messages m, jsonb_array_elements(m.tool_calls) t
      WHERE m.created_at >= ${from} AND m.role = 'assistant'
      GROUP BY 1 ORDER BY calls DESC, 1 LIMIT 60`),
    ctx.tx.execute(sql`
      SELECT action, coalesce(metadata->>'outcome', '') AS outcome, count(*)::int AS n
      FROM audit_log WHERE occurred_at >= ${from} AND action IN ('ai.chat', 'ai.tool', 'ai.tenant_fence', 'ai.answer_fence', 'ai.feedback')
      GROUP BY 1, 2`),
  ]);
  const rows = guard.rows as { action: string; outcome: string; n: number }[];
  const sumWhere = (f: (r: { action: string; outcome: string }) => boolean) => rows.filter(f).reduce((s, r) => s + n(r.n), 0);
  const outcomes: Record<string, number> = {};
  for (const r of rows) if (r.action === 'ai.chat') outcomes[r.outcome || 'answered'] = (outcomes[r.outcome || 'answered'] ?? 0) + n(r.n);
  const t = (totals.rows[0] ?? {}) as Record<string, unknown>;
  const input = n(t.input_tokens);
  const cache = n(t.cache_read_tokens);
  return {
    days,
    totals: { turns: n(t.turns), users: n(t.users), conversations: n(t.conversations), inputTokens: input, outputTokens: n(t.output_tokens), cacheReadTokens: cache, cacheHitPct: input > 0 ? Math.round((cache / input) * 100) : 0, toolCalls: n(t.tool_calls), up: n(t.up), down: n(t.down), avgDurationMs: n(t.avg_duration_ms) },
    series: (series.rows as Record<string, unknown>[]).map((r): UsageDay => ({ day: String(r.day), turns: n(r.turns), inputTokens: n(r.input_tokens), outputTokens: n(r.output_tokens), cacheReadTokens: n(r.cache_read_tokens), toolCalls: n(r.tool_calls), up: n(r.up), down: n(r.down), avgDurationMs: n(r.avg_duration_ms) })),
    byTool: (byTool.rows as Record<string, unknown>[]).map((r) => ({ tool: String(r.tool ?? ''), calls: n(r.calls), ok: n(r.ok), proposed: n(r.proposed), failed: n(r.failed), action: r.action === true })),
    guardrails: {
      tenantFence: sumWhere((r) => r.action === 'ai.tenant_fence'),
      answerFence: sumWhere((r) => r.action === 'ai.answer_fence'),
      forbiddenToolCalls: sumWhere((r) => r.action === 'ai.tool' && r.outcome === 'forbidden'),
      invalidToolCalls: sumWhere((r) => r.action === 'ai.tool' && (r.outcome === 'invalid_input' || r.outcome === 'unknown_tool')),
      toolErrors: sumWhere((r) => r.action === 'ai.tool' && r.outcome === 'error'),
      proposals: sumWhere((r) => r.action === 'ai.tool' && r.outcome === 'proposed'),
      outcomes,
    },
  };
}
