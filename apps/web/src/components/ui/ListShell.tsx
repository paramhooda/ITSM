import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, SlidersHorizontal, X, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, SearchInput, Drawer, Select, type SelectProps } from './index';
import { ModuleNav } from './ModuleNav';
import type { ModuleItem } from '@/layouts/modules';

/**
 * The list page skeleton: a filter rail on the left, the content on the right.
 *
 * Why a rail: filters and results used to sit in identical cards, so a page read
 * as one undifferentiated block. The rail is a quieter surface (bg-surface-2),
 * holds the search box and every filter group, and shows the active count with a
 * single "Clear all". The content column keeps the quick views, the insight band
 * and the table, with the applied filters spelled out as removable chips right
 * above the results. The rail collapses to a button (remembered per page) and
 * becomes a drawer on narrow screens. Filter state stays in the URL as before.
 */

export interface AppliedFilter {
  key: string;
  label: ReactNode;
  onRemove: () => void;
}

export interface ListShellProps {
  /** Page id for remembering the rail state (e.g. "tickets"). */
  id: string;
  /** Module strip under the header; omit on single-page applications. */
  modules?: ModuleItem[];
  /** Filter groups for the rail (FilterGroup / FilterOptions / FilterSelect …). */
  filters?: ReactNode;
  /** Search box at the top of the rail. */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  /** Number of filters in effect (search excluded or included as the page prefers). */
  activeCount?: number;
  onClear?: () => void;
  /** The filters in effect, as removable chips above the results. */
  applied?: AppliedFilter[];
  /** Quick views: status chips, segmented control, saved views. */
  quick?: ReactNode;
  /** Stats and charts band. */
  insights?: ReactNode;
  /** Right-aligned tools: sort, view switch, export, bulk actions. */
  toolbar?: ReactNode;
  /** Results summary: "76 tickets". */
  count?: ReactNode;
  children: ReactNode;
  className?: string;
}

const railKey = (id: string) => `itsm.filters.${id}`;

export function ListShell({ id, modules, filters, search, activeCount = 0, onClear, applied = [], quick, insights, toolbar, count, children, className }: ListShellProps) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(railKey(id)) !== 'closed';
    } catch {
      return true;
    }
  });
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(railKey(id), open ? 'open' : 'closed');
    } catch {
      /* ignore */
    }
  }, [id, open]);
  const hasRail = !!filters || !!search;

  const rail = (
    <div className="flex flex-col gap-3">
      {search && <SearchInput value={search.value} onChange={search.onChange} placeholder={search.placeholder ?? 'Search…'} className="w-full" />}
      {filters}
    </div>
  );

  return (
    <div className={cn('flex flex-col', className)}>
      {modules && <ModuleNav items={modules} />}
      <div className="flex items-start gap-4">
        {hasRail && open && (
          <aside className="hidden lg:flex w-[248px] shrink-0 flex-col rounded-xl border border-default bg-surface-2 sticky top-4 max-h-[calc(100vh-2rem)] overflow-hidden" aria-label="Filters" data-testid="filter-rail">
            <header className="flex items-center gap-2 px-3 h-10 border-b border-default shrink-0">
              <SlidersHorizontal className="h-3.5 w-3.5 text-subtle" />
              <span className="text-[12.5px] font-semibold text-default">Filters</span>
              {activeCount > 0 && <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[10.5px] font-semibold text-white tnum">{activeCount}</span>}
              <span className="ml-auto flex items-center gap-1">
                {activeCount > 0 && onClear && (
                  <button type="button" onClick={onClear} className="text-[12px] text-brand-700 hover:underline">
                    Clear all
                  </button>
                )}
                <button type="button" onClick={() => setOpen(false)} className="h-6 w-6 inline-flex items-center justify-center rounded-md text-subtle hover:text-default hover:bg-white" title="Hide filters" aria-label="Hide filters">
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
              </span>
            </header>
            <div className="overflow-y-auto px-3 py-3">{rail}</div>
          </aside>
        )}
        <div className="min-w-0 flex-1 flex flex-col gap-3">
          {(hasRail || quick || toolbar) && (
            <div className="flex flex-wrap items-center gap-2 min-h-8">
              {hasRail && (
                <>
                  <Button size="sm" variant={activeCount ? 'primary' : 'outline'} icon={<SlidersHorizontal className="h-3.5 w-3.5" />} onClick={() => setDrawer(true)} className="lg:hidden">
                    Filters{activeCount ? ` · ${activeCount}` : ''}
                  </Button>
                  {!open && (
                    <Button size="sm" variant={activeCount ? 'primary' : 'outline'} icon={<SlidersHorizontal className="h-3.5 w-3.5" />} onClick={() => setOpen(true)} className="hidden lg:inline-flex">
                      Filters{activeCount ? ` · ${activeCount}` : ''}
                    </Button>
                  )}
                </>
              )}
              {quick}
              {toolbar && <div className="ml-auto flex items-center gap-2">{toolbar}</div>}
            </div>
          )}
          {(applied.length > 0 || count) && (
            <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]" data-testid="applied-filters">
              {count && <span className="text-muted mr-1">{count}</span>}
              {applied.length > 0 && <span className="text-subtle">filtered by</span>}
              {applied.map((f) => (
                <button key={f.key} type="button" onClick={f.onRemove} className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 text-brand-700 pl-2.5 pr-1.5 h-6 hover:bg-brand-100 transition-colors" title="Remove this filter">
                  <span className="truncate max-w-[32ch]">{f.label}</span>
                  <X className="h-3 w-3" />
                </button>
              ))}
              {applied.length > 1 && onClear && (
                <button type="button" onClick={onClear} className="text-brand-700 hover:underline ml-1">
                  Clear all
                </button>
              )}
            </div>
          )}
          {insights}
          {children}
        </div>
      </div>
      {hasRail && (
        <Drawer open={drawer} onClose={() => setDrawer(false)} title="Filters" width="max-w-sm" footer={<div className="flex items-center justify-between w-full"><span className="text-[12.5px] text-muted">{activeCount ? `${activeCount} in effect` : 'None in effect'}</span><div className="flex gap-2">{activeCount > 0 && onClear && <Button size="sm" variant="ghost" onClick={onClear}>Clear all</Button>}<Button size="sm" onClick={() => setDrawer(false)}>Done</Button></div></div>}>
          {rail}
        </Drawer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- rail building blocks

/** A titled, collapsible group inside the rail. */
export function FilterGroup({ label, children, defaultOpen = true, hint, className }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean; hint?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cn('flex flex-col gap-1.5', className)}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center justify-between w-full text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted hover:text-default">
        <span>{label}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-subtle transition-transform', !open && '-rotate-90')} />
      </button>
      {open && (
        <div className="flex flex-col gap-1">
          {hint && <div className="text-[11.5px] text-subtle">{hint}</div>}
          {children}
        </div>
      )}
    </section>
  );
}

export interface FilterOption {
  value: string;
  label: ReactNode;
  count?: number | null;
  /** Tailwind background class for a colour dot (e.g. from dotClass()). */
  dot?: string | null;
}

/**
 * Option rows for the rail: single-select (radio behaviour, click again to clear)
 * or multi-select (checkboxes). Shows counts on the right and folds long lists.
 */
export function FilterOptions({ options, value, onChange, multi = false, max = 8, emptyLabel }: { options: FilterOption[]; value: string | string[] | undefined; onChange: (next: string | string[] | undefined) => void; multi?: boolean; max?: number; emptyLabel?: ReactNode }) {
  const [all, setAll] = useState(false);
  const selected = new Set(Array.isArray(value) ? value : value ? [value] : []);
  const shown = all ? options : options.slice(0, max);
  if (!options.length) return <div className="text-[12px] text-subtle py-1">{emptyLabel ?? 'No options'}</div>;
  const toggle = (v: string) => {
    if (multi) {
      const next = new Set(selected);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      onChange(next.size ? [...next] : undefined);
    } else onChange(selected.has(v) ? undefined : v);
  };
  return (
    <div className="flex flex-col">
      {shown.map((o) => {
        const on = selected.has(o.value);
        return (
          <button key={o.value} type="button" onClick={() => toggle(o.value)} aria-pressed={on} className={cn('flex items-center gap-2 rounded-md px-2 h-7 text-[12.5px] text-left transition-colors', on ? 'bg-white text-default border border-default shadow-[0_1px_2px_rgba(9,9,11,0.06)]' : 'text-muted hover:text-default hover:bg-white/70 border border-transparent')}>
            <span className={cn('h-3.5 w-3.5 shrink-0 rounded-[4px] border inline-flex items-center justify-center', on ? 'bg-brand-600 border-brand-600' : 'border-strong bg-white', !multi && 'rounded-full')}>{on && <span className={cn('bg-white', multi ? 'h-1.5 w-2 rotate-[-45deg] border-l-2 border-b-2 border-white bg-transparent -mt-0.5' : 'h-1.5 w-1.5 rounded-full')} />}</span>
            {o.dot && <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', o.dot)} />}
            <span className="truncate flex-1">{o.label}</span>
            {o.count !== undefined && o.count !== null && <span className="tnum text-[11.5px] text-subtle">{o.count}</span>}
          </button>
        );
      })}
      {options.length > max && (
        <button type="button" onClick={() => setAll(!all)} className="self-start px-2 h-6 text-[12px] text-brand-700 hover:underline">
          {all ? 'Show fewer' : `Show all ${options.length}`}
        </button>
      )}
    </div>
  );
}

/** A full-width select for the rail (customer, site, team …). */
export function FilterSelect(props: SelectProps) {
  return <Select {...props} className={cn('w-full h-8 py-0 text-[13px]', props.className)} />;
}

/** From / to dates for the rail. */
export function FilterDateRange({ from, to, onChange }: { from?: string; to?: string; onChange: (next: { from?: string; to?: string }) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <input type="date" value={from ?? ''} onChange={(e) => onChange({ from: e.target.value || undefined, to })} className="input h-8 py-0 text-[12.5px]" aria-label="From date" />
      <input type="date" value={to ?? ''} onChange={(e) => onChange({ from, to: e.target.value || undefined })} className="input h-8 py-0 text-[12.5px]" aria-label="To date" />
    </div>
  );
}

/** A yes/no row for the rail ("Only unassigned", "Include retired"). */
export function FilterToggle({ label, checked, onChange, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} role="switch" aria-checked={checked} className="flex items-center gap-2 rounded-md px-2 h-7 text-[12.5px] text-left text-muted hover:text-default hover:bg-white/70 transition-colors" title={typeof hint === 'string' ? hint : undefined}>
      <span className={cn('relative inline-flex h-4 w-7 items-center rounded-full transition-colors shrink-0', checked ? 'bg-brand-600' : 'bg-surface-3 border border-strong')}>
        <span className={cn('inline-block h-3 w-3 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-3.5' : 'translate-x-0.5')} />
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Small helper for pages: the rail's "search" icon state when the rail is hidden. */
export const SearchIcon = Search;
