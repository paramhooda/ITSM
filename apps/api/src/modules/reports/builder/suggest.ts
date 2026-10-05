import { z } from 'zod';
import type { Ctx } from '@/core/context';
import { ForbiddenError } from '@/core/errors';
import { llmJson, enabled as aiEnabled, asSteps, type Steps } from '@/modules/ai/service';
import { loadAiSettings, featureEnabled } from '@/modules/ai/guards';
import { REPORT_SPEC_SYSTEM } from '@/modules/ai/prompt/features';
import { isCustomerUser } from '../registry';
import { DATE_RANGE_PRESETS, todayIn, type DateRangePreset } from '../dates';
import { ENTITIES, ENTITY_KEYS, OPERATORS, catalogFor, type EntityDef, type EntityKey } from './catalog';
import { validateSpec } from './compile';
import { loadBuilderLimits } from './limits';
import { specSchema, type DefinitionInput, type SuggestBody } from './schemas';

/**
 * "Describe it": one sentence becomes a draft definition. The model is asked only
 * when the caller may use the assistant and the administrator's switch is on, and
 * never inside a transaction (the Steps pattern); whatever it returns is validated
 * against the catalogue, and a deterministic draft built from the catalogue's
 * defaults stands in whenever the model is off, silent or wrong.
 */

export interface SuggestResult {
  definition: Partial<DefinitionInput>;
  /** true when the model produced the draft; false for the deterministic fallback. */
  ai: boolean;
  notes: string[];
}

const suggestionSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  entity: z.enum(ENTITY_KEYS),
  columns: z.array(z.string().max(60)).max(40).optional(),
  filters: z.array(z.object({ field: z.string().max(60), op: z.string().max(20), value: z.unknown().optional() })).max(30).optional(),
  match: z.enum(['all', 'any']).optional(),
  groupBy: z.array(z.string().max(60)).max(2).optional(),
  aggregates: z.array(z.object({ fn: z.enum(['count', 'sum', 'avg', 'min', 'max']), field: z.string().max(60).optional(), label: z.string().max(60).optional() })).max(6).optional(),
  sort: z.object({ key: z.string().max(80), order: z.enum(['asc', 'desc']) }).nullable().optional(),
  dateField: z.string().max(60).nullable().optional(),
  defaultDateRange: z.string().max(40).optional(),
  chart: z.object({ type: z.enum(['bar', 'line']), y: z.array(z.string().max(80)).min(1).max(4) }).nullable().optional(),
});
type Suggestion = z.infer<typeof suggestionSchema>;

// ---------------------------------------------------------------- deterministic fallback

const ENTITY_WORDS: [RegExp, EntityKey][] = [
  [/\b(change|changes|cab\b|window)/i, 'changes'],
  [/\b(problem|known error|kedb|root cause)/i, 'problems'],
  [/\b(sla|breach|clock|service level)/i, 'sla_clocks'],
  [/\b(time entr|time spent|time by|hours|minutes|effort|timesheet)/i, 'time_entries'],
  [/\b(visit|site visit|field)/i, 'visits'],
  [/\b(asset|warranty|amc\b|register)/i, 'assets'],
  [/\b(\bci\b|cis\b|server|switch|configuration item|cmdb|host)/i, 'cis'],
  [/\b(contract|renew)/i, 'contracts'],
  [/\b(entitlement|consum)/i, 'entitlements'],
  [/\b(survey|csat|rating|satisf)/i, 'surveys'],
  [/\b(software|licen[cs]|install)/i, 'software'],
  [/\btime\b/i, 'time_entries'],
];
const PERIOD_WORDS: [RegExp, DateRangePreset][] = [
  [/\blast (7|seven) days\b/i, 'last_7_days'],
  [/\blast (90|ninety) days\b/i, 'last_90_days'],
  [/\blast (30|thirty) days\b/i, 'last_30_days'],
  [/\byesterday\b/i, 'last_day'],
  [/\blast month\b/i, 'last_month'],
  [/\bthis month\b|\bmonth to date\b/i, 'month_to_date'],
  [/\blast quarter\b/i, 'last_quarter'],
  [/\bthis quarter\b|\bquarter to date\b/i, 'quarter_to_date'],
  [/\bthis year\b|\byear to date\b/i, 'year_to_date'],
];
/** Words after "by" that name a group field; the first groupable field whose key or label matches wins. */
const GROUP_ALIASES: Record<string, string[]> = { engineer: ['user', 'assignee', 'engineer'], person: ['user', 'assignee'], people: ['user', 'assignee'], owner: ['assignee', 'owner', 'user'], month: ['created_at'], customer: ['customer'], client: ['customer'], team: ['team', 'owner_team'], type: ['type', 'change_type', 'ticket_type', 'work_type'], status: ['status', 'state'], priority: ['priority'], service: ['service'], site: ['site'], category: ['category'], product: ['product'], publisher: ['publisher'], channel: ['channel'], risk: ['risk_level', 'risk'], metric: ['metric'] };

export const guessEntity = (prompt: string, given?: EntityKey): EntityKey => given ?? ENTITY_WORDS.find(([re]) => re.test(prompt))?.[1] ?? 'tickets';
export const guessPeriod = (prompt: string): DateRangePreset => PERIOD_WORDS.find(([re]) => re.test(prompt))?.[1] ?? 'last_30_days';

function guessGroup(entity: EntityDef, prompt: string): string | null {
  const m = /\bby\s+([a-z_]+)/i.exec(prompt);
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  const candidates = [...(GROUP_ALIASES[word] ?? []), word, `${word}s`.replace(/ss$/, 's')];
  for (const key of candidates) {
    const f = entity.fields[key];
    if (f?.groupable) return key;
  }
  const byLabel = Object.values(entity.fields).find((f) => f.groupable && f.label.toLowerCase() === word);
  return byLabel?.key ?? null;
}

/** A sensible draft from the catalogue alone: the entity by keyword, its default columns, a group field after "by", the period words. */
export function fallbackSpec(prompt: string, entityKey?: EntityKey): Partial<DefinitionInput> {
  const key = guessEntity(prompt, entityKey);
  const entity = ENTITIES[key];
  const group = guessGroup(entity, prompt);
  const name = prompt.trim().replace(/\s+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()).slice(0, 160);
  const base = { name, entity: key, defaultDateRange: guessPeriod(prompt) };
  if (group) {
    return { ...base, spec: { columns: [], filters: [], match: 'all', groupBy: [group], aggregates: [{ fn: 'count', label: 'Count' }], sort: { key: 'count', order: 'desc' }, dateField: entity.defaultDateField, rowLimit: null, chart: { type: 'bar', y: ['count'] } } };
  }
  return { ...base, spec: { columns: [...entity.defaultColumns], filters: [], match: 'all', groupBy: [], aggregates: [], sort: null, dateField: entity.defaultDateField, rowLimit: null, chart: null } };
}

// ---------------------------------------------------------------- the model's draft

function fromSuggestion(s: Suggestion): Partial<DefinitionInput> {
  const preset = s.defaultDateRange && (DATE_RANGE_PRESETS as readonly string[]).includes(s.defaultDateRange) && s.defaultDateRange !== 'custom' ? (s.defaultDateRange as DateRangePreset) : 'last_30_days';
  return {
    name: s.name,
    entity: s.entity,
    defaultDateRange: preset,
    spec: specSchema.parse({ columns: s.columns ?? [], filters: s.filters ?? [], match: s.match ?? 'all', groupBy: s.groupBy ?? [], aggregates: s.aggregates ?? [], sort: s.sort ?? null, dateField: s.dateField ?? null, rowLimit: null, chart: s.chart ?? null }),
  };
}

export async function suggest(who: Ctx | Steps, body: SuggestBody): Promise<SuggestResult> {
  const steps = asSteps(who);
  // step 1: permissions, the switch and the catalogue the model may draw from
  const gathered = await steps.tx(async (ctx) => {
    if (isCustomerUser(ctx)) throw new ForbiddenError('The report builder is not available in the customer portal');
    if (!ctx.can('reports:build') && !ctx.can('reports:manage')) throw new ForbiddenError('Missing permission: reports:build');
    const useModel = ctx.can('ai:use') && aiEnabled() && featureEnabled(await loadAiSettings(ctx.tx), 'report_builder');
    const limits = await loadBuilderLimits(ctx.tx);
    const entities = Object.fromEntries(
      catalogFor(ctx, { portal: false })
        .entities.filter((e) => e.permissionsOk && (!body.entity || e.key === body.entity))
        .map((e) => [e.key, { label: e.label, dateFields: e.dateFields, fields: e.fields.map((f) => ({ key: f.key, type: f.type, ...(f.groupable ? { groupable: true } : {}), ...(f.aggregatable ? { aggregatable: true } : {}), ...(f.options?.values ? { values: f.options.values.map((v) => v.value) } : {}) })) }]),
    );
    return { useModel, limits, entities, today: todayIn(ctx.user.timezone ?? 'UTC'), permitted: Object.keys(entities) as EntityKey[] };
  });

  // step 2: the model, outside any transaction
  const draft = gathered.useModel && gathered.permitted.length ? await llmJson(REPORT_SPEC_SYSTEM, JSON.stringify({ prompt: body.prompt, today: gathered.today, operators: OPERATORS, presets: DATE_RANGE_PRESETS.filter((p) => p !== 'custom'), entities: gathered.entities }), (v) => suggestionSchema.parse(v), { maxTokens: 900 }) : null;

  // step 3: validate what came back; fall back to the catalogue's defaults
  const notes: string[] = [];
  const permittedEntity = (key: EntityKey | undefined) => (key && gathered.permitted.includes(key) ? key : undefined);
  if (draft) {
    try {
      const candidate = fromSuggestion(draft.data);
      const key = permittedEntity(candidate.entity as EntityKey);
      if (!key) throw new ForbiddenError(`entity ${candidate.entity} is not available to you`);
      const spec = validateSpec(ENTITIES[key], candidate.spec, { portal: false, maxRows: gathered.limits.maxRows });
      notes.push('Drafted by the assistant from your description; check the filters before saving.');
      return { definition: { ...candidate, entity: key, spec }, ai: true, notes };
    } catch (err) {
      notes.push(`The assistant's draft was not usable (${(err as Error).message.slice(0, 160)}); a basic layout was used instead.`);
    }
  } else if (!gathered.useModel) notes.push('The assistant is not available for suggestions; a basic layout was built from your description.');
  else notes.push('The assistant gave no usable draft; a basic layout was built from your description.');

  const fallback = fallbackSpec(body.prompt, permittedEntity(body.entity));
  const key = permittedEntity(fallback.entity as EntityKey) ?? gathered.permitted[0] ?? 'tickets';
  const entity = ENTITIES[key];
  const base = fallback.entity === key ? fallback : fallbackSpec(body.prompt, key);
  const spec = validateSpec(entity, base.spec, { portal: false, maxRows: gathered.limits.maxRows });
  return { definition: { ...base, entity: key, spec }, ai: false, notes };
}
