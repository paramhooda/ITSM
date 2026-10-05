import { eq, and, lte, inArray, isNotNull } from 'drizzle-orm';
import { registerProcessor, registerSchedule } from '../workers';
import { withSystem, schema } from '@/db/client';
import { enqueue } from '@/jobs/queues';
import { logger } from '@/core/logger';
import { writeAudit } from '@/core/audit';
import { systemCtx } from '@/modules/tickets/common';
import { resolveReport } from '@/modules/reports/registry';
import { executeReport, queueReportEmail } from '@/modules/reports/service';
import { advanceSchedule, scheduleFormats, type ScheduleRow } from '@/modules/reports/schedules';
import type { Tx } from '@/db/client';

const SYSTEM_ACTOR = { userId: null, userName: 'system', source: 'system' };

/**
 * Scheduled reports. Every 5 minutes the scheduler enqueues one `run-schedule`
 * job per due schedule (idempotent job id per schedule + due time). The run
 * job renders the report(s) with the system principal, stores customer-scoped
 * run rows + attachments and queues delivery emails through the outbox.
 */
export async function enqueueDueSchedules(now = new Date()) {
  const due = await withSystem((tx) =>
    tx.select({ id: schema.reportSchedules.id, nextRunAt: schema.reportSchedules.nextRunAt }).from(schema.reportSchedules).where(and(eq(schema.reportSchedules.isActive, true), isNotNull(schema.reportSchedules.nextRunAt), lte(schema.reportSchedules.nextRunAt, now))).limit(500),
  );
  let queued = 0;
  for (const s of due) {
    const job = await enqueue('reports', 'run-schedule', { scheduleId: s.id, dueAt: s.nextRunAt?.toISOString() ?? null }, { jobId: `schedule:${s.id}:${s.nextRunAt?.getTime() ?? Date.now()}` });
    if (job) queued++;
  }
  if (due.length) logger.info({ due: due.length, queued }, 'report schedules enqueued');
  return { due: due.length, queued };
}

/** Email addresses for a schedule run: explicit emails + users + (optionally) the customer's primary/escalation contacts. */
export async function scheduleRecipients(tx: Tx, s: ScheduleRow, customerId: string | null): Promise<string[]> {
  const emails = new Set<string>(s.recipients.map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (s.recipientUserIds.length) {
    const users = await tx.select({ email: schema.users.email, status: schema.users.status }).from(schema.users).where(inArray(schema.users.id, s.recipientUserIds));
    for (const u of users) if (u.status === 'active' && u.email) emails.add(u.email.toLowerCase());
  }
  if (s.filters?.customerContacts === true && customerId) {
    const contacts = await tx
      .select({ email: schema.contacts.email, isPrimary: schema.contacts.isPrimary, isEscalation: schema.contacts.isEscalation })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.customerId, customerId), eq(schema.contacts.isActive, true), isNotNull(schema.contacts.email)));
    for (const c of contacts) if ((c.isPrimary || c.isEscalation) && c.email) emails.add(c.email.toLowerCase());
  }
  return [...emails];
}

export interface ExecuteOptions {
  manual?: boolean;
  requestedBy?: string | null;
}

/** Executes a schedule: one run per target customer (or a single MSP-wide run), delivery, and nextRunAt advance. */
export async function executeSchedule(scheduleId: string, opts: ExecuteOptions = {}) {
  const [schedule] = await withSystem((tx) => tx.select().from(schema.reportSchedules).where(eq(schema.reportSchedules.id, scheduleId)).limit(1));
  if (!schedule) {
    logger.warn({ scheduleId }, 'report schedule not found');
    return { skipped: 'missing' as const };
  }
  if (!schedule.isActive && !opts.manual) return { skipped: 'inactive' as const };
  const def = await withSystem((tx) => resolveReport(systemCtx(tx, `schedule:${scheduleId}`), schedule.reportKey));
  if (!def) throw new Error(`Unknown report ${schedule.reportKey} on schedule ${schedule.name}`);

  const targets: (string | null)[] = schedule.customerId
    ? [schedule.customerId]
    : schedule.filters?.perCustomer === true
      ? (await withSystem((tx) => tx.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.isActive, true)).orderBy(schema.customers.name).limit(2000))).map((c) => c.id)
      : [null];
  const formats = scheduleFormats(schedule.format);
  const email = schedule.delivery === 'email' || schedule.delivery === 'both';
  const portal = schedule.delivery === 'portal' || schedule.delivery === 'both';
  const { customerContacts: _cc, perCustomer: _pc, ...filters } = (schedule.filters ?? {}) as Record<string, unknown>;

  const failures: { customerId: string | null; error: string }[] = [];
  let runs = 0;
  let emails = 0;
  for (const customerId of targets) {
    try {
      await withSystem(async (tx) => {
        const ctx = systemCtx(tx, `schedule:${schedule.id}`);
        const outcomes = [];
        for (const format of formats) {
          outcomes.push(await executeReport(ctx, { reportKey: schedule.reportKey, parameters: { ...filters, customerId, dateRange: schedule.dateRange }, format, scheduleId: schedule.id, portalVisible: portal, requestedBy: opts.requestedBy ?? schedule.createdBy ?? null, timezone: schedule.timezone }));
        }
        runs += outcomes.length;
        if (email) {
          const recipients = await scheduleRecipients(tx, schedule, customerId);
          const first = outcomes[0]!;
          emails += await queueReportEmail(tx, {
            recipients,
            customerId,
            reportName: first.run?.name ?? def.name,
            period: first.range.label,
            result: first.result,
            attachments: outcomes.filter((o) => o.attachment).map((o) => ({ attachmentId: o.attachment!.id, filename: o.attachment!.filename, contentType: o.attachment!.contentType })),
            runIds: outcomes.map((o) => o.run!.id),
            scheduleName: schedule.name,
          });
          if (!recipients.length) logger.warn({ scheduleId: schedule.id, customerId }, 'report schedule has no recipients');
        }
      });
    } catch (err) {
      const message = String((err as Error).message ?? err).slice(0, 2000);
      failures.push({ customerId, error: message });
      logger.error({ scheduleId: schedule.id, customerId, err: message }, 'scheduled report failed');
      await withSystem((tx) =>
        tx.insert(schema.reportRuns).values({ scheduleId: schedule.id, reportKey: schedule.reportKey, customerId, name: def.name, parameters: { ...filters, dateRange: schedule.dateRange }, format: schedule.format, status: 'failed', error: message, portalVisible: false, requestedBy: opts.requestedBy ?? schedule.createdBy ?? null, startedAt: new Date(), finishedAt: new Date() }),
      ).catch((e) => logger.error({ err: e }, 'could not record failed report run'));
    }
  }

  const ranAt = new Date();
  await withSystem(async (tx) => {
    const nextRunAt = opts.manual ? (await tx.update(schema.reportSchedules).set({ lastRunAt: ranAt, updatedAt: ranAt }).where(eq(schema.reportSchedules.id, schedule.id)), schedule.nextRunAt) : await advanceSchedule(tx, schedule, ranAt);
    await writeAudit(tx, SYSTEM_ACTOR, { entityType: 'report_schedule', entityId: schedule.id, entityLabel: schedule.name, action: opts.manual ? 'run_manual' : 'run_scheduled', customerId: schedule.customerId, metadata: { targets: targets.length, runs, emails, failures: failures.length, nextRunAt, requestedBy: opts.requestedBy ?? null } });
  });
  logger.info({ scheduleId: schedule.id, name: schedule.name, targets: targets.length, runs, emails, failures: failures.length }, 'report schedule executed');
  if (failures.length && failures.length === targets.length) throw new Error(`Report schedule ${schedule.name} failed: ${failures[0]!.error}`);
  return { targets: targets.length, runs, emails, failures };
}

registerSchedule({ queue: 'reports', jobName: 'reports-scheduler', pattern: '*/5 * * * *' });
registerProcessor({ queue: 'reports', jobName: 'reports-scheduler', processor: async () => enqueueDueSchedules() });
registerProcessor({
  queue: 'reports',
  jobName: 'run-schedule',
  concurrency: 2,
  processor: async (job) => {
    const { scheduleId, manual, requestedBy } = job.data as { scheduleId: string; manual?: boolean; requestedBy?: string | null };
    return executeSchedule(scheduleId, { manual, requestedBy });
  },
});
