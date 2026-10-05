import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { schema } from '@/db/client';
import { ForbiddenError, ValidationError } from '@/core/errors';
import { listDefinitions, runReport } from '@/modules/reports/service';
import { listSchedules, createSchedule, FREQUENCIES, FORMATS } from '@/modules/reports/schedules';
import { DATE_RANGE_PRESETS } from '@/modules/reports/dates';
import { ENTITIES, ENTITY_KEYS, OPERATORS, catalogFor } from '@/modules/reports/builder/catalog';
import { aggregateAlias, validateSpec } from '@/modules/reports/builder/compile';
import { createDefinition, preview as previewSpec } from '@/modules/reports/builder/service';
import { definitionInput, filterSchema, aggregateSchema, type DefinitionInput } from '@/modules/reports/builder/schemas';
import { loadBuilderLimits } from '@/modules/reports/builder/limits';
import * as dashboards from '@/modules/dashboards/service';
import { define, type PreviewDetail } from './types';
import { isCustomerUser, iso, dayStr, resolveCustomerId, resolveTeam, customerName } from '../helpers';

/** Reports and analysis tools: the report catalogue, running and exporting reports, dashboards, trends and scheduled deliveries. */

const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Keeps a dashboard payload small: scalars, one level of nested scalars, arrays cut to a few rows of scalars; series are dropped. */
function compactDashboard(obj: Record<string, unknown>, maxRows = 8): { data: Record<string, unknown>; facts: string[] } {
  const data: Record<string, unknown> = {};
  const facts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'series' || k === 'generatedAt') continue;
    if (isScalar(v)) {
      data[k] = v;
      if (typeof v === 'number') facts.push(`${k}: ${v}`);
    } else if (Array.isArray(v)) {
      data[k] = v.slice(0, maxRows).map((row) => (row && typeof row === 'object' ? Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([, x]) => isScalar(x))) : row));
    } else if (v && typeof v === 'object') {
      const inner: Record<string, unknown> = {};
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (k2 === 'series') continue;
        if (isScalar(v2)) {
          inner[k2] = v2;
          if (typeof v2 === 'number') facts.push(`${k}.${k2}: ${v2}`);
        } else if (Array.isArray(v2)) inner[k2] = v2.slice(0, maxRows).map((row) => (row && typeof row === 'object' ? Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([, x]) => isScalar(x))) : row));
        else if (v2 && typeof v2 === 'object') inner[k2] = Object.fromEntries(Object.entries(v2 as Record<string, unknown>).filter(([, x]) => isScalar(x)));
      }
      data[k] = inner;
    }
  }
  return { data, facts: facts.slice(0, 16) };
}

async function reportByRef(ctx: Ctx, ref: string) {
  const defs = (await listDefinitions(ctx)).items;
  const r = ref.trim().toLowerCase();
  const hit = defs.find((d) => d.key === r) ?? defs.find((d) => d.name.toLowerCase() === r) ?? defs.find((d) => d.name.toLowerCase().includes(r));
  if (!hit) throw new ValidationError(`No report matching "${ref}". Available: ${defs.map((d) => d.key).join(', ')}`);
  return hit;
}

async function reportParams(ctx: Ctx, input: { customer?: string; dateRange?: string; from?: string; to?: string; parameters?: Record<string, unknown> }) {
  const customerId = await resolveCustomerId(ctx, input.customer);
  return { ...(input.parameters ?? {}), customerId, dateRange: input.dateRange, from: input.from, to: input.to };
}

type BuildInput = { name: string; description?: string; entity: (typeof ENTITY_KEYS)[number]; columns?: string[]; filters?: { field: string; op: string; value?: unknown }[]; match?: 'all' | 'any'; groupBy?: string[]; aggregates?: { fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string; label?: string }[]; sort?: { key: string; order: 'asc' | 'desc' }; dateField?: string | null; dateRange?: (typeof DATE_RANGE_PRESETS)[number]; chart?: 'bar' | 'line'; customer?: string; share?: 'private' | 'shared'; shareWithRoles?: string[]; shareWithTeams?: string[] };

/** The tool's input as a validated definition, with the names the preview shows and a small sample run. */
async function buildDraft(ctx: Ctx, input: BuildInput) {
  const entity = ENTITIES[input.entity];
  const customerId = input.customer ? await resolveCustomerId(ctx, input.customer) : undefined;
  const teams: { id: string; name: string }[] = [];
  for (const ref of input.shareWithTeams ?? []) {
    const t = await resolveTeam(ctx, ref);
    if (t) teams.push(t);
  }
  const roles = [...new Set(input.shareWithRoles ?? [])];
  // the proposal names only roles that exist, so a confirmed proposal cannot fail on a misspelt role
  if (roles.length) {
    const found = await ctx.tx.select({ key: schema.roles.key }).from(schema.roles).where(and(inArray(schema.roles.key, roles), eq(schema.roles.userType, 'msp')));
    const missing = roles.filter((k) => !found.some((r) => r.key === k));
    if (missing.length) throw new ValidationError(`Unknown staff role(s): ${missing.join(', ')}; use the role keys, such as management or service_manager`);
  }
  const visibility = input.share ?? (roles.length || teams.length ? 'shared' : 'private');
  const groupBy = input.groupBy ?? [];
  const aggregates = groupBy.length && !input.aggregates?.length ? [{ fn: 'count' as const, label: 'Count' }] : input.aggregates ?? [];
  const columns = !groupBy.length && !input.columns?.length ? [...entity.defaultColumns] : input.columns ?? [];
  const spec = { columns, filters: input.filters ?? [], match: input.match ?? 'all', groupBy, aggregates, sort: input.sort ?? null, dateField: input.dateField === undefined ? entity.defaultDateField : input.dateField || null, rowLimit: null, chart: input.chart && groupBy.length ? { type: input.chart, y: aggregates.map(aggregateAlias).slice(0, 4) } : null };
  const limits = await loadBuilderLimits(ctx.tx);
  const validated = validateSpec(entity, spec, { portal: false, maxRows: limits.maxRows });
  const def: DefinitionInput = definitionInput.parse({ name: input.name, description: input.description ?? null, category: 'custom', entity: input.entity, spec: validated, defaultDateRange: input.dateRange ?? 'last_30_days', scopeCustomerId: customerId ?? null, visibility, sharedRoleKeys: visibility === 'shared' ? roles : [], sharedTeamIds: visibility === 'shared' ? teams.map((t) => t.id) : [], portalVisible: false, cover: false, isActive: true });
  const customerLabel = customerId ? await customerName(ctx, customerId) : null;
  const shareLabel = visibility === 'private' ? 'private' : `shared with ${[...roles, ...teams.map((t) => t.name)].join(', ') || 'report managers only'}`;
  const res = await previewSpec(ctx, { entity: input.entity, spec: def.spec, parameters: { customerId: customerId ?? undefined, dateRange: def.defaultDateRange }, portal: false }, { limit: 20 });
  const keys = res.columns.map((c) => c.key);
  const sample = res.rows.slice(0, 5).map((r) => keys.map((k) => `${k}=${r[k] === null || r[k] === undefined ? '' : String(r[k] instanceof Date ? (r[k] as Date).toISOString().slice(0, 16) : r[k])}`).join(', ').slice(0, 120));
  return { def, entity, customerLabel, shareLabel, summaryLines: res.summaryLines, rows: { rowCount: res.rowCount, sample } };
}

export const REPORTS: ReturnType<typeof define>[] = [
  define({
    name: 'list_reports',
    toolset: 'reports',
    description: 'The reports the user may run, with their parameters. Custom reports built in the report builder are included and marked custom.',
    inputSchema: z.object({ category: z.string().max(40).optional() }),
    requires: ['reports:run'],
    portal: ['portal:reports'],
    action: false,
    run: async (ctx, input) => {
      const res = await listDefinitions(ctx);
      const items = res.items.filter((d) => !input.category || d.category === input.category);
      return { items: items.map((d) => ({ key: d.key, name: d.name, description: d.description, category: d.category, defaultDateRange: d.defaultDateRange, custom: !!d.custom, ...(d.custom?.canEdit ? { builderLink: `/reports/builder/${d.custom.id}` } : {}), parameters: d.parameters.map((p) => ({ key: p.key, label: p.label, type: p.type, required: !!p.required, options: p.options?.slice(0, 12).map((o) => o.value) })) })), link: '/reports' };
    },
    summary: (_i, result) => `Listed ${(result as { items: unknown[] }).items.length} reports`,
  }),

  define({
    name: 'run_report',
    toolset: 'reports',
    description: 'Run a report and read its summary figures, charts and first rows. Date range presets: last_7_days, last_30_days, last_90_days, month_to_date, last_month, quarter_to_date, last_quarter, year_to_date, or custom with from/to. Works for custom reports too (name or custom:<id> key).',
    inputSchema: z.object({ report: z.string().max(100).describe('Report key or name'), customer: z.string().max(200).optional(), dateRange: z.enum(DATE_RANGE_PRESETS).optional(), from: z.string().max(10).optional(), to: z.string().max(10).optional(), parameters: z.record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()])).optional(), rows: z.number().int().min(0).max(50).optional().describe('How many rows to read (default 20)') }),
    requires: ['reports:run'],
    portal: ['portal:reports'],
    action: false,
    run: async (ctx, input) => {
      const def = await reportByRef(ctx, input.report);
      const res = (await runReport(ctx, { reportKey: def.key, parameters: await reportParams(ctx, input), format: 'json' })) as unknown as { report: { key: string; name: string }; period: { from: string; to: string; label?: string }; result: { columns: { key: string; label: string }[]; rows: Record<string, unknown>[]; summary?: { label: string; value: unknown; hint?: string }[]; charts?: { title: string; x: string; y: string | string[]; data: Record<string, unknown>[] }[]; sections?: { title: string; rows: Record<string, unknown>[] }[]; rowCount: number; truncated: boolean } };
      const max = input.rows ?? 20;
      const cols = res.result.columns.map((c) => c.key);
      return {
        report: res.report.name,
        key: res.report.key,
        period: res.period,
        facts: (res.result.summary ?? []).map((s) => `${s.label}: ${s.value ?? '—'}${s.hint ? ` (${s.hint})` : ''}`).concat([`${res.result.rowCount} row(s) in the report for ${res.period.label ?? `${res.period.from} to ${res.period.to}`}`]),
        summary: res.result.summary ?? [],
        charts: (res.result.charts ?? []).slice(0, 3).map((c) => ({ title: c.title, x: c.x, y: c.y, points: c.data.slice(0, 12) })),
        columns: res.result.columns.map((c) => c.label),
        rows: res.result.rows.slice(0, max).map((r) => Object.fromEntries(cols.map((k) => [k, r[k]]))),
        rowCount: res.result.rowCount,
        truncated: res.result.truncated || res.result.rowCount > max,
        sections: (res.result.sections ?? []).slice(0, 2).map((s) => ({ title: s.title, rows: s.rows.slice(0, 8) })),
        link: '/reports',
      };
    },
    summary: (input, result) => `Ran report ${(result as { report: string }).report ?? input.report} (${(result as { rowCount: number }).rowCount} rows)`,
  }),

  define({
    name: 'dashboard_kpis',
    toolset: 'reports',
    description: 'The headline figures of a dashboard (management, NOC, SOC, AMC, my work; the customer overview in the portal) for a period and optional customer scope.',
    inputSchema: z.object({ view: z.enum(['management', 'noc', 'soc', 'amc', 'engineer']).optional(), days: z.number().int().min(1).max(365).optional(), customer: z.string().max(200).optional() }),
    requires: [],
    portal: ['portal:access'],
    action: false,
    run: async (ctx, input) => {
      const days = input.days ?? 30;
      if (isCustomerUser(ctx)) {
        const d = (await dashboards.customer(ctx, { days })) as unknown as Record<string, unknown>;
        const c = compactDashboard(d);
        return { view: 'customer', days, ...c.data, facts: c.facts, link: '/portal' };
      }
      const customerId = await resolveCustomerId(ctx, input.customer);
      const view = input.view ?? (ctx.can('dashboards:management') ? 'management' : ctx.can('dashboards:noc') ? 'noc' : ctx.can('dashboards:soc') ? 'soc' : ctx.can('dashboards:amc') ? 'amc' : 'engineer');
      if (view !== 'engineer' && !ctx.can(`dashboards:${view}` as never)) throw new ForbiddenError(`Missing permission: dashboards:${view}`);
      const fn = dashboards[view];
      const d = (await fn(ctx, { days, customerId })) as unknown as Record<string, unknown>;
      const c = compactDashboard(d);
      return { view, days, customer: customerId ? await customerName(ctx, customerId) : null, ...c.data, facts: c.facts, link: `/?view=${view}&days=${days}${customerId ? `&customerId=${customerId}` : ''}` };
    },
    summary: (_i, result) => `Read the ${(result as { view: string }).view} dashboard (${(result as { days: number }).days} days)`,
  }),

  define({
    name: 'trends',
    toolset: 'reports',
    description: 'Daily trend series for a period (tickets opened and resolved, breaches, MTTR, compliance…), optionally for one customer.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), from: z.string().max(10).optional(), to: z.string().max(10).optional(), metric: z.string().max(40).optional() }),
    requires: ['dashboards:management'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const from = input.from ?? dayStr(new Date(Date.now() - 30 * 86_400_000));
      const to = input.to ?? dayStr(new Date());
      const res = (await dashboards.trends(ctx, { customerId, from, to, metric: input.metric })) as unknown as { series: Record<string, unknown>[]; totals: Record<string, unknown> };
      const totals = Object.fromEntries(Object.entries(res.totals ?? {}).filter(([, v]) => isScalar(v)));
      return { from, to, totals, facts: Object.entries(totals).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} (${from} to ${to}): ${v}`).slice(0, 12), series: res.series.slice(-30) };
    },
    summary: (_i, result) => `Read trends ${(result as { from: string }).from} to ${(result as { to: string }).to}`,
  }),

  define({
    name: 'report_schedules',
    toolset: 'reports',
    description: 'Scheduled report deliveries: report, frequency, recipients, next run, last run.',
    inputSchema: z.object({ customer: z.string().max(200).optional(), activeOnly: z.boolean().optional() }),
    requires: ['reports:manage'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const customerId = await resolveCustomerId(ctx, input.customer);
      const res = await listSchedules(ctx, { customerId, isActive: input.activeOnly ? true : undefined });
      const items = res.items as unknown as Record<string, unknown>[];
      return { total: res.total, items: items.slice(0, 30).map((s) => ({ id: s.id, name: s.name, report: s.reportName ?? s.reportKey, customer: s.customerName ?? null, frequency: s.frequency, timezone: s.timezone, dateRange: s.dateRange, format: s.format, delivery: s.delivery, recipients: Array.isArray(s.recipients) ? (s.recipients as string[]).length : 0, isActive: s.isActive, nextRunAt: iso(s.nextRunAt as Date | null), lastRunAt: iso(s.lastRunAt as Date | null) })), link: '/reports' };
    },
    summary: (_i, result) => `Listed ${(result as { total: number }).total} report schedules`,
  }),

  define({
    name: 'export_report',
    toolset: 'reports',
    description: 'Run a report and store it as a CSV file the user can download from the Reports page.',
    inputSchema: z.object({ report: z.string().max(100), customer: z.string().max(200).optional(), dateRange: z.enum(DATE_RANGE_PRESETS).optional(), from: z.string().max(10).optional(), to: z.string().max(10).optional(), parameters: z.record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()])).optional() }),
    requires: ['reports:run'],
    portal: ['portal:reports'],
    action: true,
    tier: 'write_low',
    run: async (ctx, input) => {
      const def = await reportByRef(ctx, input.report);
      const run = (await runReport(ctx, { reportKey: def.key, parameters: await reportParams(ctx, input), format: 'csv' })) as unknown as { id: string; name: string; status: string; rowCount: number | null; attachmentId: string | null };
      return { runId: run.id, name: run.name, status: run.status, rows: run.rowCount, download: run.attachmentId ? `/api/attachments/${run.attachmentId}/download` : null, link: '/reports' };
    },
    summary: (_i, result) => `Exported "${(result as { name: string }).name}" as CSV (${(result as { rows: number }).rows ?? 0} rows)`,
    preview: async (ctx, input) => `Run "${(await reportByRef(ctx, input.report)).name}"${input.customer ? ` for ${input.customer}` : ''} (${input.dateRange ?? 'default period'}) and store it as a CSV file on the Reports page`,
  }),

  define({
    name: 'schedule_report',
    toolset: 'reports',
    description: 'Schedule a report to be emailed to recipients on a cadence (daily, weekly, monthly, quarterly).',
    inputSchema: z.object({ name: z.string().min(3).max(200), report: z.string().max(100), customer: z.string().max(200).optional(), recipients: z.array(z.string().email().max(320)).min(1).max(20), frequency: z.enum(FREQUENCIES.filter((f) => f !== 'cron') as unknown as ['daily', 'weekly', 'monthly', 'quarterly']), dateRange: z.enum(DATE_RANGE_PRESETS).optional(), format: z.enum(FORMATS).optional() }),
    requires: ['reports:manage'],
    portal: null,
    action: true,
    tier: 'outbound',
    run: async (ctx, input) => {
      const def = await reportByRef(ctx, input.report);
      const customerId = await resolveCustomerId(ctx, input.customer);
      const s = await createSchedule(ctx, { name: input.name, reportKey: def.key, customerId: customerId ?? null, recipients: input.recipients, recipientUserIds: [], frequency: input.frequency, cronExpression: null, timezone: ctx.user.timezone || 'UTC', dateRange: input.dateRange ?? 'last_7_days', filters: {}, format: input.format ?? 'html', delivery: 'email', isActive: true });
      return { scheduleId: s.id, name: s.name, nextRunAt: iso(s.nextRunAt), link: '/reports' };
    },
    summary: (input, result) => `Scheduled "${input.name}" ${input.frequency} (next ${(result as { nextRunAt: string | null }).nextRunAt ?? 'n/a'})`,
    preview: async (ctx, input) => {
      const def = await reportByRef(ctx, input.report);
      const customerId = await resolveCustomerId(ctx, input.customer);
      return `Schedule "${input.name}": email the ${def.name} report${customerId ? ` for ${await customerName(ctx, customerId)}` : ''} ${input.frequency} as ${input.format ?? 'html'} (${input.dateRange ?? 'last_7_days'}) to ${input.recipients.join(', ')}`;
    },
  }),

  define({
    name: 'report_catalog',
    toolset: 'reports',
    description: "The entities and fields a custom report can use (tickets, changes, problems, SLA clocks, time entries, field visits, assets, configuration items, contracts, entitlements, surveys, software): field keys, types, which are groupable or aggregatable, the filter operators per type and the date fields. Read it before proposing a report with build_report; answers 'what can I report on' and 'which fields exist for visits'.",
    inputSchema: z.object({ entity: z.enum(ENTITY_KEYS).optional().describe('One entity for its full field list; omit for every entity with field counts') }),
    requires: ['reports:build'],
    portal: null,
    action: false,
    run: async (ctx, input) => {
      const all = catalogFor(ctx, { portal: false }).entities;
      const entities = all.filter((e) => !input.entity || e.key === input.entity);
      const permitted = entities.filter((e) => e.permissionsOk);
      const fieldCount = permitted.reduce((s, e) => s + e.fields.length, 0);
      return {
        entities: entities.map((e) => ({
          key: e.key,
          label: e.label,
          description: e.description,
          permissionsOk: e.permissionsOk,
          needs: e.permissionsOk ? undefined : e.permissions,
          dateFields: e.dateFields,
          // one entity: its defaults and every field, compact (label only when it is not the key itself, no checklist group, flags only when set, value lists cut); the full listing carries field counts only, so either result stays under the tool-result cap
          ...(input.entity
            ? { defaultDateField: e.defaultDateField, defaultColumns: e.defaultColumns, fields: e.fields.map((f) => ({ key: f.key, ...(f.label.toLowerCase() === f.key.replace(/_/g, ' ') ? {} : { label: f.label }), type: f.type, ...(f.groupable ? { groupable: true } : {}), ...(f.aggregatable ? { aggregatable: true } : {}), ...(f.options?.values ? { values: f.options.values.slice(0, 8).map((v) => v.value) } : {}) })) }
            : { fieldCount: e.fields.length }),
        })),
        operators: OPERATORS,
        // the period presets are listed in build_report's own input; they only ride along with the full listing
        ...(input.entity ? {} : { presets: DATE_RANGE_PRESETS.filter((p) => p !== 'custom') }),
        facts: [`${permitted.length} entit${permitted.length === 1 ? 'y' : 'ies'} and ${fieldCount} field(s) available to you${input.entity ? ` for ${entities[0]?.label ?? input.entity}` : ''}`],
        link: '/reports/builder',
      };
    },
    summary: (_i, result) => `Listed the report catalogue (${(result as { entities: unknown[] }).entities.length} entities)`,
  }),

  define({
    name: 'build_report',
    toolset: 'reports',
    description: "Build and save a custom report from a specification: entity, columns, filters, optional grouping with aggregates, sort, period field and sharing. Use report_catalog first for the exact field keys. The preview shows the compiled definition and a sample of rows before anything is saved; answers 'build me a report of …' and 'save this as a report'.",
    inputSchema: z.object({
      name: z.string().min(3).max(160),
      description: z.string().max(1000).optional(),
      entity: z.enum(ENTITY_KEYS),
      columns: z.array(z.string().max(60)).max(40).optional().describe('Detail report columns (field keys); defaults to the entity\'s default columns'),
      filters: z.array(filterSchema).max(30).optional(),
      match: z.enum(['all', 'any']).optional(),
      groupBy: z.array(z.string().max(60)).max(2).optional().describe('Group fields for a breakdown (one or two groupable field keys)'),
      aggregates: z.array(aggregateSchema).max(6).optional().describe('With groupBy: count, or sum/avg/min/max of an aggregatable field'),
      sort: z.object({ key: z.string().max(80), order: z.enum(['asc', 'desc']) }).optional().describe('A column, a group field or an aggregate alias (count, sum_<field>, avg_<field>)'),
      dateField: z.string().max(60).nullable().optional().describe('The period field (one of the entity\'s date fields); omit for the entity\'s default, null or an empty string for no period (every row, whatever the date)'),
      dateRange: z.enum(DATE_RANGE_PRESETS).optional(),
      chart: z.enum(['bar', 'line']).optional().describe('With groupBy: chart the aggregates by the first group field'),
      customer: z.string().max(200).optional().describe('Fix the report to one customer (name or code); omit to choose at run time'),
      share: z.enum(['private', 'shared']).optional(),
      shareWithRoles: z.array(z.string().max(60)).max(10).optional().describe('Staff role keys, such as management or service_manager'),
      shareWithTeams: z.array(z.string().max(100)).max(10).optional().describe('Team names or keys'),
    }),
    requires: ['reports:build'],
    portal: null,
    action: true,
    tier: 'write',
    invalidates: ['reports'],
    preview: async (ctx, input) => {
      const { def, entity, customerLabel, shareLabel, summaryLines, rows } = await buildDraft(ctx, input);
      const grouped = def.spec.groupBy.length > 0;
      const shape = grouped ? `grouped by ${def.spec.groupBy.join(' and ')} with ${def.spec.aggregates.map(aggregateAlias).join(', ')}` : `${def.spec.columns.length} column(s)`;
      const period = def.spec.dateField ? `period ${def.defaultDateRange} over ${def.spec.dateField}` : 'no period';
      return {
        text: `Save custom report "${def.name}" on ${entity.label.toLowerCase()}: ${shape}, ${def.spec.filters.length} filter(s), ${period}, ${shareLabel}${customerLabel ? `, fixed to ${customerLabel}` : ''}. Sample: ${rows.rowCount} row(s).`,
        lines: [...summaryLines, ...rows.sample],
        count: rows.rowCount,
      } satisfies PreviewDetail;
    },
    run: async (ctx, input) => {
      const { def, entity, rows } = await buildDraft(ctx, input);
      const saved = await createDefinition(ctx, def);
      return {
        id: saved.id,
        key: saved.key,
        name: saved.name,
        entity: entity.key,
        rowCount: rows.rowCount,
        facts: [`Saved custom report "${saved.name}" (${entity.label.toLowerCase()}, ${def.spec.groupBy.length ? `${def.spec.groupBy.length} group field(s) and ${def.spec.aggregates.length} aggregate(s)` : `${def.spec.columns.length} column(s)`}, ${def.spec.filters.length} filter(s)); ${rows.rowCount} row(s) in the sample run`],
        link: `/reports/builder/${saved.id}`,
        runLink: `/reports?tab=run&report=${saved.key}`,
      };
    },
    summary: (input, result) => `Saved custom report "${(result as { name?: string }).name ?? input.name}" (${input.entity})`,
  }),
];
