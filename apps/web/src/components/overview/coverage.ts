import type { BreakdownItem } from '@/components/dashboards/BreakdownBar';
import type { CoverageBuckets } from './types';
import { withQuery } from './api';

export type CoverKind = 'warranty' | 'amc';
export const COVER_LABEL: Record<CoverKind, string> = { warranty: 'Warranty', amc: 'AMC' };

/**
 * The five coverage buckets as BreakdownBar rows, in time order. Tones are status
 * colours (expired = bad, ending = warn, later = good, no date = neutral) and the
 * rows link to the inventory where a matching list filter exists (≤30 d, ≤90 d),
 * else to the Warranty & AMC module for that kind.
 */
export function coverageItems(kind: CoverKind, b: CoverageBuckets, customerId?: string): BreakdownItem[] {
  const list = (expiring: string) => withQuery('/assets/inventory', { expiring, customerId });
  const module = withQuery('/assets/coverage', { kind, customerId });
  return [
    { label: 'Expired', value: b.expired, color: 'red', href: module },
    { label: 'Ends within 30 days', value: b.d30, color: 'amber', href: list(`${kind}30`) },
    { label: 'Ends in 31–90 days', value: b.d90, color: 'amber', href: list(`${kind}90`) },
    { label: 'Later', value: b.ok, color: 'green', href: module },
    { label: 'No end date', value: b.none, color: 'slate', href: module },
  ];
}

export const coverageTotal = (b: CoverageBuckets) => b.expired + b.d30 + b.d90 + b.ok + b.none;
