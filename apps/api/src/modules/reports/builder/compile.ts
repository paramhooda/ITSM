import { sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '@/core/context';
import { ValidationError } from '@/core/errors';
import type { ReportSpec, ReportFilter, ReportAggregate } from '@/db/schema/report-definitions';
import type { ReportColumn } from '../registry';
import { customerCond, rangeCond, EMPTY } from '../definitions/helpers';
import { OPERATORS, OPERATOR_LABELS, type EntityDef, type FieldDef, type FieldType, type LookupKind } from './catalog';
import { specSchema } from './schemas';

/**
 * Validation and compilation of a report specification. Every key in a spec is
 * checked against the entity's catalogue before any SQL is built; the SQL is one
 * drizzle template whose only dynamic parts are catalogue expressions and bound
 * parameters. A spec can therefore never inject SQL: an unknown field, operator
 * or alias is refused with a message naming it.
 */

export interface CompiledQuery {
  sql: SQL;
  /** The same statement without ORDER BY and LIMIT, wrapped in a count. */
  countSql: SQL;
  columns: ReportColumn[];
  grouped: boolean;
}

const AGG_FNS = ['count', 'sum', 'avg', 'min', 'max'] as const;
const DAY_RE = /^\d{4}-\d{2}-\d{2}/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_TYPES: FieldType[] = ['number', 'minutes', 'pct'];
const DATE_TYPES: FieldType[] = ['date', 'datetime'];
const LIST_TYPES: FieldType[] = ['option', 'enum', 'ref'];

/** The deterministic result alias of an aggregate: `count`, otherwise `${fn}_${field}`; never derived from the label. */
export const aggregateAlias = (a: ReportAggregate) => (a.fn === 'count' ? 'count' : `${a.fn}_${a.field ?? ''}`);

const fieldOf = (entity: EntityDef, key: string, what: string): FieldDef => {
  const f = entity.fields[key];
  if (!f) throw new ValidationError(`Unknown field "${key}" for ${entity.label.toLowerCase()} (${what})`);
  return f;
};
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const day = (v: unknown): string | null => (typeof v === 'string' && DAY_RE.test(v) && !isNaN(Date.parse(v.slice(0, 10))) ? v.slice(0, 10) : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.length <= 200 ? v : null);

// ---------------------------------------------------------------- validation

/** Checks one filter's operator and value against its field; returns the normalised value. */
function validateFilter(entity: EntityDef, flt: ReportFilter): ReportFilter {
  const field = fieldOf(entity, flt.field, 'filter');
  const ops = OPERATORS[field.type];
  if (!ops.includes(flt.op)) throw new ValidationError(`Operator "${flt.op}" is not allowed on ${field.label} (${field.type}); allowed: ${ops.join(', ')}`);
  const bad = (what: string) => new ValidationError(`Filter on ${field.label}: ${what}`);
  const op = flt.op;
  if (op === 'is_empty' || op === 'is_not_empty' || op === 'is_true' || op === 'is_false') return { field: flt.field, op };
  if (field.type === 'text') {
    const v = text(flt.value);
    if (v === null || v === '') throw bad('a text value of at most 200 characters is required');
    return { field: flt.field, op, value: v };
  }
  if (NUMERIC_TYPES.includes(field.type)) {
    if (op === 'between') {
      const [a, b] = Array.isArray(flt.value) ? flt.value.map(num) : [null, null];
      if (a === null || b === null) throw bad('between needs two numbers');
      return { field: flt.field, op, value: [a, b] };
    }
    const v = num(flt.value);
    if (v === null) throw bad('a number is required');
    return { field: flt.field, op, value: v };
  }
  if (DATE_TYPES.includes(field.type)) {
    if (op === 'last_n_days' || op === 'next_n_days') {
      const n = num(flt.value);
      if (n === null || !Number.isInteger(n) || n < 1 || n > 3650) throw bad('a whole number of days between 1 and 3650 is required');
      return { field: flt.field, op, value: n };
    }
    if (op === 'between') {
      const [a, b] = Array.isArray(flt.value) ? flt.value.map(day) : [null, null];
      if (a === null || b === null) throw bad('between needs two dates (YYYY-MM-DD)');
      return { field: flt.field, op, value: [a, b] };
    }
    const v = day(flt.value);
    if (v === null) throw bad('a date (YYYY-MM-DD) is required');
    return { field: flt.field, op, value: v };
  }
  if (LIST_TYPES.includes(field.type)) {
    const list = Array.isArray(flt.value) ? flt.value : typeof flt.value === 'string' ? [flt.value] : [];
    if (!list.length || list.length > 100 || !list.every((x) => typeof x === 'string' && x.length <= 200)) throw bad('a list of 1 to 100 values is required');
    const vals = list as string[];
    if (field.type === 'enum') {
      const allowed = field.options?.values?.map((x) => x.value) ?? [];
      const unknown = vals.filter((x) => !allowed.includes(x));
      if (unknown.length) throw bad(`unknown value(s) ${unknown.map((x) => `"${x}"`).join(', ')}; allowed: ${allowed.join(', ')}`);
    } else {
      const unknown = vals.filter((x) => !UUID_RE.test(x));
      if (unknown.length) throw bad('values must be record ids');
    }
    return { field: flt.field, op, value: vals };
  }
  throw bad('unsupported field type');
}

/**
 * Checks a specification against the entity's catalogue (and the portal rules when
 * `opts.portal`), returning the normalised spec. Every message names the field.
 */
export function validateSpec(entity: EntityDef, raw: unknown, opts: { portal: boolean; maxRows: number }): ReportSpec {
  const parsed = specSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new ValidationError(`Invalid report specification: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'spec'} ${i.message}`).join('; ')}`);
  const spec = parsed.data as ReportSpec;
  if (opts.portal && !entity.portal) throw new ValidationError(`${entity.label} reports cannot be published to the customer portal`);
  const used = new Set<string>();
  const use = (key: string, what: string) => {
    const f = fieldOf(entity, key, what);
    if (opts.portal && !f.portal) throw new ValidationError(`Field "${key}" (${f.label}) is internal and cannot be used in a report visible in the customer portal`);
    used.add(key);
    return f;
  };
  const grouped = spec.groupBy.length > 0;
  for (const c of spec.columns) use(c, 'column');
  if (!grouped && spec.columns.length === 0) throw new ValidationError('Pick at least one column');
  if (new Set(spec.columns).size !== spec.columns.length) throw new ValidationError('A column is listed twice');
  spec.filters = spec.filters.map((flt) => {
    use(flt.field, 'filter');
    return validateFilter(entity, flt);
  });
  for (const g of spec.groupBy) {
    const f = use(g, 'group');
    if (!f.groupable) throw new ValidationError(`Field "${g}" (${f.label}) cannot be grouped by`);
  }
  if (new Set(spec.groupBy).size !== spec.groupBy.length) throw new ValidationError('A group field is listed twice');
  const aliases: string[] = [];
  if (grouped) {
    if (!spec.aggregates.length) throw new ValidationError('A grouped report needs at least one aggregate (count, sum, average, minimum or maximum)');
    for (const a of spec.aggregates) {
      if (!AGG_FNS.includes(a.fn)) throw new ValidationError(`Unknown aggregate "${a.fn}"`);
      if (a.fn !== 'count') {
        if (!a.field) throw new ValidationError(`Aggregate ${a.fn} needs a field`);
        const f = use(a.field, 'aggregate');
        if (!f.aggregatable) throw new ValidationError(`Field "${a.field}" (${f.label}) cannot be aggregated with ${a.fn}`);
      }
      const alias = aggregateAlias(a);
      if (aliases.includes(alias)) throw new ValidationError(`Aggregate ${alias} is listed twice`);
      aliases.push(alias);
    }
  } else if (spec.aggregates.length) throw new ValidationError('Aggregates need a group field');
  if (spec.sort) {
    if (grouped) {
      if (!spec.groupBy.includes(spec.sort.key) && !aliases.includes(spec.sort.key)) throw new ValidationError(`Sort key "${spec.sort.key}" is neither a group field nor an aggregate`);
    } else use(spec.sort.key, 'sort');
  }
  if (spec.dateField !== null) {
    if (!entity.dateFields.includes(spec.dateField)) throw new ValidationError(`Field "${spec.dateField}" cannot be the period field of ${entity.label.toLowerCase()}; choose one of ${entity.dateFields.join(', ')}`);
    use(spec.dateField, 'period');
  }
  if (spec.rowLimit !== null && (spec.rowLimit < 1 || spec.rowLimit > opts.maxRows)) throw new ValidationError(`Row limit must be between 1 and ${opts.maxRows}`);
  if (spec.chart) {
    if (!grouped) throw new ValidationError('A chart needs a grouped report');
    const unknown = spec.chart.y.filter((y) => !aliases.includes(y));
    if (unknown.length) throw new ValidationError(`Chart series "${unknown[0]}" is not an aggregate of this report`);
  }
  return spec;
}

// ---------------------------------------------------------------- compilation

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const ident = (name: string) => sql.identifier(name);

function filterSql(field: FieldDef, flt: ReportFilter): SQL {
  const expr = field.select;
  const v = flt.value;
  switch (flt.op) {
    case 'is_empty': return field.type === 'text' ? sql`coalesce(${expr}, '') = ''` : sql`${expr} IS NULL`;
    case 'is_not_empty': return field.type === 'text' ? sql`coalesce(${expr}, '') <> ''` : sql`${expr} IS NOT NULL`;
    case 'is_true': return sql`${expr} IS TRUE`;
    case 'is_false': return sql`${expr} IS NOT TRUE`;
    case 'eq': return sql`${expr} = ${v}`;
    case 'neq': return sql`${expr} IS DISTINCT FROM ${v}`;
    case 'contains':
      return field.arrayCol ? sql`EXISTS (SELECT 1 FROM unnest(${field.arrayCol}) x WHERE x ILIKE ${`%${escapeLike(String(v))}%`})` : sql`${expr} ILIKE ${`%${escapeLike(String(v))}%`}`;
    case 'not_contains':
      return field.arrayCol ? sql`NOT EXISTS (SELECT 1 FROM unnest(${field.arrayCol}) x WHERE x ILIKE ${`%${escapeLike(String(v))}%`})` : sql`NOT (coalesce(${expr}, '') ILIKE ${`%${escapeLike(String(v))}%`})`;
    case 'starts_with': return sql`${expr} ILIKE ${`${escapeLike(String(v))}%`}`;
    case 'gt': return sql`${expr} > ${v}`;
    case 'gte': return sql`${expr} >= ${v}`;
    case 'lt': return sql`${expr} < ${v}`;
    case 'lte': return sql`${expr} <= ${v}`;
    case 'between': {
      const [a, b] = v as [unknown, unknown];
      return DATE_TYPES.includes(field.type) ? sql`${expr} >= ${a}::date AND ${expr} < ${b}::date + interval '1 day'` : sql`${expr} >= ${a} AND ${expr} <= ${b}`;
    }
    case 'on': return sql`${expr}::date = ${v}::date`;
    case 'before': return sql`${expr} < ${v}::date`;
    case 'after': return sql`${expr} >= ${v}::date + interval '1 day'`;
    case 'last_n_days': return sql`${expr} >= now() - make_interval(days => ${v}::int)`;
    case 'next_n_days': return sql`${expr} >= now() AND ${expr} <= now() + make_interval(days => ${v}::int)`;
    case 'in': {
      const vals = v as string[];
      return field.type === 'enum' ? sql`${expr} = ANY(ARRAY[${sql.join(vals.map((x) => sql`${x}`), sql`, `)}]::text[])` : sql`${field.filterOn ?? expr} = ANY(ARRAY[${sql.join(vals.map((x) => sql`${x}::uuid`), sql`, `)}])`;
    }
    case 'not_in': {
      const vals = v as string[];
      const inner = field.type === 'enum' ? sql`${expr} = ANY(ARRAY[${sql.join(vals.map((x) => sql`${x}`), sql`, `)}]::text[])` : sql`${field.filterOn ?? expr} = ANY(ARRAY[${sql.join(vals.map((x) => sql`${x}::uuid`), sql`, `)}])`;
      return sql`coalesce(${inner}, false) = false`;
    }
    default:
      throw new ValidationError(`Unknown operator "${flt.op}"`);
  }
}

const columnType = (t: FieldType): ReportColumn['type'] => (t === 'option' || t === 'enum' || t === 'ref' ? 'text' : t);
const aggregateType = (a: ReportAggregate, field: FieldDef | null): ReportColumn['type'] => {
  if (a.fn === 'count' || !field) return 'number';
  if (field.type === 'minutes') return 'minutes';
  if (field.type === 'pct') return a.fn === 'sum' ? 'number' : 'pct';
  return 'number';
};
const aggregateLabel = (a: ReportAggregate, field: FieldDef | null) => a.label?.trim() || (a.fn === 'count' ? 'Count' : `${{ sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest' }[a.fn]} ${field?.label.toLowerCase() ?? a.field}`);
const aggregateSql = (a: ReportAggregate, field: FieldDef | null): SQL => {
  if (a.fn === 'count' || !field) return sql`count(*)::int`;
  const e = field.select;
  switch (a.fn) {
    case 'sum': return sql`sum(${e})`;
    case 'avg': return sql`round(avg(${e})::numeric, 1)`;
    case 'min': return sql`min(${e})`;
    case 'max': return sql`max(${e})`;
    default: return sql`count(*)::int`;
  }
};

/**
 * Builds the statement for a validated spec. `params` are the normalised report
 * parameters (customer and period); `opts.limit` is the clamped row limit.
 */
export function compileSpec(ctx: Ctx, entity: EntityDef, spec: ReportSpec, params: { customerId: string | null; from: string; to: string }, opts: { limit: number; portal: boolean }): CompiledQuery {
  const grouped = spec.groupBy.length > 0;
  const needed = new Set<string>();
  const need = (key: string) => {
    const f = fieldOf(entity, key, 'field');
    for (const j of f.joins ?? []) needed.add(j);
    return f;
  };
  const selects: SQL[] = [];
  const columns: ReportColumn[] = [];
  if (grouped) {
    for (const g of spec.groupBy) {
      const f = need(g);
      selects.push(sql`${f.select} AS ${ident(f.key)}`);
      columns.push({ key: f.key, label: f.label, type: columnType(f.type) });
    }
    for (const a of spec.aggregates) {
      const f = a.fn === 'count' ? null : need(a.field!);
      const alias = aggregateAlias(a);
      selects.push(sql`${aggregateSql(a, f)} AS ${ident(alias)}`);
      columns.push({ key: alias, label: aggregateLabel(a, f), type: aggregateType(a, f) });
    }
  } else {
    for (const c of spec.columns) {
      const f = need(c);
      selects.push(sql`${f.select} AS ${ident(f.key)}`);
      columns.push({ key: f.key, label: f.label, type: columnType(f.type) });
    }
  }
  const filters = spec.filters.map((flt) => filterSql(need(flt.field), flt));
  const dateField = spec.dateField ? need(spec.dateField) : null;
  if (spec.sort && !grouped) need(spec.sort.key);

  const joins = Object.entries(entity.joins).filter(([k]) => needed.has(k)).map(([, j]) => j);
  const where = sql`WHERE true ${entity.baseWhere ? entity.baseWhere(ctx) : EMPTY} ${customerCond(params.customerId, entity.customerCol)} ${dateField ? rangeCond(dateField.select, params.from, params.to) : EMPTY} ${filters.length ? sql`AND (${sql.join(filters, spec.match === 'any' ? sql` OR ` : sql` AND `)})` : EMPTY}`;
  const body = sql`SELECT ${sql.join(selects, sql`, `)} FROM ${entity.from} ${joins.length ? sql.join(joins, sql` `) : EMPTY} ${where} ${grouped ? sql`GROUP BY ${sql.join(spec.groupBy.map((_, i) => sql.raw(String(i + 1))), sql`, `)}` : EMPTY}`;

  let order: SQL;
  if (spec.sort) {
    const dir = spec.sort.order === 'asc' ? sql`ASC` : sql`DESC`;
    order = grouped ? sql`ORDER BY ${ident(spec.sort.key)} ${dir} NULLS LAST` : sql`ORDER BY ${entity.fields[spec.sort.key]!.select} ${dir} NULLS LAST`;
  } else if (grouped) {
    order = sql`ORDER BY ${ident(aggregateAlias(spec.aggregates[0]!))} DESC NULLS LAST`;
  } else if (dateField) {
    order = sql`ORDER BY ${dateField.select} DESC NULLS LAST`;
  } else {
    const first = entity.fields[spec.columns[0]!]!;
    order = sql`ORDER BY ${first.select} ASC NULLS LAST`;
  }
  const limit = Math.max(1, Math.min(opts.limit, spec.rowLimit ?? opts.limit));
  return { sql: sql`${body} ${order} LIMIT ${limit}`, countSql: sql`SELECT count(*)::int AS n FROM (${body}) q`, columns, grouped };
}

// ---------------------------------------------------------------- plain-English description

/** The record ids a spec filters on, by directory, so the service can turn them into names (one select per kind). */
export function filterLookups(entity: EntityDef, spec: ReportSpec): { options: string[]; byLookup: Partial<Record<LookupKind, string[]>> } {
  const options = new Set<string>();
  const byLookup: Partial<Record<LookupKind, Set<string>>> = {};
  for (const flt of spec.filters) {
    const field = entity.fields[flt.field];
    if (!field || !Array.isArray(flt.value) || (flt.op !== 'in' && flt.op !== 'not_in')) continue;
    const vals = (flt.value as unknown[]).filter((x): x is string => typeof x === 'string' && UUID_RE.test(x));
    if (field.type === 'option') vals.forEach((v) => options.add(v));
    else if (field.type === 'ref' && field.options?.lookup) {
      const kind = field.options.lookup;
      byLookup[kind] = byLookup[kind] ?? new Set<string>();
      vals.forEach((v) => byLookup[kind]!.add(v));
    }
  }
  return { options: [...options], byLookup: Object.fromEntries(Object.entries(byLookup).map(([k, v]) => [k, [...v!]])) as Partial<Record<LookupKind, string[]>> };
}

export interface DescribeOptions {
  /** Record id → name for option and ref filter values (the ids stay when a name is unknown). */
  labels?: Map<string, string>;
  /** Portal callers: filters are named but their values are never shown. */
  hideValues?: boolean;
}

const describeValue = (field: FieldDef, flt: ReportFilter, labels?: Map<string, string>): string => {
  const v = flt.value;
  if (v === undefined || v === null) return '';
  if (flt.op === 'last_n_days' || flt.op === 'next_n_days') return String(v);
  if (Array.isArray(v)) {
    if (flt.op === 'between') return `${v[0]} and ${v[1]}`;
    const names = v.map((x) => field.options?.values?.find((o) => o.value === x)?.label ?? labels?.get(String(x)) ?? String(x));
    return names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
  }
  return typeof v === 'string' ? `"${v}"` : String(v);
};

/** Plain-English lines describing a specification, for previews, the catalogue and the audit trail. */
export function describeSpec(entity: EntityDef, spec: ReportSpec, opts: DescribeOptions = {}): string[] {
  const label = (k: string) => entity.fields[k]?.label ?? k;
  const lines: string[] = [];
  const grouped = spec.groupBy.length > 0;
  if (grouped) {
    const aggs = spec.aggregates.map((a) => aggregateLabel(a, a.field ? entity.fields[a.field] ?? null : null));
    lines.push(`${entity.label} grouped by ${spec.groupBy.map(label).join(' and ')}: ${aggs.join(', ')}`);
  } else lines.push(`${entity.label}: ${spec.columns.map(label).join(', ')}`);
  for (const flt of spec.filters) {
    if (opts.hideValues) {
      lines.push(`Filter on ${label(flt.field)}`);
      continue;
    }
    const field = entity.fields[flt.field];
    const op = OPERATOR_LABELS[flt.op] ?? flt.op;
    const value = field ? describeValue(field, flt, opts.labels) : '';
    const text = flt.op === 'last_n_days' || flt.op === 'next_n_days' ? op.replace('N', value) : `${op}${value ? ` ${value}` : ''}`;
    lines.push(`Filter: ${label(flt.field)} ${text}`);
  }
  if (spec.filters.length > 1) lines.push(spec.match === 'any' ? 'Rows match any filter' : 'Rows match every filter');
  lines.push(spec.dateField ? `Period: ${label(spec.dateField)} within the chosen range` : 'Period: not applied (every row)');
  if (spec.sort) {
    const key = grouped && !spec.groupBy.includes(spec.sort.key) ? (spec.aggregates.map((a) => [aggregateAlias(a), aggregateLabel(a, a.field ? entity.fields[a.field] ?? null : null)] as const).find(([alias]) => alias === spec.sort!.key)?.[1] ?? spec.sort.key) : label(spec.sort.key);
    lines.push(`Sort: ${key} ${spec.sort.order === 'asc' ? 'ascending' : 'descending'}`);
  }
  if (spec.rowLimit) lines.push(`Limit: ${spec.rowLimit} rows`);
  if (spec.chart && grouped) lines.push(`Chart: ${spec.chart.type} of ${spec.chart.y.join(', ')} by ${label(spec.groupBy[0]!)}`);
  return lines;
}
