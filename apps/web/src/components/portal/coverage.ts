import type { BreakdownItem } from '@/components/dashboards/BreakdownBar';
import type { CoverageBuckets } from '@/components/overview/types';
import { withQuery } from '@/components/overview/api';
import { COVER_LABEL, coverageTotal, type CoverKind } from '@/components/overview/coverage';

export { COVER_LABEL, coverageTotal, type CoverKind };

export const PORTAL_INVENTORY = '/portal/assets/inventory';

/**
 * The five coverage buckets of the portal overview as BreakdownBar rows, in time
 * order, linking to the inventory with the matching `expiring` filter. Tones are
 * status colours paired with the row label (expired = bad, ending = warn, later =
 * good, no date = neutral), never a series colour.
 */
export function portalCoverageItems(kind: CoverKind, b: CoverageBuckets): BreakdownItem[] {
  const list = (expiring: string) => withQuery(PORTAL_INVENTORY, { expiring });
  return [
    { label: 'Expired', value: b.expired, color: 'red', href: list('expired') },
    { label: 'Ends within 30 days', value: b.d30, color: 'amber', href: list(`${kind}30`) },
    { label: 'Ends in 31–90 days', value: b.d90, color: 'amber', href: list(`${kind}90`) },
    { label: 'Later', value: b.ok, color: 'green', href: PORTAL_INVENTORY },
    { label: 'No end date', value: b.none, color: 'slate', href: PORTAL_INVENTORY },
  ];
}

/** Opens one asset's drawer on the inventory: the list is narrowed to its tag so the row is on the page. */
export const portalAssetLink = (a: { id: string; tag: string }, extra: Record<string, string | undefined> = {}) => withQuery(PORTAL_INVENTORY, { ...extra, q: a.tag, asset: a.id });
