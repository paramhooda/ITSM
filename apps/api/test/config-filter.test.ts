import { describe, it, expect } from 'vitest';
import { applyConfigFilter, configConditions, configFilterKeys, countLabel, matchesSearch, moveBeside, type ConfigFilterDef } from '../../web/src/lib/configFilter';

/**
 * The configuration-page toolbar filters client-side through one pure module (the
 * web's lib/configFilter.ts), so the contract every administration list relies on
 * is pinned here: the view hides inactive rows until asked, every term of a search
 * must match, selects narrow with facet counts, paging clamps, the breadcrumb reads
 * the URL in the order applied and the count line says "12 of 48".
 */
interface Row {
  id: string;
  name: string;
  key: string;
  domain: string;
  tags: string[];
  isActive: boolean;
}

const rows: Row[] = [
  { id: '1', name: 'Firewall management', key: 'fw_mgmt', domain: 'noc', tags: ['network', 'security'], isActive: true },
  { id: '2', name: 'Endpoint protection', key: 'edr', domain: 'soc', tags: ['security'], isActive: true },
  { id: '3', name: 'Backup monitoring', key: 'backup', domain: 'noc', tags: ['storage'], isActive: false },
  { id: '4', name: 'Field maintenance', key: 'field', domain: 'amc', tags: [], isActive: true },
  { id: '5', name: 'Network monitoring', key: 'net_mon', domain: 'noc', tags: ['network'], isActive: true },
];

const def: ConfigFilterDef<Row> = {
  search: [(r) => r.name, (r) => r.key, (r) => r.tags],
  selects: [{ key: 'domain', label: 'Domain', options: [{ value: 'noc', label: 'NOC' }, { value: 'soc', label: 'SOC' }, { value: 'amc', label: 'AMC' }], predicate: (r, v) => r.domain === v }],
  active: (r) => r.isActive,
};

describe('config filter', () => {
  it('matches every term, ignoring case, across strings and arrays', () => {
    expect(matchesSearch('', ['x'])).toBe(true);
    expect(matchesSearch('FIRE', ['Firewall management'])).toBe(true);
    expect(matchesSearch('net mon', ['Network monitoring', 'net_mon'])).toBe(true);
    expect(matchesSearch('net storage', ['Network monitoring', ['network']])).toBe(false);
    expect(matchesSearch('security', [['network', 'security']])).toBe(true);
  });

  it('opens on the active rows and includes inactive ones only when asked', () => {
    const plain = applyConfigFilter(rows, def, {});
    expect(plain.base.map((r) => r.id)).toEqual(['1', '2', '4', '5']);
    expect(plain.matching).toHaveLength(4);
    const all = applyConfigFilter(rows, def, { inactive: '1' });
    expect(all.base).toHaveLength(5);
    expect(applyConfigFilter(rows, { search: def.search }, {}).base).toHaveLength(5);
  });

  it('narrows by search and select together and counts facets under the other conditions', () => {
    const r = applyConfigFilter(rows, def, { q: 'monitoring', domain: 'noc' });
    expect(r.matching.map((x) => x.id)).toEqual(['5']);
    // The domain facet ignores the domain choice itself but keeps the search: NOC 1 (Network monitoring), SOC 0, AMC 0.
    expect(r.facets.domain).toEqual({ noc: 1, soc: 0, amc: 0 });
    const noSearch = applyConfigFilter(rows, def, { domain: 'soc' });
    expect(noSearch.facets.domain).toEqual({ noc: 2, soc: 1, amc: 1 });
  });

  it('pages over the matching rows and clamps the page', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: String(i), name: `Row ${i}`, key: `r${i}`, domain: 'noc', tags: [], isActive: true }));
    const p1 = applyConfigFilter(many, { search: [(r) => r.name] }, {});
    expect(p1.rows).toHaveLength(50);
    expect(p1.pages).toBe(3);
    const p3 = applyConfigFilter(many, { search: [(r) => r.name] }, { page: '3' });
    expect(p3.rows).toHaveLength(20);
    expect(p3.page).toBe(3);
    const beyond = applyConfigFilter(many, { search: [(r) => r.name] }, { page: '9' });
    expect(beyond.page).toBe(3);
    const small = applyConfigFilter(many, { search: [(r) => r.name], pageSize: 10 }, { page: 'x' });
    expect(small.page).toBe(1);
    expect(small.rows).toHaveLength(10);
  });

  it('reads the conditions back as chips in the order of the URL', () => {
    const spec = { selects: def.selects!, inactive: true, extra: [{ key: 'from', keys: ['from', 'to'], label: (v: string, st: Record<string, string | undefined>) => `Date: ${v} → ${st.to ?? '…'}` }] };
    const chips = configConditions({ domain: 'noc', q: 'fire', inactive: '1', from: '2026-09-01', to: '2026-09-30', page: '2' }, spec);
    expect(chips.map((c) => c.label)).toEqual(['Domain: NOC', 'Search: fire', 'Including inactive', 'Date: 2026-09-01 → 2026-09-30']);
    expect(chips[3].keys).toEqual(['from', 'to']);
    expect(configConditions({ q: '  ' }, spec)).toEqual([]);
    expect(configConditions({ inactive: '1' }, { selects: def.selects! })).toEqual([]);
    expect(configFilterKeys(spec)).toEqual(['q', 'domain', 'from', 'to', 'inactive', 'page']);
  });

  it('counts "12 of 48" only when a condition narrows the view', () => {
    expect(countLabel(48, 48, ['service', 'services'])).toBe('48 services');
    expect(countLabel(12, 48, ['service', 'services'])).toBe('12 of 48 services');
    expect(countLabel(1, 1, ['policy', 'policies'])).toBe('1 policy');
    expect(countLabel(0, 1, ['policy', 'policies'])).toBe('0 of 1 policies');
    expect(countLabel(0, 0)).toBe('0 entries');
  });

  it('moves a row past the row shown next to it, leaving hidden rows in place', () => {
    // A, b, C, d, E with b and d hidden from the view (inactive): the person sees A, C, E.
    const order = ['A', 'b', 'C', 'd', 'E'];
    expect(moveBeside(order, 'C', 'A', -1)).toEqual(['C', 'A', 'b', 'd', 'E']);
    expect(moveBeside(order, 'C', 'E', 1)).toEqual(['A', 'b', 'd', 'E', 'C']);
    expect(moveBeside(order, 'A', 'C', 1)).toEqual(['b', 'C', 'A', 'd', 'E']);
    expect(moveBeside(order, 'E', 'C', -1)).toEqual(['A', 'b', 'E', 'C', 'd']);
    // Nothing to do: the same row, or an id the list does not hold.
    expect(moveBeside(order, 'C', 'C', 1)).toBe(order);
    expect(moveBeside(order, 'C', 'zz', 1)).toBe(order);
    expect(moveBeside(order, 'zz', 'C', 1)).toBe(order);
  });
});
