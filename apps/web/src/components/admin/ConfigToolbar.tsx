import type { ReactNode } from 'react';
import { SearchInput, Toggle, ListFilterBar, ResetButton, BreadcrumbRow, FilterGroup, FilterOptions, type AppliedFilter } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { ToolbarSelect } from '@/hooks/useConfigFilter';

export interface ConfigToolbarProps {
  /** The quick search (debounced; `data-testid="config-search"`). */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  /** Single-choice pills, the same FilterGroup/FilterOptions the lists use. */
  selects?: ToolbarSelect[];
  /** The "Include inactive" switch, offered only when rows carry an active flag. */
  inactive?: { value: boolean; onChange: (v: boolean) => void; label?: string };
  /** A control at the start of the bar (the list picker on Option lists). */
  lead?: ReactNode;
  /** More filter controls after the pills (a date-range pill, free-text inputs). */
  extra?: ReactNode;
  /** The conditions in effect, in the order applied. */
  applied?: AppliedFilter[];
  onClear?: () => void;
  /** The breadcrumb's root chip (default "All"). */
  root?: ReactNode;
  /** The count line ("12 of 48 services"; `data-testid="list-count"`). */
  count?: ReactNode;
  /** Page-specific buttons at the end of the bar. */
  children?: ReactNode;
  className?: string;
}

/**
 * The one toolbar every configuration page gets: a search box, filter pills, the
 * "Include inactive" switch and the page's own buttons on the same quiet bar the
 * lists use, with the conditions in effect as a breadcrumb and the count beside it.
 * It is fully controlled: `useConfigFilter` drives it for client-side pages, and a
 * page that filters on the server (Users, Audit log) wires its URL state to it.
 */
export function ConfigToolbar({ search, selects = [], inactive, lead, extra, applied = [], onClear, root = 'All', count, children, className }: ConfigToolbarProps) {
  const active = applied.length;
  return (
    <div className={cn('flex flex-col gap-3 mb-3', className)} data-testid="config-toolbar">
      <ListFilterBar>
        {lead}
        {search && <SearchInput value={search.value} onChange={search.onChange} placeholder={search.placeholder ?? 'Search…'} className="w-full sm:w-64 shrink-0" testId="config-search" />}
        {/* On a phone the pills take a row of their own and the switch, Reset and the page's buttons the next, so a wide
            pill never runs under the switch; from `sm` the pills grow beside the search and the rest sits at the end. */}
        {(selects.length > 0 || extra) && (
          <div className="flex flex-wrap items-center gap-1.5 min-w-0 basis-full sm:basis-0 sm:flex-1">
            {selects.map((s) => (
              <FilterGroup key={s.key} label={s.label}>
                <FilterOptions options={s.options} value={s.value || undefined} onChange={(v) => s.onChange(Array.isArray(v) ? v[0] : v)} />
              </FilterGroup>
            ))}
            {extra}
          </div>
        )}
        {(inactive || (active > 0 && onClear) || children) && (
          <div className="flex flex-wrap items-center gap-2 basis-full sm:basis-auto sm:ml-auto">
            {inactive && (
              <span className="inline-flex items-center h-8 px-1 text-muted" data-testid="config-inactive">
                <Toggle checked={inactive.value} onChange={inactive.onChange} label={inactive.label ?? 'Include inactive'} />
              </span>
            )}
            {active > 0 && onClear && <ResetButton onClick={onClear} count={active} className="sm:ml-auto" />}
            {children}
          </div>
        )}
      </ListFilterBar>
      <BreadcrumbRow root={root} applied={applied} active={active} onClear={onClear} count={count} />
    </div>
  );
}
