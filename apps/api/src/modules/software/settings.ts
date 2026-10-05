import { inArray } from 'drizzle-orm';
import { schema, type Tx } from '@/db/client';

/**
 * The software settings every part of the module reads: notice days for the
 * licence notifications, the stale-install window, the unused-seat threshold
 * and whether a CSV import may add titles to the catalogue. The values are
 * clamped to their ranges; the notice days are coerced from numeric strings
 * (the assistant writes arrays of strings), de-duplicated and sorted descending.
 */
export interface SoftwareSettings {
  noticeDays: number[];
  staleInstallDays: number;
  unusedSeatPct: number;
  importCreatesProducts: boolean;
}

export const DEFAULT_SOFTWARE_SETTINGS: SoftwareSettings = { noticeDays: [90, 30, 7], staleInstallDays: 45, unusedSeatPct: 80, importCreatesProducts: true };

const KEYS = ['software.licence_notice_days', 'software.stale_install_days', 'software.unused_seat_pct', 'software.import_creates_products'];

const clampInt = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function noticeDaysOf(value: unknown, fallback = DEFAULT_SOFTWARE_SETTINGS.noticeDays): number[] {
  const list = Array.isArray(value) ? value.map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 3650).map((n) => Math.round(n)) : [];
  return [...new Set(list.length ? list : fallback)].sort((a, b) => b - a);
}

export async function loadSoftwareSettings(tx: Tx): Promise<SoftwareSettings> {
  const rows = await tx.select({ key: schema.systemSettings.key, value: schema.systemSettings.value }).from(schema.systemSettings).where(inArray(schema.systemSettings.key, KEYS));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const creates = get('software.import_creates_products');
  return {
    noticeDays: noticeDaysOf(get('software.licence_notice_days')),
    staleInstallDays: clampInt(get('software.stale_install_days'), DEFAULT_SOFTWARE_SETTINGS.staleInstallDays, 1, 365),
    unusedSeatPct: clampInt(get('software.unused_seat_pct'), DEFAULT_SOFTWARE_SETTINGS.unusedSeatPct, 0, 100),
    importCreatesProducts: typeof creates === 'boolean' ? creates : DEFAULT_SOFTWARE_SETTINGS.importCreatesProducts,
  };
}

/** The licence metric a title's licence model implies. */
export function defaultMetric(model: string): 'per_device' | 'per_user' | 'per_core' {
  if (model === 'per_user' || model === 'subscription') return 'per_user';
  if (model === 'per_core') return 'per_core';
  return 'per_device';
}

export function defaultTerm(model: string): 'subscription' | 'perpetual' {
  return model === 'subscription' ? 'subscription' : 'perpetual';
}
