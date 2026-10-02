/**
 * Executes discovery runs in the worker and schedules cron-driven sources.
 * Every finding is reconciled in its own transaction so one bad host never
 * fails the run; the run row is updated progressively so the UI can follow.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { CronExpressionParser } from 'cron-parser';
import { schema, withSystem } from '@/db/client';
import { logger } from '@/core/logger';
import { decryptSecret } from '@/lib/crypto';
import { enqueue } from '@/jobs/queues';
import { getProvider } from './providers';
import type { DiscoverySourceTarget, RawFinding } from './providers/types';
import { applyFinding, reconcileFinding } from './apply';

const { discoverySources, discoveryRuns } = schema;
const LOG_CAP = 50 * 1024;
const SYSTEM_ACTOR = { userId: null, userName: 'Discovery', source: 'system' } as const;

/** Decrypts SNMP secrets inside the config for use by a provider. */
export function decryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(config ?? {})) as Record<string, unknown>;
  const snmp = out.snmp as { communities?: string[]; v3?: Record<string, string> } | undefined;
  if (snmp?.communities) snmp.communities = snmp.communities.map((c) => safeDecrypt(c));
  if (snmp?.v3) {
    if (snmp.v3.authKey) snmp.v3.authKey = safeDecrypt(snmp.v3.authKey);
    if (snmp.v3.privKey) snmp.v3.privKey = safeDecrypt(snmp.v3.privKey);
  }
  return out;
}
const safeDecrypt = (v: string) => {
  try {
    return decryptSecret(v);
  } catch {
    return '';
  }
};

class RunLog {
  private text = '';
  private truncated = false;
  add(line: string) {
    if (this.truncated) return;
    const entry = `${new Date().toISOString().slice(11, 19)} ${line}\n`;
    if (this.text.length + entry.length > LOG_CAP) {
      this.text += '... log truncated (50KB cap)\n';
      this.truncated = true;
      return;
    }
    this.text += entry;
  }
  toString() {
    return this.text;
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Discovery run ${runId} not found (not committed yet?)`);
  }
}

export interface ExecuteRunOptions {
  /** How often (ms) progress is flushed and the run row re-read for cancellation. Default 5s. */
  pollMs?: number;
}

/**
 * Executes one queued run. Throws RunNotFoundError when the row does not exist yet so the queue retries with backoff.
 * Progress is flushed every `pollMs`; at each flush the run status is re-read and the scan is aborted (provider
 * signal) when it has been cancelled via the API. Findings reconciled before the abort are kept.
 */
export async function executeRun(runId: string, signal?: AbortSignal, opts: ExecuteRunOptions = {}) {
  const loaded = await withSystem(async (tx) => {
    const [run] = await tx.select().from(discoveryRuns).where(eq(discoveryRuns.id, runId)).limit(1);
    if (!run) return null;
    const [source] = await tx.select().from(discoverySources).where(eq(discoverySources.id, run.sourceId)).limit(1);
    return { run, source };
  });
  if (!loaded) {
    logger.warn({ runId }, 'discovery run not found');
    throw new RunNotFoundError(runId);
  }
  const { run, source } = loaded;
  if (!source) {
    await withSystem((tx) => tx.update(discoveryRuns).set({ status: 'failed', error: 'Source no longer exists', finishedAt: new Date() }).where(eq(discoveryRuns.id, runId)));
    return;
  }
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return;

  const log = new RunLog();
  const stats: Record<string, number> = { hostsScanned: 0, responsive: 0, snmp: 0, findings: 0, newCis: 0, changed: 0, unchanged: 0, applied: 0, errors: 0 };
  const pollMs = Math.max(50, opts.pollMs ?? 5000);

  // Cancellation: the provider gets one signal that fires on worker shutdown (external signal) or when the run row turns 'cancelled'.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });

  let lastFlush = Date.now();
  let chain: Promise<void> = Promise.resolve();
  /** Flushes are serialised so a periodic progress write can never land after (and clobber) the final status write. */
  const flush = (patch: Partial<typeof discoveryRuns.$inferInsert> = {}) => {
    lastFlush = Date.now();
    chain = chain.then(() => withSystem((tx) => tx.update(discoveryRuns).set({ stats, log: log.toString(), ...patch }).where(eq(discoveryRuns.id, runId))).then(() => undefined, (err) => logger.warn({ err, runId }, 'discovery run flush failed')));
    return chain;
  };
  const checkCancelled = async () => {
    if (controller.signal.aborted) return;
    const [row] = await withSystem((tx) => tx.select({ status: discoveryRuns.status }).from(discoveryRuns).where(eq(discoveryRuns.id, runId)).limit(1)).catch(() => [] as { status: string }[]);
    if (row?.status === 'cancelled') {
      log.add('Cancellation requested; stopping the scan (findings reconciled so far are kept)');
      abort();
    }
  };
  const tick = async () => {
    await flush();
    await checkCancelled();
  };
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref?.();

  await withSystem((tx) => tx.update(discoveryRuns).set({ status: 'running', startedAt: new Date(), error: null }).where(eq(discoveryRuns.id, runId)));
  log.add(`Run started for source "${source.name}" (${source.sourceType})`);

  try {
    const provider = getProvider(source.sourceType);
    if (!provider) throw new Error(`No discovery provider registered for type "${source.sourceType}"`);
    const target: DiscoverySourceTarget = { id: source.id, customerId: source.customerId, siteId: source.siteId, name: source.name, sourceType: source.sourceType, config: decryptConfig(source.config) };

    const onFinding = async (raw: RawFinding) => {
      try {
        await withSystem(async (tx) => {
          const { finding } = await reconcileFinding(tx, { sourceId: source.id, runId, customerId: source.customerId, siteId: source.siteId }, raw);
          stats.findings++;
          if (finding.diffStatus === 'new') stats.newCis++;
          else if (finding.diffStatus === 'changed') stats.changed++;
          else stats.unchanged++;
          if (source.autoApply) {
            if (finding.diffStatus !== 'unchanged') {
              await applyFinding(tx, finding, SYSTEM_ACTOR);
              stats.applied++;
            } else {
              await tx.update(schema.discoveryFindings).set({ status: 'applied', appliedAt: new Date() }).where(eq(schema.discoveryFindings.id, finding.id));
            }
          }
        });
      } catch (err) {
        stats.errors++;
        log.add(`${raw.ipAddress}: failed to store finding: ${(err as Error).message}`);
      }
      if (Date.now() - lastFlush > pollMs) await tick();
    };

    const providerStats = await provider.discover(target, { log: (l) => log.add(l), onFinding, signal: controller.signal });
    Object.assign(stats, { hostsScanned: providerStats.hostsScanned, responsive: providerStats.responsive, snmp: providerStats.snmp });
    const cancelled = controller.signal.aborted;
    log.add(`${cancelled ? 'Cancelled' : 'Completed'}: ${stats.hostsScanned} scanned, ${stats.responsive} responsive, ${stats.snmp} via SNMP, ${stats.findings} findings (${stats.newCis} new, ${stats.changed} changed, ${stats.unchanged} unchanged${source.autoApply ? `, ${stats.applied} auto-applied` : ''})`);
    await flush({ status: cancelled ? 'cancelled' : 'completed', finishedAt: new Date() });
    await withSystem((tx) => tx.update(discoverySources).set({ lastRunAt: new Date() }).where(eq(discoverySources.id, source.id)));
  } catch (err) {
    const message = (err as Error).message?.slice(0, 2000) ?? 'Unknown error';
    log.add(`FAILED: ${message}`);
    logger.error({ err, runId }, 'discovery run failed');
    await flush({ status: 'failed', error: message, finishedAt: new Date() });
    await withSystem((tx) => tx.update(discoverySources).set({ lastRunAt: new Date() }).where(eq(discoverySources.id, source.id)));
  } finally {
    clearInterval(timer);
    signal?.removeEventListener('abort', abort);
    await chain.catch(() => undefined);
  }
}

/** Returns true when `cron` has an occurrence after `lastRunAt` (or ever, when never run) that is in the past. */
export function isCronDue(cron: string, lastRunAt: Date | null, now = new Date()): boolean {
  try {
    const prev = CronExpressionParser.parse(cron, { currentDate: now, tz: 'UTC' }).prev().toDate();
    if (!lastRunAt) return true;
    return prev.getTime() > lastRunAt.getTime();
  } catch {
    return false;
  }
}

/** Scheduler tick: enqueues a run for every active, cron-scheduled source that is due and not already queued/running. */
export async function scheduleDueSources(now = new Date()) {
  const due = await withSystem(async (tx) => {
    const sources = await tx.select().from(discoverySources).where(and(eq(discoverySources.isActive, true), isNotNull(discoverySources.scheduleCron)));
    const candidates = sources.filter((s) => s.scheduleCron && isCronDue(s.scheduleCron, s.lastRunAt, now));
    if (!candidates.length) return [];
    const busy = await tx
      .select({ sourceId: discoveryRuns.sourceId })
      .from(discoveryRuns)
      .where(and(inArray(discoveryRuns.sourceId, candidates.map((c) => c.id)), inArray(discoveryRuns.status, ['queued', 'running']), sql`${discoveryRuns.createdAt} > now() - interval '6 hours'`));
    const busyIds = new Set(busy.map((b) => b.sourceId));
    const created: { runId: string; sourceId: string }[] = [];
    for (const s of candidates) {
      if (busyIds.has(s.id)) continue;
      const [run] = await tx.insert(discoveryRuns).values({ sourceId: s.id, customerId: s.customerId, status: 'queued', triggeredBy: null, log: 'Scheduled run\n' }).returning({ id: discoveryRuns.id });
      // Stamp lastRunAt now so a scheduler tick never double-enqueues while the run waits.
      await tx.update(discoverySources).set({ lastRunAt: now }).where(eq(discoverySources.id, s.id));
      created.push({ runId: run.id, sourceId: s.id });
    }
    return created;
  });
  for (const c of due) await enqueue('discovery', 'run', { runId: c.runId }, { jobId: `discovery-run-${c.runId}` });
  if (due.length) logger.info({ count: due.length }, 'discovery runs scheduled');
  return due.length;
}
