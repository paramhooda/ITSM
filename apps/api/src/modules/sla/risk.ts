import { eq, and, inArray, sql } from 'drizzle-orm';
import { schema, withSystem, type Tx } from '@/db/client';
import { logger } from '@/core/logger';
import { summarizeRow, worstSummary } from './engine';

/**
 * Breach-risk scoring: how likely the worst open SLA clock of a ticket is to be
 * breached, from how much of the target has gone, how long tickets like this
 * one usually take, and who is working on it. Pure arithmetic here; the job in
 * jobs/processors/risk.ts feeds it and writes the result on the ticket.
 */

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskInput {
  /** The worst open metric: percent of the target consumed (working time). */
  pctConsumed: number;
  /** Working minutes left on that metric (negative when past due). */
  remainingMinutes: number;
  /** Working minutes already on the clock. */
  elapsedMinutes: number;
  /** Median resolution time (working minutes) of tickets of the same type, category and priority resolved recently; null when unknown. */
  medianMinutes: number | null;
  breached: boolean;
  paused: boolean;
  unassigned: boolean;
  /** The ticket waits on the customer (pending category). */
  pendingCustomer: boolean;
  escalationLevel: number;
  reopenCount: number;
}

export interface RiskResult {
  level: RiskLevel;
  score: number;
  reason: string;
}

export const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high'];
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const hours = (m: number) => (Math.abs(m) >= 60 ? `${Math.round(Math.abs(m) / 60)}h` : `${Math.round(Math.abs(m))}m`);

export const levelOf = (score: number): RiskLevel => (score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low');

export function scoreTicket(i: RiskInput): RiskResult {
  if (i.breached) return { level: 'high', score: 100, reason: 'SLA already breached' };
  const reasons: string[] = [];
  // The clock: 0..100 straight from the consumption.
  let score = clamp(i.pctConsumed, 0, 100);
  reasons.push(`${Math.round(i.pctConsumed)}% of the target used`);
  // The forecast: tickets like this usually need `median` minutes in total; the shortfall against what is left raises the score.
  if (i.medianMinutes != null && i.medianMinutes > 0) {
    const needed = Math.max(0, i.medianMinutes - i.elapsedMinutes);
    const shortfall = needed - Math.max(0, i.remainingMinutes);
    if (shortfall > 0) {
      score += Math.min(40, 40 * (shortfall / Math.max(needed, 1)));
      reasons.push(`similar tickets take ${hours(i.medianMinutes)}, ${hours(Math.max(0, i.remainingMinutes))} left`);
    } else if (needed > 0 && i.remainingMinutes > 0) {
      // Plenty of room against the usual duration keeps a mid-clock ticket calm.
      score -= Math.min(15, 15 * ((i.remainingMinutes - needed) / i.remainingMinutes));
    }
  }
  if (i.unassigned) {
    score += 15;
    reasons.push('unassigned');
  }
  if (i.paused) {
    score = Math.min(score, 55);
    reasons.push('clock paused');
  }
  if (i.pendingCustomer) {
    score -= 25;
    reasons.push('waiting on the customer');
  }
  if (i.escalationLevel > 0) score += 5;
  if (i.reopenCount > 0) {
    score += 5;
    reasons.push('reopened before');
  }
  const final = Math.round(clamp(score, 0, 100));
  return { level: levelOf(final), score: final, reason: reasons.join('; ') };
}

// ---------------------------------------------------------------- the job's half: score every open ticket

const OPEN: ('new' | 'open' | 'pending')[] = ['new', 'open', 'pending'];
const MEDIAN_DAYS = 180;
const MIN_SAMPLE = 3;
const medianKey = (type: string, categoryId: string | null, priorityId: string | null) => `${type}|${categoryId ?? ''}|${priorityId ?? ''}`;

/** Median working minutes to resolution of tickets like each open one (same type, category and priority), from the last 180 days. */
async function medians(tx: Tx) {
  const res = await tx.execute(sql`
    SELECT t.type, t.category_id AS "categoryId", t.priority_id AS "priorityId", count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY s.elapsed_minutes_at_completion) AS median
    FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id
    WHERE s.metric = 'resolution' AND s.completed_at >= now() - make_interval(days => ${MEDIAN_DAYS}) AND s.elapsed_minutes_at_completion IS NOT NULL
    GROUP BY 1, 2, 3`);
  const map = new Map<string, number>();
  for (const r of res.rows as { type: string; categoryId: string | null; priorityId: string | null; n: number; median: number | string }[]) {
    if (Number(r.n) >= MIN_SAMPLE) map.set(medianKey(r.type, r.categoryId, r.priorityId), Number(r.median));
  }
  // A priority-only fallback when the category has too few samples.
  const byPriority = await tx.execute(sql`
    SELECT t.type, t.priority_id AS "priorityId", count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY s.elapsed_minutes_at_completion) AS median
    FROM ticket_slas s JOIN tickets t ON t.id = s.ticket_id
    WHERE s.metric = 'resolution' AND s.completed_at >= now() - make_interval(days => ${MEDIAN_DAYS}) AND s.elapsed_minutes_at_completion IS NOT NULL
    GROUP BY 1, 2`);
  for (const r of byPriority.rows as { type: string; priorityId: string | null; n: number; median: number | string }[]) {
    if (Number(r.n) >= MIN_SAMPLE) map.set(medianKey(r.type, null, r.priorityId), Number(r.median));
  }
  return map;
}

export interface RiskRun {
  scored: number;
  changed: number;
  cleared: number;
  high: number;
}

/**
 * Scores every ticket with an open clock and writes the level, score and reason
 * on the ticket when they moved; clears the fields of tickets whose clocks are
 * done. A rise to high adds an internal activity so the timeline shows when the
 * ticket started looking like a breach.
 */
export async function scoreOpenTickets(now = new Date(), batch = 1000): Promise<RiskRun> {
  const run: RiskRun = { scored: 0, changed: 0, cleared: 0, high: 0 };
  await withSystem(async (tx) => {
    const cleared = await tx.execute(sql`
      UPDATE tickets t SET breach_risk = NULL, breach_risk_score = NULL, breach_risk_reason = NULL, breach_risk_at = ${now}
      FROM config_options st
      WHERE st.id = t.status_id AND t.breach_risk IS NOT NULL
        AND (st.status_category NOT IN ('new', 'open', 'pending')
             OR NOT EXISTS (SELECT 1 FROM ticket_slas x WHERE x.ticket_id = t.id AND x.state IN ('running', 'paused', 'breached') AND x.completed_at IS NULL))`);
    run.cleared = cleared.rowCount ?? 0;
    const candidates = await tx
      .select({ ticket: schema.tickets, category: schema.configOptions.statusCategory })
      .from(schema.tickets)
      .innerJoin(schema.configOptions, eq(schema.configOptions.id, schema.tickets.statusId))
      .where(and(inArray(schema.configOptions.statusCategory, OPEN), sql`EXISTS (SELECT 1 FROM ticket_slas x WHERE x.ticket_id = ${schema.tickets.id} AND x.state IN ('running', 'paused', 'breached') AND x.completed_at IS NULL)`))
      .limit(batch);
    if (!candidates.length) return;
    const slaRows = await tx.select().from(schema.ticketSlas).where(inArray(schema.ticketSlas.ticketId, candidates.map((c) => c.ticket.id)));
    const byTicket = new Map<string, typeof slaRows>();
    for (const r of slaRows) byTicket.set(r.ticketId, [...(byTicket.get(r.ticketId) ?? []), r]);
    const med = await medians(tx);
    for (const { ticket: t, category } of candidates) {
      const worst = worstSummary((byTicket.get(t.id) ?? []).map((r) => summarizeRow(r, now)));
      if (!worst || worst.completedAt) continue;
      const median = med.get(medianKey(t.type, t.categoryId, t.priorityId)) ?? med.get(medianKey(t.type, null, t.priorityId)) ?? null;
      const result = scoreTicket({
        pctConsumed: worst.pctConsumed,
        remainingMinutes: worst.remainingMinutes,
        elapsedMinutes: worst.elapsedMinutes,
        medianMinutes: median,
        breached: worst.breached,
        paused: worst.state === 'paused',
        unassigned: !t.assigneeId,
        pendingCustomer: category === 'pending',
        escalationLevel: t.escalationLevel,
        reopenCount: t.reopenCount,
      });
      run.scored++;
      if (result.level === 'high') run.high++;
      const moved = t.breachRisk !== result.level || t.breachRiskScore == null || Math.abs(t.breachRiskScore - result.score) >= 5 || !t.breachRiskAt || now.getTime() - t.breachRiskAt.getTime() > 3600_000;
      if (!moved) continue;
      await tx.update(schema.tickets).set({ breachRisk: result.level, breachRiskScore: result.score, breachRiskReason: result.reason, breachRiskAt: now }).where(eq(schema.tickets.id, t.id));
      run.changed++;
      if (result.level === 'high' && t.breachRisk !== 'high' && !worst.breached) {
        // A direct insert: the shared helper bumps last_activity_at, and a system flag must not make the ticket look worked on.
        await tx.insert(schema.ticketActivities).values({ ticketId: t.id, customerId: t.customerId, actorId: null, actorName: 'System', activityType: 'sla', summary: `Breach risk high: ${result.reason}`, data: { risk: result, metric: worst.metric }, customerVisible: false, createdAt: now });
      }
    }
  }).catch((err) => {
    logger.error({ err }, 'risk scoring failed');
    throw err;
  });
  return run;
}
