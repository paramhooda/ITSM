import { inArray } from 'drizzle-orm';
import { schema, type Tx } from '@/db/client';
import { MAX_REPORT_ROWS } from '../registry';

/** The operating limits of custom reports, from system settings. */
export interface BuilderLimits {
  /** Most rows a file or schedule run returns. */
  maxRows: number;
  /** Rows the builder preview shows. */
  previewRows: number;
  /** Database time limit for one query. */
  statementTimeoutMs: number;
}
export const DEFAULT_LIMITS: BuilderLimits = { maxRows: 10_000, previewRows: 500, statementTimeoutMs: 20_000 };

const clampNum = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** `reports.builder.max_rows`, `reports.builder.preview_rows` and `reports.builder.statement_timeout_ms`. */
export async function loadBuilderLimits(tx: Tx): Promise<BuilderLimits> {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, ['reports.builder.max_rows', 'reports.builder.preview_rows', 'reports.builder.statement_timeout_ms']));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    maxRows: Math.min(MAX_REPORT_ROWS, clampNum(get('reports.builder.max_rows'), DEFAULT_LIMITS.maxRows, 1, 50_000)),
    previewRows: clampNum(get('reports.builder.preview_rows'), DEFAULT_LIMITS.previewRows, 50, 5000),
    statementTimeoutMs: clampNum(get('reports.builder.statement_timeout_ms'), DEFAULT_LIMITS.statementTimeoutMs, 1000, 120_000),
  };
}
