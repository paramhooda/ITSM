import type { AppliedFilter, FilterOption } from '@/components/ui';
import { applyConfigFilter, configConditions, configFilterKeys, countLabel, includesInactive, type ConditionSpec, type ConfigFilterDef, type ConfigFilterState, type ConfigOptionDef, type ConfigSelectDef } from '@/lib/configFilter';
import { useListState } from './useListState';

export interface ConfigFilterOptions<T> extends ConfigFilterDef<T> {
  /** Singular and plural noun for the count line ("48 services", "12 of 48 services"). */
  noun?: [string, string];
  searchPlaceholder?: string;
}

/** What ConfigToolbar needs for one select pill. */
export interface ToolbarSelect {
  key: string;
  label: string;
  value: string;
  onChange: (v: string | undefined) => void;
  options: FilterOption[];
}

/** The props a page spreads onto ConfigToolbar (`<ConfigToolbar {...f.toolbar}>`). */
export interface ToolbarState {
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  selects?: ToolbarSelect[];
  inactive?: { value: boolean; onChange: (v: boolean) => void };
  applied: AppliedFilter[];
  onClear: () => void;
  count: string;
}

export interface Pager {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}

/**
 * Search, selects, "Include inactive" and paging over the rows a configuration page
 * already holds, with the state in the URL (`q`, the select keys, `inactive`, `page`;
 * defaults stay out of the URL, and changing a condition returns to page 1), so the
 * back button restores a view and a link can carry one.
 */
export function useConfigFilter<T>(all: T[], def: ConfigFilterOptions<T>) {
  const { state, set, setPage } = useListState();
  // Computed on every render rather than memoised: a page holds at most a few hundred rows,
  // and a search column may read a lookup that loads after the rows (a team's name, a
  // policy's label), which a memo keyed on the rows and the URL would miss.
  const result = applyConfigFilter(all, def, state as ConfigFilterState);

  const selects: ConfigSelectDef<T>[] = def.selects ?? [];
  const spec = { selects, search: true, inactive: !!def.active };
  const keys = configFilterKeys(spec);
  const clear = () => set(Object.fromEntries(keys.map((k) => [k, undefined])));
  const applied: AppliedFilter[] = configConditions(state as ConfigFilterState, spec).map((c) => ({ key: c.key, label: c.label, onRemove: () => set(Object.fromEntries(c.keys.map((k) => [k, undefined]))) }));
  const counts = { shown: result.rows.length, matching: result.matching.length, total: result.base.length };
  const count = countLabel(counts.matching, counts.total, def.noun);
  const inactive = includesInactive(state as ConfigFilterState);

  const toolbar: ToolbarState = {
    search: { value: state.q ?? '', onChange: (v) => set({ q: v.trim() ? v : undefined }), placeholder: def.searchPlaceholder },
    selects: selects.map((s) => ({
      key: s.key,
      label: s.label,
      value: state[s.key] ?? '',
      onChange: (v) => set({ [s.key]: v || undefined }),
      options: s.options.map((o) => ({ value: o.value, label: o.label, count: result.facets[s.key]?.[o.value] ?? 0 })),
    })),
    inactive: def.active ? { value: inactive, onChange: (v) => set({ inactive: v ? '1' : undefined }) } : undefined,
    applied,
    onClear: clear,
    count,
  };
  const pager: Pager | null = counts.matching > result.pageSize ? { page: result.page, pageSize: result.pageSize, total: counts.matching, onPage: setPage } : null;

  return {
    /** The rows of the current page. */
    rows: result.rows,
    /** Every row matching the conditions (all pages). */
    matching: result.matching,
    counts,
    count,
    page: result.page,
    pages: result.pages,
    pager,
    /** True when any condition is in effect (a chip shows): the empty state then reads "No X match". */
    filtered: applied.length > 0,
    /** True when a search or a select hides rows of the view; "Include inactive" alone widens it, so a reorder action stays available. */
    narrowed: applied.some((a) => a.key !== 'inactive'),
    applied,
    clear,
    q: state.q ?? '',
    setQ: (v: string) => set({ q: v.trim() ? v : undefined }),
    inactive,
    setInactive: (v: boolean) => set({ inactive: v ? '1' : undefined }),
    select: (key: string) => state[key] ?? '',
    setSelect: (key: string, v: string | undefined) => set({ [key]: v || undefined }),
    state,
    set,
    toolbar,
  };
}

export interface ServerToolbarSpec extends ConditionSpec {
  selects?: { key: string; label: string; options: ConfigOptionDef[] }[];
  searchPlaceholder?: string;
  noun?: [string, string];
  /** Rows the server returned for the conditions, and the rows of the unfiltered view when known. */
  matching?: number;
  total?: number;
}

/**
 * The same toolbar for a page that filters on the server (Users, Audit log): its
 * `useListState` keys stay as they are; this wires them to the search box, the pills,
 * the breadcrumb and the count so the page reads like every other configuration list.
 */
export function serverToolbar(state: Record<string, string>, set: (patch: Record<string, string | undefined>) => void, spec: ServerToolbarSpec): ToolbarState {
  const keys = configFilterKeys(spec);
  const applied: AppliedFilter[] = configConditions(state, spec).map((c) => ({ key: c.key, label: c.label, onRemove: () => set(Object.fromEntries(c.keys.map((k) => [k, undefined]))) }));
  const matching = spec.matching;
  const total = spec.total ?? matching;
  return {
    search: spec.search === false ? undefined : { value: state.q ?? '', onChange: (v) => set({ q: v.trim() ? v : undefined }), placeholder: spec.searchPlaceholder },
    selects: (spec.selects ?? []).map((s) => ({ key: s.key, label: s.label, value: state[s.key] ?? '', onChange: (v) => set({ [s.key]: v || undefined }), options: s.options })),
    applied,
    onClear: () => set(Object.fromEntries(keys.map((k) => [k, undefined]))),
    count: matching === undefined || total === undefined ? '' : countLabel(matching, total, spec.noun),
  };
}
