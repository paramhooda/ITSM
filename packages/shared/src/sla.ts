/**
 * SLA compliance as one number everywhere: the thresholds every dashboard,
 * record page, briefing, assistant fact and printed document colour the
 * percentage with, and the two outcomes a resolution clock can end in.
 *
 * The figure itself is computed by one helper on the API
 * (`modules/sla/compliance.ts`): resolution clocks that ended in the period,
 * met over met plus breached. The target is the commitment on every printed
 * document (95 %) and the warning band sits five points below it, so the
 * screen and the paper agree.
 */

/** The compliance commitment: at or above it the figure reads as good. */
export const SLA_COMPLIANCE_TARGET = 95;
/** Below the target but at or above this the figure reads as a warning; below it, critical. */
export const SLA_COMPLIANCE_WARNING = 90;

export type ComplianceTone = 'good' | 'warning' | 'critical';

/** The tone of a compliance percentage (`null` when nothing ended, so there is nothing to colour). */
export function complianceTone(pct: number | null | undefined): ComplianceTone | null {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return null;
  if (pct >= SLA_COMPLIANCE_TARGET) return 'good';
  if (pct >= SLA_COMPLIANCE_WARNING) return 'warning';
  return 'critical';
}

/** How a resolution clock ends: met (closed within target) or breached (flagged by the engine, open or closed). */
export const SLA_OUTCOMES = ['met', 'breached'] as const;
export type SlaOutcome = (typeof SLA_OUTCOMES)[number];
