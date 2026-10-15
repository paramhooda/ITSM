import { eq } from 'drizzle-orm';
import { withSystem, schema } from '../src/db/client';

/**
 * Test helpers for the lifecycle settings and the SLA policy's pause rule: each
 * one writes the value, runs the body and restores what was there before, so a
 * case that changes a setting never leaks into the next file on the shared
 * database.
 */

/** Runs `fn` with `system_settings[key]` set to `value`, then restores the previous row (or deletes a row that did not exist). */
export async function withSetting<T>(key: string, value: unknown, fn: () => Promise<T>): Promise<T> {
  const [before] = await withSystem((tx) => tx.select({ value: schema.systemSettings.value, description: schema.systemSettings.description }).from(schema.systemSettings).where(eq(schema.systemSettings.key, key)).limit(1));
  await withSystem((tx) => tx.insert(schema.systemSettings).values({ key, value: value as never }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: value as never } }));
  try {
    return await fn();
  } finally {
    await withSystem(async (tx) => {
      if (before) await tx.update(schema.systemSettings).set({ value: before.value as never }).where(eq(schema.systemSettings.key, key));
      else await tx.delete(schema.systemSettings).where(eq(schema.systemSettings.key, key));
    });
  }
}

/** Runs `fn` with the policy's pause rule changed (either field), then restores both columns. */
export async function withPolicyPause<T>(policyId: string, rule: { metrics?: string[]; waitingOn?: string[] }, fn: () => Promise<T>): Promise<T> {
  const [before] = await withSystem((tx) => tx.select({ pauseMetrics: schema.slaPolicies.pauseMetrics, pauseWaitingOn: schema.slaPolicies.pauseWaitingOn }).from(schema.slaPolicies).where(eq(schema.slaPolicies.id, policyId)).limit(1));
  if (!before) throw new Error(`policy ${policyId} missing`);
  // An empty rule only restores afterwards (the body writes the columns itself, through the API or the assistant).
  if (rule.metrics || rule.waitingOn) await withSystem((tx) => tx.update(schema.slaPolicies).set({ ...(rule.metrics ? { pauseMetrics: rule.metrics } : {}), ...(rule.waitingOn ? { pauseWaitingOn: rule.waitingOn } : {}) }).where(eq(schema.slaPolicies.id, policyId)));
  try {
    return await fn();
  } finally {
    await withSystem((tx) => tx.update(schema.slaPolicies).set({ pauseMetrics: before.pauseMetrics, pauseWaitingOn: before.pauseWaitingOn }).where(eq(schema.slaPolicies.id, policyId)));
  }
}
