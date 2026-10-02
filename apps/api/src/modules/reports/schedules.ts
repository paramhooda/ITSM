import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import type { Tx } from '@/db/client';
import { NotFoundError, ValidationError } from '@/core/errors';
import { diffChanges } from '@/core/audit';
import { enqueue } from '@/jobs/queues';
import { findReport, requireReport, isCustomerUser } from './registry';
import { DATE_RANGE_PRESETS, isValidTimezone } from './dates';

export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'cron'] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const FORMATS = ['csv', 'html', 'both'] as const;
export const DELIVERIES = ['email', 'portal', 'both'] as const;

export type ScheduleRow = typeof schema.reportSchedules.$inferSelect;

export const scheduleInput = z.object({
  name: z.string().trim().min(1).max(200),
  reportKey: z.string().trim().min(1).max(100),
  customerId: z.string().uuid().nullable().optional(),
  recipients: z.array(z.string().trim().email().max(320)).max(100).default([]),
  recipientUserIds: z.array(z.string().uuid()).max(100).default([]),
  frequency: z.enum(FREQUENCIES).default('weekly'),
  cronExpression: z.string().trim().max(120).nullable().optional(),
  timezone: z.string().trim().max(64).default('UTC'),
  dateRange: z.enum(DATE_RANGE_PRESETS).default('last_7_days'),
  /** Report parameters plus `customerContacts` (bool) and `perCustomer` (bool). */
  filters: z.record(z.string(), z.unknown()).default({}),
  format: z.enum(FORMATS).default('html'),
  delivery: z.enum(DELIVERIES).default('email'),
  isActive: z.boolean().default(true),
});
export type ScheduleInput = z.infer<typeof scheduleInput>;
/** Patch schema without defaults so a partial update never resets untouched fields. */
export const schedulePatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  reportKey: z.string().trim().min(1).max(100).optional(),
  customerId: z.string().uuid().nullable().optional(),
  recipients: z.array(z.string().trim().email().max(320)).max(100).optional(),
  recipientUserIds: z.array(z.string().uuid()).max(100).optional(),
  frequency: z.enum(FREQUENCIES).optional(),
  cronExpression: z.string().trim().max(120).nullable().optional(),
  timezone: z.string().trim().max(64).optional(),
  dateRange: z.enum(DATE_RANGE_PRESETS).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  format: z.enum(FORMATS).optional(),
  delivery: z.enum(DELIVERIES).optional(),
  isActive: z.boolean().optional(),
});

const FREQUENCY_CRON: Record<Exclude<Frequency, 'cron'>, string> = {
  daily: '0 7 * * *',
  weekly: '0 7 * * 1',
  monthly: '0 7 1 * *',
  quarterly: '0 7 1 1,4,7,10 *',
};

/** Next run strictly after `from`, in the schedule's timezone. */
export function computeNextRun(s: { frequency: string; cronExpression?: string | null; timezone?: string | null }, from = new Date()): Date {
  const expr = s.frequency === 'cron' ? (s.cronExpression ?? '').trim() : FREQUENCY_CRON[s.frequency as Exclude<Frequency, 'cron'>];
  if (!expr) throw new ValidationError('A cron expression is required for custom schedules');
  const tz = s.timezone && isValidTimezone(s.timezone) ? s.timezone : 'UTC';
  try {
    return CronExpressionParser.parse(expr, { currentDate: from, tz }).next().toDate();
  } catch (err) {
    throw new ValidationError(`Invalid cron expression: ${(err as Error).message}`);
  }
}

function validate(ctx: Ctx, input: Partial<ScheduleInput>, existing?: ScheduleRow) {
  const reportKey = input.reportKey ?? existing?.reportKey;
  if (!reportKey) throw new ValidationError('reportKey is required');
  const def = findReport(reportKey);
  if (!def) throw new ValidationError(`Unknown report: ${reportKey}`);
  const customerId = input.customerId === undefined ? existing?.customerId ?? null : input.customerId;
  if (customerId) ctx.requireCustomer(customerId);
  requireReport(ctx, reportKey, customerId);
  const frequency = input.frequency ?? existing?.frequency ?? 'weekly';
  const cronExpression = input.cronExpression === undefined ? existing?.cronExpression ?? null : input.cronExpression;
  if (frequency === 'cron') {
    if (!cronExpression) throw new ValidationError('A cron expression is required for custom schedules');
    const next = computeNextRun({ frequency, cronExpression, timezone: input.timezone ?? existing?.timezone });
    const after = computeNextRun({ frequency, cronExpression, timezone: input.timezone ?? existing?.timezone }, next);
    if (after.getTime() - next.getTime() < 60 * 60_000) throw new ValidationError('Schedules may not run more often than hourly');
  }
  const timezone = input.timezone ?? existing?.timezone ?? 'UTC';
  if (!isValidTimezone(timezone)) throw new ValidationError(`Unknown timezone: ${timezone}`);
  const format = input.format ?? existing?.format;
  if (format && !(FORMATS as readonly string[]).includes(format)) throw new ValidationError('Invalid format');
  return { def, customerId, frequency, cronExpression, timezone };
}

const view = <T extends ScheduleRow>(s: T) => ({ ...s, reportName: findReport(s.reportKey)?.name ?? s.reportKey });

async function decorate(tx: Tx, list: ScheduleRow[]) {
  if (!list.length) return [];
  const customerIds = [...new Set(list.map((s) => s.customerId).filter((x): x is string => !!x))];
  const userIds = [...new Set([...list.flatMap((s) => s.recipientUserIds), ...list.map((s) => s.createdBy).filter((x): x is string => !!x)])];
  // one client per transaction: run the lookups sequentially
  const customers = customerIds.length ? await tx.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(inArray(schema.customers.id, customerIds)) : [];
  const users = userIds.length ? await tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
  const lastRuns = await tx.execute(sql`SELECT DISTINCT ON (schedule_id) schedule_id, status, finished_at, error FROM report_runs WHERE schedule_id = ANY(ARRAY[${sql.join(list.map((s) => sql`${s.id}::uuid`), sql`, `)}]) ORDER BY schedule_id, created_at DESC`);
  const cmap = new Map(customers.map((c) => [c.id, c.name]));
  const umap = new Map(users.map((u) => [u.id, u]));
  const lmap = new Map((lastRuns.rows as { schedule_id: string; status: string; error: string | null }[]).map((r) => [r.schedule_id, r]));
  return list.map((s) => view({ ...s, customerName: s.customerId ? cmap.get(s.customerId) ?? null : null, createdByName: s.createdBy ? umap.get(s.createdBy)?.name ?? null : null, recipientUsers: s.recipientUserIds.map((id) => umap.get(id)).filter((u): u is { id: string; name: string; email: string } => !!u), lastRunStatus: lmap.get(s.id)?.status ?? null, lastRunError: lmap.get(s.id)?.error ?? null }));
}

export async function listSchedules(ctx: Ctx, q: { customerId?: string; reportKey?: string; isActive?: boolean } = {}) {
  ctx.require('reports:manage');
  const conds = [];
  if (q.customerId) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(schema.reportSchedules.customerId, q.customerId));
  }
  if (q.reportKey) conds.push(eq(schema.reportSchedules.reportKey, q.reportKey));
  if (q.isActive !== undefined) conds.push(eq(schema.reportSchedules.isActive, q.isActive));
  const list = await ctx.tx.select().from(schema.reportSchedules).where(conds.length ? and(...conds) : undefined).orderBy(desc(schema.reportSchedules.isActive), schema.reportSchedules.nextRunAt, schema.reportSchedules.name).limit(1000);
  return { items: await decorate(ctx.tx, list), total: list.length };
}

export async function loadSchedule(ctx: Ctx, id: string): Promise<ScheduleRow> {
  const [row] = await ctx.tx.select().from(schema.reportSchedules).where(eq(schema.reportSchedules.id, id)).limit(1);
  if (!row) throw new NotFoundError('Schedule');
  if (row.customerId) ctx.requireCustomer(row.customerId);
  return row;
}

export async function getSchedule(ctx: Ctx, id: string) {
  ctx.require('reports:manage');
  const row = await loadSchedule(ctx, id);
  return (await decorate(ctx.tx, [row]))[0]!;
}

export async function createSchedule(ctx: Ctx, input: ScheduleInput) {
  ctx.require('reports:manage');
  if (isCustomerUser(ctx)) throw new ValidationError('Schedules are managed by the service provider');
  const { customerId, frequency, cronExpression, timezone } = validate(ctx, input);
  if (!input.recipients.length && !input.recipientUserIds.length && !input.filters.customerContacts && input.delivery === 'email') throw new ValidationError('At least one recipient is required for email delivery');
  const nextRunAt = input.isActive ? computeNextRun({ frequency, cronExpression, timezone }) : null;
  const [row] = await ctx.tx
    .insert(schema.reportSchedules)
    .values({ ...input, customerId, frequency, cronExpression, timezone, nextRunAt, createdBy: ctx.user.apiKeyId ? null : ctx.user.id })
    .returning();
  await ctx.audit({ entityType: 'report_schedule', entityId: row.id, entityLabel: row.name, action: 'create', customerId, metadata: { reportKey: row.reportKey, frequency, nextRunAt } });
  return (await decorate(ctx.tx, [row]))[0]!;
}

export async function updateSchedule(ctx: Ctx, id: string, patch: Partial<ScheduleInput>) {
  ctx.require('reports:manage');
  const before = await loadSchedule(ctx, id);
  const { customerId, frequency, cronExpression, timezone } = validate(ctx, patch, before);
  const merged = { ...before, ...patch, customerId, frequency, cronExpression, timezone };
  const scheduleChanged = ['frequency', 'cronExpression', 'timezone', 'isActive'].some((k) => k in patch);
  const nextRunAt = !merged.isActive ? null : scheduleChanged || !before.nextRunAt ? computeNextRun(merged) : before.nextRunAt;
  const [row] = await ctx.tx
    .update(schema.reportSchedules)
    .set({ ...patch, customerId, frequency, cronExpression, timezone, nextRunAt, updatedAt: new Date() })
    .where(eq(schema.reportSchedules.id, id))
    .returning();
  await ctx.audit({ entityType: 'report_schedule', entityId: id, entityLabel: row.name, action: 'update', customerId: row.customerId, changes: diffChanges(before as unknown as Record<string, unknown>, { ...patch, nextRunAt } as Record<string, unknown>) });
  return (await decorate(ctx.tx, [row]))[0]!;
}

export async function deleteSchedule(ctx: Ctx, id: string) {
  ctx.require('reports:manage');
  const row = await loadSchedule(ctx, id);
  await ctx.tx.delete(schema.reportSchedules).where(eq(schema.reportSchedules.id, id));
  await ctx.audit({ entityType: 'report_schedule', entityId: id, entityLabel: row.name, action: 'delete', customerId: row.customerId });
  return { ok: true };
}

/** Queues an immediate execution of the schedule on the reports worker. */
export async function runScheduleNow(ctx: Ctx, id: string) {
  ctx.require('reports:manage');
  const row = await loadSchedule(ctx, id);
  const job = await enqueue('reports', 'run-schedule', { scheduleId: row.id, manual: true, requestedBy: ctx.user.apiKeyId ? null : ctx.user.id }, { jobId: `schedule:${row.id}:manual-${Date.now()}` });
  await ctx.audit({ entityType: 'report_schedule', entityId: id, entityLabel: row.name, action: 'run_now', customerId: row.customerId, metadata: { jobId: job?.id ?? null } });
  return { queued: !!job, jobId: job?.id ?? null };
}

/** Marks a schedule as executed and advances nextRunAt (used by the worker). */
export async function advanceSchedule(tx: Tx, s: ScheduleRow, ranAt = new Date()) {
  const nextRunAt = s.isActive ? computeNextRun(s, ranAt) : null;
  await tx.update(schema.reportSchedules).set({ lastRunAt: ranAt, nextRunAt, updatedAt: ranAt }).where(eq(schema.reportSchedules.id, s.id));
  return nextRunAt;
}
