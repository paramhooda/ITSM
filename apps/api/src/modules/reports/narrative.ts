import { z } from 'zod';
import { enabled, llmJson } from '@/modules/ai/service';
import { REPORT_NARRATIVE_SYSTEM } from '@/modules/ai/prompt';
import type { Insight, Narrative, Recommendation, SummaryTile } from './registry';
import { groundedAgainst, numbersIn } from './insights';

/**
 * The model rephrases the executive summary of a report from the figures and
 * the rules' insights. It runs between the report's transactions (Steps
 * pattern), never inside one, and never supplies a figure: every sentence that
 * carries a number the input does not hold is dropped, and an empty list falls
 * back to the rules' wording.
 */

export const narrativeSchema = z.object({
  summary: z.string().trim().min(1).max(600),
  wentWell: z.array(z.string().trim().min(1).max(220)).max(4),
  needsAttention: z.array(z.string().trim().min(1).max(220)).max(4),
  nextSteps: z.array(z.string().trim().min(1).max(220)).max(5),
});

export interface NarrativeInput {
  reportName: string;
  customer: string | null;
  period: string;
  comparison: string | null;
  tiles: SummaryTile[];
  insights: Insight[];
  recommendations: Recommendation[];
  fallback: Narrative;
}

export async function phraseNarrative(input: NarrativeInput): Promise<Narrative> {
  if (!enabled()) return input.fallback;
  const payload = {
    reportName: input.reportName,
    customer: input.customer,
    period: input.period,
    comparison: input.comparison,
    kpis: input.tiles.map(({ label, value, unit, delta, target }) => ({ label, value, unit, previous: delta?.previous ?? null, change: delta?.change ?? null, target: target ?? null })),
    insights: input.insights.map(({ kind, text, evidence }) => ({ kind, text, evidence })),
    recommendations: input.recommendations,
    rules: input.fallback,
  };
  const llm = await llmJson(REPORT_NARRATIVE_SYSTEM, JSON.stringify(payload), (v) => narrativeSchema.parse(v), { maxTokens: 900 });
  if (!llm) return input.fallback;
  const allowed = numbersIn(payload);
  const keep = (lines: string[]) => lines.filter((l) => groundedAgainst(l, allowed));
  const summary = groundedAgainst(llm.data.summary, allowed) ? llm.data.summary : input.fallback.summary;
  const wentWell = keep(llm.data.wentWell);
  const needsAttention = keep(llm.data.needsAttention);
  const nextSteps = keep(llm.data.nextSteps);
  return {
    summary,
    wentWell: wentWell.length || !input.fallback.wentWell.length ? wentWell : input.fallback.wentWell,
    needsAttention: needsAttention.length || !input.fallback.needsAttention.length ? needsAttention : input.fallback.needsAttention,
    nextSteps: nextSteps.length || !input.fallback.nextSteps.length ? nextSteps : input.fallback.nextSteps,
    source: 'model',
  };
}
