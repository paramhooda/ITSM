import { randomUUID } from 'node:crypto';
import { eq, and, desc, sql, inArray, type SQL } from 'drizzle-orm';
import { runAs, type Ctx, type CtxMeta } from '@/core/context';
import type { Principal } from '@/core/principal';
import { schema, type Tx } from '@/db/client';
import { NotFoundError, ForbiddenError, ValidationError } from '@/core/errors';
import { storage, storageKeyFor, sha256Buffer } from '@/lib/storage';
import { render, emailLayout } from '@/lib/templates';
import { config } from '@/config';
import { enqueue } from '@/jobs/queues';
import { logger } from '@/core/logger';
import { asSteps, isSteps, type Steps } from '@/modules/ai/service';
import { loadAiSettings, featureEnabled, type AiSettings } from '@/modules/ai/guards';
import './definitions';
import { requireReport, visibleReports, describeReport, isCustomerUser, resolveCustomerId, isCustomDefinition, comparesPeriods, MAX_REPORT_ROWS, type ReportDefinition, type ReportParams, type ReportResult } from './registry';
// loading the builder wires the custom definitions into the registry (setCustomLoader / setCustomLister)
import './builder/service';
import { resolveDateRange, todayIn, daysBetween, type DateRange } from './dates';
import { htmlToPdf, pdfAvailable } from '@/lib/pdf';
import { renderCsv, renderHtml, renderXlsx, summaryHtml, brandColor, accentColor, logoUrl, type RenderMeta } from './render';
import { previousRange, attachDeltas, scopeTimezone } from './analytics';
import { deriveInsights, buildNarrative } from './insights';
import { phraseNarrative } from './narrative';

export const PREVIEW_MAX_ROWS = 5000;
export type RunRow = typeof schema.reportRuns.$inferSelect;
/** `json` previews in the UI; the others are stored as attachments of a run. */
export const REPORT_FORMATS = ['json', 'csv', 'html', 'pdf', 'xlsx'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export const FILE_CONTENT_TYPES: Record<Exclude<ReportFormat, 'json'>, string> = { csv: 'text/csv', html: 'text/html', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

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
  const items = (await visibleReports(ctx)).map(describeReport);
  return { items, customerId: isCustomerUser(ctx) ? ctx.user.customerId : null, canManage: !isCustomerUser(ctx) && ctx.can('reports:manage'), formats: [...REPORT_FORMATS], pdf: await pdfAvailable() };
}

// ---------------------------------------------------------------- parameter normalization

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

/** `platform.name`, `platform.logo_url`, `platform.brand_color` and `platform.brand_accent` from system settings (an empty logo means the bundled wordmark). */
export async function brandSettings(tx: Tx) {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, ['platform.name', 'platform.logo_url', 'platform.brand_color', 'platform.brand_accent']));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const name = get('platform.name');
  return { platformName: typeof name === 'string' && name ? name : 'Progression', logoUrl: logoUrl(get('platform.logo_url')), brandColor: brandColor(get('platform.brand_color')), brandAccent: accentColor(get('platform.brand_accent')) };
}
const platformName = async (tx: Tx) => (await brandSettings(tx)).platformName;

export interface ReportSettings {
  /** Footer line on every page; {customer} and {platform} are replaced. */
  confidentiality: string;
  /** Let the assistant rephrase the insights of file runs. */
  narrative: boolean;
  /** Rows printed per table in pack documents (10-500). */
  printRows: number;
}
export const DEFAULT_REPORT_SETTINGS: ReportSettings = { confidentiality: 'Confidential: prepared for {customer} by {platform}. Not for onward distribution.', narrative: true, printRows: 50 };

/** `reports.confidentiality_line`, `reports.narrative` and `reports.print_rows` from system settings. */
export async function loadReportSettings(tx: Tx): Promise<ReportSettings> {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, ['reports.confidentiality_line', 'reports.narrative', 'reports.print_rows']));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const line = get('reports.confidentiality_line');
  const printRows = Number(get('reports.print_rows'));
  return {
    confidentiality: typeof line === 'string' && line.trim() ? line.trim().slice(0, 300) : DEFAULT_REPORT_SETTINGS.confidentiality,
    narrative: get('reports.narrative') !== false,
    printRows: Number.isFinite(printRows) ? Math.min(500, Math.max(10, Math.round(printRows))) : DEFAULT_REPORT_SETTINGS.printRows,
  };
}

interface CustomerRow {
  name: string;
  code: string | null;
  timezone: string | null;
  accountManager: string | null;
}
async function customerRow(tx: Tx, id: string | null): Promise<CustomerRow | null> {
  if (!id) return null;
  const [row] = await tx.select({ name: schema.customers.name, code: schema.customers.code, timezone: schema.customers.timezone, accountManager: schema.users.name }).from(schema.customers).leftJoin(schema.users, eq(schema.users.id, schema.customers.accountManagerId)).where(eq(schema.customers.id, id)).limit(1);
  return row ? { name: row.name, code: row.code ?? null, timezone: row.timezone ?? null, accountManager: row.accountManager ?? null } : null;
}

/** Steps whose transactions carry the caller's own source (ui, integration or system), unlike stepsFor (source 'ai'): the report runs in one, the model is called in between, the file is stored in another. */
export const reportSteps = (p: Principal, meta: Partial<CtxMeta>): Steps => ({ principal: p, tx: (fn) => runAs(p, meta, fn) });

/** Longest period compared against its predecessor (two runs per request). */
const COMPARE_MAX_DAYS = 400;

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

interface Prepared {
  def: ReportDefinition;
  params: ReportParams;
  range: DateRange;
  result: ReportResult;
  started: Date;
  comparison: DateRange | null;
  customer: CustomerRow | null;
  brand: Awaited<ReturnType<typeof brandSettings>>;
  settings: ReportSettings;
  ai: AiSettings;
  portal: boolean;
  socExcluded: boolean;
  /** The timezone of hour-of-day figures, resolved by the same rule the definitions use; null when the result has no heatmap. */
  timezone: string | null;
}

/**
 * Runs a report in three steps: (1) the definition, its previous-period
 * comparison and the deterministic insights inside one transaction, (2) the
 * narrative (the model rephrases the insights, outside any transaction and
 * only when the caller supplied real Steps), (3) the run row and the file in
 * a second transaction. A plain Ctx caller (tools, tests) runs every step in
 * its own transaction and always gets the rules' narrative.
 */
export async function executeReport(who: Ctx | Steps, input: RunInput): Promise<ExecutionOutcome> {
  const s = asSteps(who);
  const format = input.format ?? 'json';
  if (!(REPORT_FORMATS as readonly string[]).includes(format)) throw new ValidationError(`format must be one of ${REPORT_FORMATS.join(', ')}`);
  if (format === 'pdf' && !(await pdfAvailable())) throw new ValidationError('PDF output is not available on this server: Chromium is not installed (see docs/OPERATIONS.md, Reports)');

  // ---- step 1: the figures
  const prepared = await s.tx(async (ctx): Promise<Prepared> => {
    const raw = input.parameters ?? {};
    const customerId = resolveCustomerId(ctx, raw);
    const def = await requireReport(ctx, input.reportKey, customerId);
    // a custom report fixed to one customer always runs for that customer (the run row and the file carry its name)
    const scoped = isCustomDefinition(def) && def.custom.scopeCustomerId ? def.custom.scopeCustomerId : null;
    const { params, range } = normalizeParams(ctx, def, scoped ? { ...raw, customerId: scoped } : raw, input.timezone);
    const started = new Date();
    const result = await def.run(ctx, params);
    if (result.rows.length > MAX_REPORT_ROWS) {
      result.rows = result.rows.slice(0, MAX_REPORT_ROWS);
      result.truncated = true;
    }
    let comparison: DateRange | null = null;
    if (comparesPeriods(def) && daysBetween(range.from, range.to) + 1 <= COMPARE_MAX_DAYS) {
      const prev = previousRange(range);
      // under a savepoint: a comparison that fails in SQL must not abort the transaction the main result still needs
      await ctx.tx.execute(sql`SAVEPOINT report_compare`);
      try {
        const before = await def.run(ctx, { ...params, from: prev.from, to: prev.to });
        await ctx.tx.execute(sql`RELEASE SAVEPOINT report_compare`);
        attachDeltas(result, before);
        result.comparison = { from: prev.from, to: prev.to, label: prev.label };
        comparison = prev;
      } catch (err) {
        await ctx.tx.execute(sql`ROLLBACK TO SAVEPOINT report_compare`);
        logger.warn({ err, reportKey: def.key }, 'report comparison failed');
        (result.notes ??= []).push('Comparison with the previous period unavailable');
      }
    }
    // a definition that compares internally (the review pack) supplies its own comparison label
    result.insights ??= deriveInsights(result, { reportName: def.name, comparison: comparison?.label ?? result.comparison?.label ?? null });
    result.glossary = [...(def.glossary ?? []), ...(result.glossary ?? [])];
    const customer = await customerRow(ctx.tx, params.customerId);
    const [brand, settings, ai] = await Promise.all([brandSettings(ctx.tx), loadReportSettings(ctx.tx), loadAiSettings(ctx.tx)]);
    // the data note names the timezone the heatmap was computed in (the definitions resolve it through scopeTimezone)
    const hasHeatmap = [...(result.charts ?? []), ...(result.sections ?? []).flatMap((x) => x.charts ?? [])].some((c) => c.type === 'heatmap');
    const timezone = hasHeatmap ? await scopeTimezone(ctx, params.customerId) : null;
    return { def, params, range, result, started, comparison, customer, brand, settings, ai, portal: isCustomerUser(ctx), socExcluded: !isCustomerUser(ctx) && !ctx.can('soc:read'), timezone };
  });
  const { def, params, range, result, started, comparison, customer, brand, settings, ai } = prepared;
  const comparisonLabel = comparison?.label ?? result.comparison?.label ?? null;

  // ---- step 2: the narrative (the model only when the caller gave real Steps, so it never runs inside a transaction)
  result.narrative = buildNarrative(result);
  if (isSteps(who) && format !== 'json' && format !== 'csv' && settings.narrative && featureEnabled(ai, 'recommendations')) {
    result.narrative = await phraseNarrative({ reportName: def.name, customer: customer?.name ?? null, period: range.label, comparison: comparisonLabel, tiles: result.summary ?? [], insights: result.insights ?? [], recommendations: result.recommendations ?? [], fallback: result.narrative });
  }
  if (format === 'json') return { def, params, range, result, run: null, attachment: null };

  // ---- step 3: the run row and the file
  return s.tx(async (ctx) => {
    const cname = customer?.name ?? null;
    const name = cname ? `${def.name} - ${cname}` : def.name;
    const portalVisible = input.portalVisible ?? isCustomerUser(ctx);
    const [run] = await ctx.tx
      .insert(schema.reportRuns)
      .values({ scheduleId: input.scheduleId ?? null, reportKey: def.key, customerId: params.customerId, name, parameters: { ...params, dateRange: range.preset, period: range.label }, format, status: 'running', portalVisible, requestedBy: input.requestedBy === undefined ? (ctx.user.apiKeyId || ctx.user.isSystem ? null : ctx.user.id) : input.requestedBy, startedAt: started })
      .returning();
    try {
      // parameters shown on the file: the ones that differ from the definition's defaults
      const shown = Object.fromEntries(Object.entries(params).filter(([k, v]) => def.parameters.find((x) => x.key === k)?.default !== v));
      // function replacers: a `$` in a customer or platform name is never read as a replacement pattern
      const confidentiality = cname ? settings.confidentiality.replace(/\{customer\}/g, () => cname).replace(/\{platform\}/g, () => brand.platformName) : undefined;
      const meta: RenderMeta = {
        reportName: def.name,
        description: def.description,
        platformName: brand.platformName,
        logoUrl: brand.logoUrl,
        brandColor: brand.brandColor,
        brandAccent: brand.brandAccent,
        customerName: cname,
        customerCode: customer?.code ?? null,
        accountManager: customer?.accountManager ?? null,
        period: range.label,
        generatedAt: new Date(),
        generatedBy: ctx.user.isSystem ? 'scheduled report' : ctx.user.name,
        parameters: shown,
        cover: def.cover === true || format === 'pdf',
        confidentiality,
        comparisonLabel,
        timezone: prepared.timezone ?? undefined,
        kind: def.kind ?? 'report',
        printRows: settings.printRows,
        portal: prepared.portal,
        socExcluded: prepared.socExcluded,
        reportKey: def.key,
        runId: run.id,
      };
      const buffer = format === 'csv' ? renderCsv(result) : format === 'xlsx' ? await renderXlsx(result, meta) : format === 'pdf' ? await htmlToPdf(renderHtml(result, meta)) : Buffer.from(renderHtml(result, meta), 'utf8');
      const filename = `${slug(def.name)}${cname ? `_${slug(cname)}` : ''}_${range.from}_${range.to}.${format}`;
      const attachment = await storeReportFile(ctx, run, buffer, filename, FILE_CONTENT_TYPES[format]);
      const [done] = await ctx.tx.update(schema.reportRuns).set({ status: 'completed', attachmentId: attachment.id, rowCount: result.rows.length, finishedAt: new Date() }).where(eq(schema.reportRuns.id, run.id)).returning();
      await ctx.audit({ entityType: 'report_run', entityId: run.id, entityLabel: name, action: 'create', customerId: params.customerId, metadata: { reportKey: def.key, format, rowCount: result.rows.length, scheduleId: input.scheduleId ?? null, portalVisible, period: range.label, narrative: result.narrative?.source ?? null } });
      return { def, params, range, result, run: done, attachment };
    } catch (err) {
      await ctx.tx.update(schema.reportRuns).set({ status: 'failed', error: String((err as Error).message ?? err).slice(0, 2000), finishedAt: new Date() }).where(eq(schema.reportRuns.id, run.id));
      throw err;
    }
  });
}

/** Route-facing runner: json preview (capped) or stored file run. Takes a Ctx (tools, tests) or Steps (the route, the worker). */
export async function runReport(who: Ctx | Steps, input: RunInput) {
  const out = await executeReport(who, input);
  if (!out.run) {
    const total = out.result.rowCount ?? out.result.rows.length;
    return {
      report: describeReport(out.def),
      parameters: out.params,
      period: out.range,
      result: { ...out.result, rows: out.result.rows.slice(0, PREVIEW_MAX_ROWS), truncated: out.result.truncated || total > PREVIEW_MAX_ROWS, rowCount: total },
    };
  }
  const runId = out.run.id;
  return asSteps(who).tx((ctx) => getRun(ctx, runId));
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

async function runVisibility(ctx: Ctx): Promise<SQL[]> {
  const r = schema.reportRuns;
  if (isCustomerUser(ctx)) {
    if (!ctx.can('portal:reports', ctx.user.customerId)) throw new ForbiddenError('Missing permission: portal:reports');
    return [eq(r.customerId, ctx.user.customerId ?? '00000000-0000-0000-0000-000000000000'), eq(r.portalVisible, true), eq(r.status, 'completed')];
  }
  ctx.require('reports:run');
  // retired custom reports stay listed so History keeps their past runs
  const keys = (await visibleReports(ctx, { includeInactive: true })).map((d) => d.key);
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
  const conds = await runVisibility(ctx);
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
  const [row] = await runsBase(ctx).where(and(eq(schema.reportRuns.id, id), ...(await runVisibility(ctx)))).limit(1);
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
