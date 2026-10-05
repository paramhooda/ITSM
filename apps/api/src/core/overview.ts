import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * Shared shapes and helpers for the module Overview endpoints
 * (`GET /<module>/overview`). The response contract lives in
 * apps/web/src/components/overview/types.ts; keep the two in step.
 */

export interface Bucket {
  key: string;
  label: string;
  count: number;
  /** Colour key as used by the web `statusColors` palette (null when the dimension has none). */
  color?: string | null;
}

export interface CoverageBuckets {
  /** Past the end date. */
  expired: number;
  /** Ends within 30 days (today included). */
  d30: number;
  /** Ends in 31 to 90 days. */
  d90: number;
  /** Ends later than 90 days. */
  ok: number;
  /** No end date recorded. */
  none: number;
}

// ---------------------------------------------------------------- colours (mirror apps/web/src/lib/statusColors.ts)

export const LIFECYCLE_COLORS: Record<string, string> = { ordered: 'blue', in_stock: 'sky', deployed: 'green', in_repair: 'amber', retired: 'slate', disposed: 'gray' };
export const VISIT_STATUS_COLORS: Record<string, string> = { requested: 'slate', scheduled: 'blue', in_progress: 'amber', completed: 'green', cancelled: 'gray' };
export const PM_STATUS_COLORS: Record<string, string> = { planned: 'slate', scheduled: 'blue', rescheduled: 'indigo', completed: 'green', missed: 'red', cancelled: 'gray' };
export const KB_STATUS_COLORS: Record<string, string> = { draft: 'amber', review: 'blue', published: 'green', archived: 'slate' };
export const KB_VISIBILITY_COLORS: Record<string, string> = { internal: 'slate', customer: 'violet', public: 'green' };
/** Licence compliance position per title and customer (mirrors COMPLIANCE_COLORS on the web). */
export const COMPLIANCE_COLORS: Record<string, string> = { compliant: 'green', under_deployed: 'amber', over_deployed: 'red', unlicensed: 'red', unlimited: 'blue' };
export const INSTALL_SOURCE_COLORS: Record<string, string> = { manual: 'slate', csv: 'blue', discovery: 'indigo', agent: 'violet' };

// ---------------------------------------------------------------- dates (civil, UTC)

export const todayStr = (now: Date = new Date()) => now.toISOString().slice(0, 10);
export const dateToUtc = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
};
export const addDays = (d: string, days: number) => new Date(dateToUtc(d) + days * 86_400_000).toISOString().slice(0, 10);
/** Whole days from `from` to `to` (negative when `to` is in the past). */
export const daysBetween = (from: string, to: string) => Math.round((dateToUtc(to) - dateToUtc(from)) / 86_400_000);
/** First day of the month `offset` months after the month of `d`. */
export function monthStart(d: string, offset = 0) {
  const [y, m] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 10);
}
export const monthKey = (d: string) => d.slice(0, 7);

// ---------------------------------------------------------------- bucket helpers

/** "in_progress" -> "In progress". */
export const titleCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : s);

/**
 * Zero-filled buckets in a fixed order (enum-like dimensions). Values outside
 * `order` are appended in the order they appear.
 */
export function fixedBuckets(order: readonly string[], rows: { key: string | null; count: number }[], opts: { labels?: Record<string, string>; colors?: Record<string, string> } = {}): Bucket[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.key ?? 'none', (counts.get(r.key ?? 'none') ?? 0) + Number(r.count ?? 0));
  const out: Bucket[] = order.map((key) => ({ key, label: opts.labels?.[key] ?? titleCase(key), count: counts.get(key) ?? 0, color: opts.colors?.[key] ?? null }));
  for (const [key, count] of counts) if (!order.includes(key)) out.push({ key, label: opts.labels?.[key] ?? titleCase(key), count, color: opts.colors?.[key] ?? null });
  return out;
}

/** Buckets for a grouped query (picklists, entities): count descending, then label. */
export function countBuckets(rows: { key: string | null; label: string | null; count: number; color?: string | null }[], unsetLabel = 'Unset'): Bucket[] {
  return rows
    .map((r) => ({ key: r.key ?? 'none', label: r.label ?? unsetLabel, count: Number(r.count ?? 0), color: r.color ?? null }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Count expressions for the CoverageBuckets of a `date` column (today inclusive in d30). */
export function coverageSelect(col: AnyColumn | SQL, today: string, extra?: SQL) {
  const and = extra ? sql` and ${extra}` : sql``;
  return {
    expired: sql<number>`count(*) filter (where ${col} < ${today}::date${and})::int`,
    d30: sql<number>`count(*) filter (where ${col} >= ${today}::date and ${col} <= ${addDays(today, 30)}::date${and})::int`,
    d90: sql<number>`count(*) filter (where ${col} > ${addDays(today, 30)}::date and ${col} <= ${addDays(today, 90)}::date${and})::int`,
    ok: sql<number>`count(*) filter (where ${col} > ${addDays(today, 90)}::date${and})::int`,
    none: sql<number>`count(*) filter (where ${col} is null${and})::int`,
  };
}

export const EMPTY_COVERAGE: CoverageBuckets = { expired: 0, d30: 0, d90: 0, ok: 0, none: 0 };

export const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
export const pct1 = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
/** Timestamps from raw `execute` rows arrive as pg text; normalise to ISO (or null). */
export const isoOf = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
};
