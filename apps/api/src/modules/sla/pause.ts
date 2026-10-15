import { eq } from 'drizzle-orm';
import { SLA_METRICS, WAITING_ON, waitingOnLabels, type SlaMetric, type WaitingOn } from '@itsm/shared';
import type { Tx } from '@/db/client';
import { schema } from '@/db/client';

/**
 * The clock rule of an SLA policy: which clocks a wait stops (`pause_metrics`)
 * and which parties' waits stop them (`pause_waiting_on`). This is the one
 * reader of the two columns; the engine, the ticket record, the assistant's
 * previews and the dialogs' sentences all come through here, so no file names a
 * metric or a party as a pausing constant. The defaults are the shipped rule:
 * resolution and restoration pause for a customer, supplier, change or agreed
 * wait; an internal hold keeps every clock running.
 */

export interface PauseRule {
  metrics: SlaMetric[];
  waitingOn: WaitingOn[];
}

export const DEFAULT_PAUSE_RULE: PauseRule = { metrics: ['resolution', 'restoration'], waitingOn: ['customer', 'vendor', 'change', 'agreement'] };

const METRIC_ORDER: SlaMetric[] = ['resolution', 'restoration', 'response', 'acknowledgement'];

/** The rule of a policy row (a missing policy, or an unknown value in a column, falls back to the defaults). */
export function pauseRuleOf(policy: { pauseMetrics?: string[] | null; pauseWaitingOn?: string[] | null } | null | undefined): PauseRule {
  if (!policy) return { metrics: [...DEFAULT_PAUSE_RULE.metrics], waitingOn: [...DEFAULT_PAUSE_RULE.waitingOn] };
  const metrics = (policy.pauseMetrics ?? DEFAULT_PAUSE_RULE.metrics).filter((m): m is SlaMetric => (SLA_METRICS as readonly string[]).includes(m));
  const waitingOn = (policy.pauseWaitingOn ?? DEFAULT_PAUSE_RULE.waitingOn).filter((w): w is WaitingOn => (WAITING_ON as readonly string[]).includes(w));
  return { metrics: [...new Set(metrics)].sort((a, b) => METRIC_ORDER.indexOf(a) - METRIC_ORDER.indexOf(b)), waitingOn: [...new Set(waitingOn)] };
}

/** One select: the rule of the policy, or the defaults when the ticket has none. */
export async function loadPauseRule(tx: Tx, policyId: string | null | undefined): Promise<PauseRule> {
  if (!policyId) return pauseRuleOf(null);
  const [row] = await tx.select({ pauseMetrics: schema.slaPolicies.pauseMetrics, pauseWaitingOn: schema.slaPolicies.pauseWaitingOn }).from(schema.slaPolicies).where(eq(schema.slaPolicies.id, policyId)).limit(1);
  return pauseRuleOf(row ?? null);
}

/**
 * Whether a wait on `waitingOn` stops the clocks under the rule. A row with no
 * recorded party (a custom pause status that is not a wait, a legacy row) pauses
 * as it always did: the status said so.
 */
export function waitPauses(rule: PauseRule, waitingOn: string | null | undefined): boolean {
  if (!waitingOn) return true;
  return (rule.waitingOn as string[]).includes(waitingOn);
}

/** Whether the metric's clock is one the rule stops. */
export const metricPauses = (rule: PauseRule, metric: string): boolean => (rule.metrics as string[]).includes(metric);

const list = (words: string[]) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/**
 * The sentences of the rule for the dialogs and the assistant: what pauses while
 * the ticket waits on `waitingOn` (or in general when no party is given).
 */
export function pauseWords(rule: PauseRule, waitingOn?: string | null): string {
  const paused: string[] = [...rule.metrics];
  const running: string[] = METRIC_ORDER.filter((m) => !rule.metrics.includes(m));
  if (waitingOn && !waitPauses(rule, waitingOn)) {
    const who = waitingOnLabels(waitingOn as WaitingOn).staff.toLowerCase();
    return waitingOn === 'internal' ? 'No clock pauses for an internal hold' : `No clock pauses while the ticket is ${who}`;
  }
  if (!paused.length) return 'No clock pauses while it waits';
  const head = `${list(paused)} ${paused.length > 1 ? 'clocks pause' : 'clock pauses'} while it waits`;
  return running.length ? `${head}; the ${list(running)} ${running.length > 1 ? 'clocks keep' : 'clock keeps'} running` : head;
}
