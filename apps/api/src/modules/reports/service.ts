import { randomUUID } from 'node:crypto';
import { eq, and, desc, sql, inArray, type SQL } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema, type Tx } from '@/db/client';
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors';
import { storage, storageKeyFor, sha256Buffer } from '@/lib/storage';
import { render, emailLayout } from '@/lib/templates';
import { config } from '@/config';
import { enqueue } from '@/jobs/queues';
import { logger } from '@/core/logger';
import './definitions';
import { requireReport, visibleReports, describeReport, isCustomerUser, MAX_REPORT_ROWS, type ReportDefinition, type ReportParams, type ReportResult } from './registry';
import { resolveDateRange, todayIn, type DateRange } from './dates';
import { renderCsv, renderHtml, summaryHtml } from './render';

export const PREVIEW_MAX_ROWS = 5000;
export type RunRow = typeof schema.reportRuns.$inferSelect;
export type ReportFormat = 'json' | 'csv' | 'html';

export interface RunInput {
  reportKey: string;
  parameters?: Record<string, unknown>;
  format?: ReportFormat;
  scheduleId?: string | null;
  portalVisible?: boolean;
  requestedBy?: string | null;
  /** Timezone used to resolve relative date presets (defaults to the user's). */
  timezone?: string;
}

// ---------------------------------------------------------------- definitions

export async function listDefinitions(ctx: Ctx) {
  if (isCustomerUser(ctx) && !ctx.can('portal:reports', ctx.user.customerId)) throw new ForbiddenError('Missing permission: portal:reports');
  const items = visibleReports(ctx).map(describeReport);
  return { items, customerId: isCustomerUser(ctx) ? ctx.user.customerId : null, canManage: !isCustomerUser(ctx) && ctx.can('reports:manage') };
}

// ---------------------------------------------------------------- parameter normalization

function resolveCustomerId(ctx: Ctx, raw: Record<string, unknown>): string | null {
  if (isCustomerUser(ctx)) {
    if (!ctx.user.customerId) throw new ForbiddenError('Customer context required');
    return ctx.user.customerId;
  }
  const v = raw.customerId;
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v)) throw new ValidationError('Invalid customerId');
  ctx.requireCustomer(v);
  return v;
}

export function normalizeParams(ctx: Ctx, def: ReportDefinition, raw: Record<string, unknown> = {}, timezone?: string): { params: ReportParams; range: DateRange } {
  const customerId = resolveCustomerId(ctx, raw);
  const today = todayIn(timezone ?? ctx.user.timezone ?? 'UTC');
  const preset = typeof raw.dateRange === 'string' ? raw.dateRange : def.defaultDateRange ?? 'last_30_days';
  const range = resolveDateRange(preset, { from: typeof raw.from === 'string' ? raw.from : null, to: typeof raw.to === 'string' ? raw.to : null }, today);
  const params: ReportParams = { customerId, from: range.from, to: range.to };
  for (const p of def.parameters) {
    if (p.type === 'customer' || p.type === 'daterange') continue;
    const v = raw[p.key];
    if (v === undefined || v === null || v === '') {
      if (p.default !== undefined) params[p.key] = p.default;
      else if (p.required) throw new ValidationError(`${p.label} is required`);
      continue;
    }
    switch (p.type) {
      case 'boolean':
        params[p.key] = v === true || v === 'true' || v === '1' || v === 1;
        break;
      case 'number': {
        const n = Number(v);
        if (isNaN(n)) throw new ValidationError(`${p.label} must be a number`);
        params[p.key] = n;
        break;
      }
      case 'multiselect':
        params[p.key] = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
        break;
      default: {
        const s = String(v).trim().slice(0, 500);
        if (p.type === 'select' && p.options && !p.options.some((o) => o.value === s)) throw new ValidationError(`Invalid value for ${p.label}`);
        params[p.key] = s;
      }
    }
  }
  return { params, range };
}

// ---------------------------------------------------------------- execution

async function platformName(tx: Tx) {
  const [row] = await tx.select({ value: schema.systemSettings.value }).from(schema.systemSettings).where(eq(schema.systemSettings.key, 'platform.name')).limit(1);
  return typeof row?.value === 'string' && row.value ? row.value : 'Progression';
}

async function customerName(tx: Tx, id: string | null) {
  if (!id) return null;
  const [row] = await tx.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, id)).limit(1);
  return row?.name ?? null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Stores a generated file as an attachment of the run (customer-scoped, portal visibility follows the run). */
async function storeReportFile(ctx: Ctx, run: RunRow, buffer: Buffer, filename: string, contentType: string) {
  const id = randomUUID();
  const storageKey = storageKeyFor(run.customerId, id, filename);
  await storage.put(storageKey, buffer);
  try {
    const [row] = await ctx.tx
      .insert(schema.attachments)
      .values({ id, customerId: run.customerId, entityType: 'report_run', entityId: run.id, filename, contentType, size: buffer.length, storageKey, sha256: sha256Buffer(buffer), docType: 'report', title: run.name, customerVisible: run.portalVisible, uploadedBy: ctx.user.apiKeyId || ctx.user.isSystem ? null : ctx.user.id })
      .returning();
    await ctx.audit({ entityType: 'attachment', entityId: id, entityLabel: filename, action: 'upload', customerId: run.customerId, metadata: { parentType: 'report_run', parentId: run.id, parentLabel: run.name, size: buffer.length, contentType, customerVisible: run.portalVisible, docType: 'report' } });
    return row;
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined);
    throw err;
  }
}

export interface ExecutionOutcome {
  def: ReportDefinition;
  params: ReportParams;
  range: DateRange;
  result: ReportResult;
  run: RunRow | null;
  attachment: typeof schema.attachments.$inferSelect | null;
}

/** Runs a report; for csv/html also stores the file and the run record. */
export async function executeReport(ctx: Ctx, input: RunInput): Promise<ExecutionOutcome> {
  const raw = input.parameters ?? {};
  const customerId = resolveCustomerId(ctx, raw);
  const def = requireReport(ctx, input.reportKey, customerId);
  const { params, range } = normalizeParams(ctx, def, raw, input.timezone);
  const format = input.format ?? 'json';
  if (!['json', 'csv', 'html'].includes(format)) throw new ValidationError('format must be json, csv or html');
  const started = new Date();
  const result = await def.run(ctx, params);
  if (result.rows.length > MAX_REPORT_ROWS) {
    result.rows = result.rows.slice(0, MAX_REPORT_ROWS);
    result.truncated = true;
  }
  if (format === 'json') return { def, params, range, result, run: null, attachment: null };

  const cname = await customerName(ctx.tx, params.customerId);
  const name = cname ? `${def.name} - ${cname}` : def.name;
  const portalVisible = input.portalVisible ?? isCustomerUser(ctx);
  const [run] = await ctx.tx
    .insert(schema.reportRuns)
    .values({ scheduleId: input.scheduleId ?? null, reportKey: def.key, customerId: params.customerId, name, parameters: { ...params, dateRange: range.preset, period: range.label }, format, status: 'running', portalVisible, requestedBy: input.requestedBy === undefined ? (ctx.user.apiKeyId || ctx.user.isSystem ? null : ctx.user.id) : input.requestedBy, startedAt: started })
    .returning();
  try {
    const brand = await platformName(ctx.tx);
    const buffer = format === 'csv' ? renderCsv(result) : Buffer.from(renderHtml(result, { reportName: def.name, description: def.description, platformName: brand, customerName: cname, period: range.label, generatedAt: new Date(), generatedBy: ctx.user.isSystem ? 'scheduled report' : ctx.user.name, parameters: params }), 'utf8');
    const filename = `${slug(def.name)}${cname ? `_${slug(cname)}` : ''}_${range.from}_${range.to}.${format}`;
    const attachment = await storeReportFile(ctx, run, buffer, filename, format === 'csv' ? 'text/csv' : 'text/html');
    const [done] = await ctx.tx.update(schema.reportRuns).set({ status: 'completed', attachmentId: attachment.id, rowCount: result.rows.length, finishedAt: new Date() }).where(eq(schema.reportRuns.id, run.id)).returning();
    await ctx.audit({ entityType: 'report_run', entityId: run.id, entityLabel: name, action: 'create', customerId: params.customerId, metadata: { reportKey: def.key, format, rowCount: result.rows.length, scheduleId: input.scheduleId ?? null, portalVisible, period: range.label } });
    return { def, params, range, result, run: done, attachment };
  } catch (err) {
    await ctx.tx.update(schema.reportRuns).set({ status: 'failed', error: String((err as Error).message ?? err).slice(0, 2000), finishedAt: new Date() }).where(eq(schema.reportRuns.id, run.id));
    throw err;
  }
}

/** Route-facing runner: json preview (capped) or stored file run. */
export async function runReport(ctx: Ctx, input: RunInput) {
  const out = await executeReport(ctx, input);
  if (!out.run) {
    const total = out.result.rows.length;
    return {
      report: describeReport(out.def),
      parameters: out.params,
      period: out.range,
      result: { ...out.result, rows: out.result.rows.slice(0, PREVIEW_MAX_ROWS), truncated: out.result.truncated || total > PREVIEW_MAX_ROWS, rowCount: total },
    };
  }
  return getRun(ctx, out.run.id);
}

// ---------------------------------------------------------------- runs

export interface RunsQuery {
  reportKey?: string;
  customerId?: string;
  scheduleId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

function runVisibility(ctx: Ctx): SQL[] {
  const r = schema.reportRuns;
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:reports', ctx.user.customerId)) throw new ForbiddenError('Missing permission: portal:reports');
    return [eq(r.customerId, ctx.user.customerId ?? '00000000-0000-0000-0000-000000000000'), eq(r.portalVisible, true), eq(r.status, 'completed')];
  }
  ctx.require('reports:run');
  const keys = visibleReports(ctx).map((d) => d.key);
  return [keys.length ? inArray(r.reportKey, keys) : sql`false`];
}

const runColumns = {
  id: schema.reportRuns.id,
  scheduleId: schema.reportRuns.scheduleId,
  scheduleName: schema.reportSchedules.name,
  reportKey: schema.reportRuns.reportKey,
  customerId: schema.reportRuns.customerId,
  customerName: schema.customers.name,
  name: schema.reportRuns.name,
  parameters: schema.reportRuns.parameters,
  format: schema.reportRuns.format,
  status: schema.reportRuns.status,
  attachmentId: schema.reportRuns.attachmentId,
  filename: schema.attachments.filename,
  contentType: schema.attachments.contentType,
  size: schema.attachments.size,
  rowCount: schema.reportRuns.rowCount,
  error: schema.reportRuns.error,
  deliveredTo: schema.reportRuns.deliveredTo,
  portalVisible: schema.reportRuns.portalVisible,
  requestedBy: schema.reportRuns.requestedBy,
  requestedByName: schema.users.name,
  startedAt: schema.reportRuns.startedAt,
  finishedAt: schema.reportRuns.finishedAt,
  createdAt: schema.reportRuns.createdAt,
};

function runsBase(ctx: Ctx) {
  return ctx.tx
    .select(runColumns)
    .from(schema.reportRuns)
    .leftJoin(schema.reportSchedules, eq(schema.reportSchedules.id, schema.reportRuns.scheduleId))
    .leftJoin(schema.customers, eq(schema.customers.id, schema.reportRuns.customerId))
    .leftJoin(schema.attachments, eq(schema.attachments.id, schema.reportRuns.attachmentId))
    .leftJoin(schema.users, eq(schema.users.id, schema.reportRuns.requestedBy));
}

export async function listRuns(ctx: Ctx, q: RunsQuery = {}) {
  const r = schema.reportRuns;
  const conds = runVisibility(ctx);
  if (q.reportKey) conds.push(eq(r.reportKey, q.reportKey));
  if (q.customerId && !isCustomerUser(ctx)) {
    ctx.requireCustomer(q.customerId);
    conds.push(eq(r.customerId, q.customerId));
  }
  if (q.scheduleId) conds.push(eq(r.scheduleId, q.scheduleId));
  if (q.status) conds.push(eq(r.status, q.status));
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
  const where = and(...conds);
  const [{ count }] = await ctx.tx.select({ count: sql<number>`count(*)::int` }).from(r).where(where);
  const items = await runsBase(ctx).where(where).orderBy(desc(r.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  return { items, total: count, page, pageSize };
}

export async function getRun(ctx: Ctx, id: string) {
  const [row] = await runsBase(ctx).where(and(eq(schema.reportRuns.id, id), ...runVisibility(ctx))).limit(1);
  if (!row) throw new NotFoundError('Report run');
  return row;
}

export async function deleteRun(ctx: Ctx, id: string) {
  ctx.require('reports:manage');
  const run = await getRun(ctx, id);
  if (run.attachmentId) {
    const [att] = await ctx.tx.select().from(schema.attachments).where(eq(schema.attachments.id, run.attachmentId)).limit(1);
    if (att) {
      await ctx.tx.delete(schema.attachments).where(eq(schema.attachments.id, att.id));
      await storage.delete(att.storageKey).catch((err) => logger.warn({ err, key: att.storageKey }, 'could not delete report file'));
    }
  }
  await ctx.tx.delete(schema.reportRuns).where(eq(schema.reportRuns.id, id));
  await ctx.audit({ entityType: 'report_run', entityId: id, entityLabel: run.name, action: 'delete', customerId: run.customerId });
  return { ok: true };
}

export async function updateRun(ctx: Ctx, id: string, patch: { portalVisible?: boolean }) {
  ctx.require('reports:manage');
  const run = await getRun(ctx, id);
  if (patch.portalVisible !== undefined && patch.portalVisible !== run.portalVisible) {
    await ctx.tx.update(schema.reportRuns).set({ portalVisible: patch.portalVisible }).where(eq(schema.reportRuns.id, id));
    if (run.attachmentId) await ctx.tx.update(schema.attachments).set({ customerVisible: patch.portalVisible }).where(eq(schema.attachments.id, run.attachmentId));
    await ctx.audit({ entityType: 'report_run', entityId: id, entityLabel: run.name, action: 'update', customerId: run.customerId, changes: { portalVisible: { old: run.portalVisible, new: patch.portalVisible } } });
  }
  return getRun(ctx, id);
}

// ---------------------------------------------------------------- email delivery (outbox with attachments)

export interface ReportEmailInput {
  recipients: string[];
  customerId: string | null;
  reportName: string;
  period: string;
  result: ReportResult;
  attachments: { attachmentId: string; filename: string; contentType: string }[];
  runIds: string[];
  scheduleName?: string | null;
}

/** Writes one outbox email per recipient (template `report.delivered`) with the generated files attached. */
export async function queueReportEmail(tx: Tx, input: ReportEmailInput) {
  const recipients = [...new Set(input.recipients.map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+$/.test(e)))];
  if (!recipients.length) return 0;
  const [template] = await tx.select().from(schema.notificationTemplates).where(and(eq(schema.notificationTemplates.event, 'report.delivered'), eq(schema.notificationTemplates.channel, 'email'), eq(schema.notificationTemplates.isActive, true))).limit(1);
  const brand = await platformName(tx);
  const data = { platformName: brand, appUrl: config.APP_URL, report: { name: input.reportName, period: input.period, summaryHtml: summaryHtml(input.result), scheduleName: input.scheduleName ?? null, link: `${config.APP_URL.replace(/\/$/, '')}/reports?tab=history` } };
  let subject = `${input.reportName} - ${input.period}`;
  let html: string;
  try {
    subject = template ? render(template.subject ?? subject, data) : subject;
    html = emailLayout(subject, template ? render(template.body, data) : `<p>Please find attached the <strong>${input.reportName}</strong> for ${input.period}.</p>${data.report.summaryHtml}`);
  } catch (err) {
    logger.warn({ err }, 'report.delivered template render failed');
    html = emailLayout(subject, `<p>Please find attached the <strong>${input.reportName}</strong> for ${input.period}.</p>`);
  }
  for (const recipient of recipients) {
    await tx.insert(schema.notificationOutbox).values({ channel: 'email', event: 'report.delivered', customerId: input.customerId, recipient, subject, body: html, bodyText: `${input.reportName} for ${input.period} is attached.`, attachments: input.attachments, entityType: 'report_run', entityId: input.runIds[0] ?? null });
  }
  if (input.runIds.length) await tx.update(schema.reportRuns).set({ deliveredTo: recipients }).where(inArray(schema.reportRuns.id, input.runIds));
  void enqueue('notifications', 'deliver', {}, { delay: 500, jobId: `deliver-${Date.now()}` });
  return recipients.length;
}

// ---------------------------------------------------------------- rollups maintenance

export async function enqueueBackfill(ctx: Ctx, from: string, to: string) {
  ctx.require('admin:system');
  resolveDateRange('custom', { from, to });
  const job = await enqueue('maintenance', 'metric-backfill', { from, to });
  await ctx.audit({ entityType: 'metric_rollups', action: 'backfill', metadata: { from, to, jobId: job?.id ?? null } });
  return { queued: !!job, jobId: job?.id ?? null, from, to };
}

export async function enqueueRecompute(ctx: Ctx) {
  ctx.require('admin:system');
  const job = await enqueue('maintenance', 'metric-rollups', {}, { jobId: `metric-rollups-manual-${Date.now()}` });
  await ctx.audit({ entityType: 'metric_rollups', action: 'recompute', metadata: { days: 3, jobId: job?.id ?? null } });
  return { queued: !!job, jobId: job?.id ?? null, days: 3 };
}
