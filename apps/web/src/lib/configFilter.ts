/**
 * Client-side filtering for configuration lists: a quick search over named columns,
 * single-choice selects, an "include inactive" switch and paging, all driven by the
 * URL keys `q`, the select keys, `inactive` and `page` (useConfigFilter owns the URL;
 * this module is pure so the API suite can test it, so it imports nothing).
 *
 * The view a page opens on is "All" (the active rows when rows carry an active flag);
 * every condition narrows it and reads as a removable breadcrumb chip, and the count
 * reads "12 of 48" (rows matching the conditions of the rows in the view).
 */

export interface ConfigOptionDef {
  value: string;
  label: string;
}

export interface ConfigSelectDef<T> {
  /** URL key (`domain`, `type`). */
  key: string;
  /** The pill's label ("Domain"); the chip reads "Domain: NOC". */
  label: string;
  options: ConfigOptionDef[];
  predicate: (row: T, value: string) => boolean;
}

export interface ConfigFilterDef<T> {
  /** The columns the quick search looks at; every space-separated term must match one of them. */
  search: ((row: T) => unknown)[];
  selects?: ConfigSelectDef<T>[];
  /** When given, inactive rows stay out of the view until `inactive=1` ("Include inactive"). */
  active?: (row: T) => boolean;
  /** Rows per page (default 50). */
  pageSize?: number;
}

export const CONFIG_PAGE_SIZE = 50;

/** The URL state the filter reads (`useListState().state`). */
export type ConfigFilterState = Record<string, string | undefined>;

export const includesInactive = (state: ConfigFilterState) => state.inactive === '1' || state.inactive === 'true';

export function searchText(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(searchText).join(' ');
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map(searchText).join(' ');
  return String(value);
}

/** Case-insensitive match: each term of the needle must appear in one of the values. */
export function matchesSearch(needle: string, values: unknown[]): boolean {
  const terms = needle.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = values.map(searchText).join('\n').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export interface ConfigFilterResult<T> {
  /** The rows of the view before search and selects (active rows unless inactive ones are included). */
  base: T[];
  /** The rows matching every condition. */
  matching: T[];
  /** The rows of the current page. */
  rows: T[];
  page: number;
  pages: number;
  pageSize: number;
  /** For each select, how many rows each option would leave under the other conditions. */
  facets: Record<string, Record<string, number>>;
}

export function applyConfigFilter<T>(all: T[], def: ConfigFilterDef<T>, state: ConfigFilterState): ConfigFilterResult<T> {
  const pageSize = def.pageSize ?? CONFIG_PAGE_SIZE;
  const base = def.active && !includesInactive(state) ? all.filter((r) => def.active!(r)) : all;
  const q = state.q ?? '';
  const selects = def.selects ?? [];
  const chosen = selects.map((s) => ({ s, v: state[s.key] ?? '' })).filter((x) => x.v);
  const passes = (row: T, except?: string) => matchesSearch(q, def.search.map((f) => f(row))) && chosen.every(({ s, v }) => s.key === except || s.predicate(row, v));
  const matching = base.filter((r) => passes(r));
  const facets: Record<string, Record<string, number>> = {};
  for (const s of selects) {
    const counts: Record<string, number> = {};
    for (const o of s.options) counts[o.value] = 0;
    for (const r of base) {
      if (!passes(r, s.key)) continue;
      for (const o of s.options) if (s.predicate(r, o.value)) counts[o.value] = (counts[o.value] ?? 0) + 1;
    }
    facets[s.key] = counts;
  }
  const pages = Math.max(1, Math.ceil(matching.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(state.page ?? 1)) || 1));
  const rows = matching.slice((page - 1) * pageSize, page * pageSize);
  return { base, matching, rows, page, pages, pageSize, facets };
}

/** A condition in effect: the chip's label and the URL keys that clear it. */
export interface ConfigCondition {
  key: string;
  keys: string[];
  label: string;
}

export interface ConditionSpec {
  /** Selects: the chip reads "Label: Option". */
  selects?: { key: string; label: string; options: ConfigOptionDef[] }[];
  /** Other keys the page filters on (free text, dates): the chip's label from the value, or null for none; `keys` when the chip clears more than its own key (a date range). */
  extra?: { key: string; keys?: string[]; label: (value: string, state: ConfigFilterState) => string | null }[];
  /** Pass false when the page has no search box. */
  search?: boolean;
  /** Pass true when the page offers the include-inactive switch. */
  inactive?: boolean;
}

/**
 * The conditions in effect in the order they appear in the URL, which is the order they
 * were applied: a search chip, one chip per select or extra key, and "Including inactive".
 */
export function configConditions(state: ConfigFilterState, spec: ConditionSpec): ConfigCondition[] {
  const out: ConfigCondition[] = [];
  const selects = new Map((spec.selects ?? []).map((s) => [s.key, s]));
  const extra = new Map((spec.extra ?? []).map((e) => [e.key, e]));
  for (const [key, raw] of Object.entries(state)) {
    const value = raw ?? '';
    if (!value) continue;
    if (key === 'q' && spec.search !== false) {
      if (value.trim()) out.push({ key, keys: [key], label: `Search: ${value.trim()}` });
    } else if (key === 'inactive' && spec.inactive) {
      if (includesInactive(state)) out.push({ key, keys: [key], label: 'Including inactive' });
    } else if (selects.has(key)) {
      const s = selects.get(key)!;
      out.push({ key, keys: [key], label: `${s.label}: ${s.options.find((o) => o.value === value)?.label ?? value}` });
    } else if (extra.has(key)) {
      const e = extra.get(key)!;
      const label = e.label(value, state);
      if (label) out.push({ key, keys: e.keys ?? [key], label });
    }
  }
  return out;
}

/** "48 services" when every row of the view shows, otherwise "12 of 48 services". */
export function countLabel(matching: number, total: number, noun: [string, string] = ['entry', 'entries']): string {
  const word = total === 1 && matching === total ? noun[0] : noun[1];
  const fmt = (n: number) => n.toLocaleString('en-IN');
  return matching === total ? `${fmt(total)} ${word}` : `${fmt(matching)} of ${fmt(total)} ${word}`;
}

/**
 * The whole order of a list with `id` moved to the other side of `neighbourId` (before it
 * when `dir` is -1, after it when 1). A reorder action on a page whose view hides rows
 * (inactive ones) moves past the row the person sees next to it, so a hidden row keeps
 * its place and never swallows a move; the order comes back unchanged when either id is
 * missing or they are the same row.
 */
export function moveBeside(ids: string[], id: string, neighbourId: string, dir: -1 | 1): string[] {
  if (id === neighbourId || !ids.includes(id) || !ids.includes(neighbourId)) return ids;
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(neighbourId) + (dir === 1 ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** The URL keys a filter definition owns (what the root chip resets). */
export function configFilterKeys(spec: ConditionSpec): string[] {
  return [...new Set([...(spec.search === false ? [] : ['q']), ...(spec.selects ?? []).map((s) => s.key), ...(spec.extra ?? []).flatMap((e) => e.keys ?? [e.key]), ...(spec.inactive ? ['inactive'] : []), 'page'])];
}
