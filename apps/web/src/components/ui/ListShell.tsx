import { createContext, useContext, useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { ChevronDown, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SearchInput, Select, type SelectProps } from './index';
import { ModuleNav } from './ModuleNav';
import type { ModuleItem } from '@/layouts/modules';

/**
 * The list page skeleton: a horizontal filter bar on top, the data underneath.
 *
 * The bar is its own surface (a quiet toolbar) so filters never read as data. Each
 * filter is a pill that opens a small popover with its control and shows the chosen
 * value on the pill itself, the way Vercel's deployment and log filters work; a Reset
 * link clears everything. Filter state stays in the URL as before, and the building
 * blocks (FilterGroup, FilterOptions, FilterSelect, FilterDateRange, FilterToggle)
 * keep their props, so every list page picks the new layout up unchanged.
 */

export interface AppliedFilter {
  key: string;
  label: ReactNode;
  onRemove: () => void;
}

export interface ListShellProps {
  /** Page id (kept for callers; the bar has no remembered state). */
  id: string;
  /** Module strip under the header; omit on single-page applications. */
  modules?: ModuleItem[];
  /** Filter pills for the bar (FilterGroup / FilterOptions / FilterSelect …). */
  filters?: ReactNode;
  /** Search box at the start of the bar. */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  /** Number of filters in effect (search excluded or included as the page prefers). */
  activeCount?: number;
  onClear?: () => void;
  /** The filters in effect. Pills already show them, so this only feeds the count. */
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

/** Which pill is open: one popover at a time across the bar. */
const BarContext = createContext<{ openKey: string | null; setOpenKey: (k: string | null) => void } | null>(null);

type PillSummary = { label: ReactNode; count: number } | null;
interface PillApi {
  /** The control inside a pill reports what is selected so the pill can show it. */
  report: (summary: PillSummary) => void;
  /** Closes the popover (single-choice controls do it after a pick). */
  close: () => void;
}
const PillContext = createContext<PillApi | null>(null);

export function ListShell({ modules, filters, search, activeCount = 0, onClear, applied = [], quick, insights, toolbar, count, children, className }: ListShellProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const hasBar = !!filters || !!search;
  const active = Math.max(activeCount, applied.length);
  return (
    <div className={cn('flex flex-col', className)}>
      {modules && <ModuleNav items={modules} />}
      <div className="min-w-0 flex flex-col gap-3">
        {hasBar && (
          <BarContext.Provider value={{ openKey, setOpenKey }}>
            <div className="filter-bar" role="toolbar" aria-label="Filters" data-testid="filter-bar">
              {search && <SearchInput value={search.value} onChange={search.onChange} placeholder={search.placeholder ?? 'Search…'} className="w-full sm:w-64 shrink-0" />}
              {filters && <div className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">{filters}</div>}
              {active > 0 && onClear && (
                <button type="button" onClick={onClear} className="ml-auto inline-flex items-center gap-1 h-8 px-2.5 rounded-lg text-[12.5px] font-medium text-brand-700 hover:bg-white/80 whitespace-nowrap" data-testid="filters-reset">
                  <X className="h-3.5 w-3.5" /> Reset{active > 1 ? ` (${active})` : ''}
                </button>
              )}
            </div>
          </BarContext.Provider>
        )}
        {(quick || toolbar) && (
          <div className="flex flex-wrap items-center gap-2 min-h-8 max-w-full overflow-x-auto [scrollbar-width:thin]">
            {quick}
            {toolbar && <div className="ml-auto flex items-center gap-2">{toolbar}</div>}
          </div>
        )}
        {(count || active > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted" data-testid="applied-filters">
            {count && <span>{count}</span>}
            {active > 0 && <span className="text-subtle">· {active} filter{active === 1 ? '' : 's'} in effect</span>}
          </div>
        )}
        {insights}
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bar building blocks

const textOf = (node: ReactNode, fallback: string) => (typeof node === 'string' || typeof node === 'number' ? String(node) : fallback);

/** A filter pill: the label, the chosen value, and a popover with the control. */
export function FilterGroup({ label, children, hint, className }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean; hint?: ReactNode; className?: string }) {
  const bar = useContext(BarContext);
  const id = useId();
  const [local, setLocal] = useState(false);
  const open = bar ? bar.openKey === id : local;
  const setOpen = (v: boolean) => (bar ? bar.setOpenKey(v ? id : null) : setLocal(v));
  const [summary, setSummary] = useState<PillSummary>(null);
  const ref = useRef<HTMLDivElement>(null);
  const api = useRef<PillApi>({ report: setSummary, close: () => setOpen(false) });
  api.current.close = () => setOpen(false);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const active = !!summary && summary.count > 0;
  const name = textOf(label, 'Filter');
  return (
    <div ref={ref} className={cn('relative', className)}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" className={cn('filter-pill', active && 'filter-pill-active', open && 'filter-pill-open')} data-testid="filter-pill" data-active={active || undefined}>
        <span className={cn(active ? 'text-brand-700/80' : 'text-muted')}>{label}</span>
        {active && (
          <>
            <span className="text-brand-300">·</span>
            <span className="font-medium truncate max-w-[22ch]">{summary!.label}</span>
            {summary!.count > 1 && <span className="filter-pill-count">+{summary!.count - 1}</span>}
          </>
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', active ? 'text-brand-500' : 'text-subtle', open && 'rotate-180')} />
      </button>
      {/* Always mounted so the control can report its selection while closed. */}
      <div role="dialog" aria-label={name} className={cn('absolute left-0 top-full mt-1.5 z-40 w-72 card shadow-pop p-1.5', !open && 'hidden')}>
        {hint && <div className="px-2 pt-1 pb-1.5 text-[11.5px] text-subtle">{hint}</div>}
        <PillContext.Provider value={api.current}>{children}</PillContext.Provider>
      </div>
    </div>
  );
}

const usePill = () => useContext(PillContext);

export interface FilterOption {
  value: string;
  label: ReactNode;
  count?: number | null;
  /** Tailwind background class for a colour dot (e.g. from dotClass()). */
  dot?: string | null;
}

/**
 * Option rows inside a pill: single-choice (click again to clear) or multi-choice.
 * Shows counts on the right and folds long lists.
 */
export function FilterOptions({ options, value, onChange, multi = false, max = 8, emptyLabel }: { options: FilterOption[]; value: string | string[] | undefined; onChange: (next: string | string[] | undefined) => void; multi?: boolean; max?: number; emptyLabel?: ReactNode }) {
  const pill = usePill();
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const selected = new Set(Array.isArray(value) ? value : value ? [value] : []);
  const chosen = [...selected].map((v) => textOf(options.find((o) => o.value === v)?.label, v));
  const key = chosen.join('\u0001');
  useEffect(() => {
    pill?.report(chosen.length ? { label: chosen[0], count: chosen.length } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const needle = q.trim().toLowerCase();
  const filtered = needle ? options.filter((o) => textOf(o.label, o.value).toLowerCase().includes(needle)) : options;
  const shown = all || needle ? filtered : filtered.slice(0, max);
  if (!options.length) return <div className="text-[12px] text-subtle px-2 py-1.5">{emptyLabel ?? 'No options'}</div>;
  const toggle = (v: string) => {
    if (multi) {
      const next = new Set(selected);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      onChange(next.size ? [...next] : undefined);
    } else {
      onChange(selected.has(v) ? undefined : v);
      pill?.close();
    }
  };
  return (
    <div className="flex flex-col">
      {options.length > 10 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find…" aria-label="Find an option" className="input h-7 mb-1 text-[12.5px]" />}
      <div className="flex flex-col max-h-72 overflow-y-auto">
        {shown.map((o) => {
          const on = selected.has(o.value);
          return (
            <button key={o.value} type="button" onClick={() => toggle(o.value)} aria-pressed={on} className={cn('flex items-center gap-2 rounded-md px-2 h-8 text-[12.5px] text-left transition-colors', on ? 'bg-brand-50 text-brand-800' : 'text-secondary hover:bg-surface-2 hover:text-default')}>
              {multi ? (
                <span className={cn('h-3.5 w-3.5 shrink-0 rounded-[4px] border inline-flex items-center justify-center', on ? 'bg-brand-600 border-brand-600 text-white' : 'border-strong bg-white')}>{on && <Check className="h-2.5 w-2.5" strokeWidth={3} />}</span>
              ) : null}
              {o.dot && <span className={cn('h-2 w-2 rounded-full shrink-0', o.dot)} />}
              <span className="truncate flex-1">{o.label}</span>
              {o.count !== undefined && o.count !== null && <span className="tnum text-[11.5px] text-subtle">{o.count}</span>}
              {!multi && on && <Check className="h-3.5 w-3.5 text-brand-600 shrink-0" />}
            </button>
          );
        })}
        {!shown.length && <div className="text-[12px] text-subtle px-2 py-1.5">No matches</div>}
      </div>
      {!needle && filtered.length > max && (
        <button type="button" onClick={() => setAll(!all)} className="self-start px-2 h-7 text-[12px] text-brand-700 hover:underline">
          {all ? 'Show fewer' : `Show all ${filtered.length}`}
        </button>
      )}
      {selected.size > 0 && (
        <button type="button" onClick={() => onChange(undefined)} className="self-start px-2 h-7 text-[12px] text-muted hover:text-default">
          Clear
        </button>
      )}
    </div>
  );
}

/** A select inside a pill (customer, site, team …): closes the pill after a pick. */
export function FilterSelect(props: SelectProps) {
  const pill = usePill();
  const v = props.value == null ? '' : String(props.value);
  const label = v ? textOf(props.options?.find((o) => o.value === v)?.label, v) : '';
  useEffect(() => {
    pill?.report(v ? { label, count: 1 } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, label]);
  return (
    <div className="p-1 flex flex-col gap-1.5">
      <Select
        {...props}
        className={cn('w-full h-8 py-0 text-[13px]', props.className)}
        onChange={(e) => {
          props.onChange?.(e);
          pill?.close();
        }}
      />
      {v && (
        <button type="button" onClick={() => props.onChange?.({ target: { value: '' } } as ChangeEvent<HTMLSelectElement>)} className="self-start px-1 h-6 text-[12px] text-muted hover:text-default">
          Clear
        </button>
      )}
    </div>
  );
}

/** From / to dates inside a pill. */
export function FilterDateRange({ from, to, onChange }: { from?: string; to?: string; onChange: (next: { from?: string; to?: string }) => void }) {
  const pill = usePill();
  useEffect(() => {
    pill?.report(from || to ? { label: `${from ?? '…'} → ${to ?? '…'}`, count: 1 } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);
  return (
    <div className="p-1 flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex flex-col gap-1 text-[11.5px] text-subtle">
          From
          <input type="date" value={from ?? ''} onChange={(e) => onChange({ from: e.target.value || undefined, to })} className="input h-8 py-0 text-[12.5px]" aria-label="From date" />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-subtle">
          To
          <input type="date" value={to ?? ''} onChange={(e) => onChange({ from, to: e.target.value || undefined })} className="input h-8 py-0 text-[12.5px]" aria-label="To date" />
        </label>
      </div>
      {(from || to) && (
        <button type="button" onClick={() => onChange({ from: undefined, to: undefined })} className="self-start px-1 h-6 text-[12px] text-muted hover:text-default">
          Clear
        </button>
      )}
    </div>
  );
}

/** A yes/no row inside a pill ("Only unassigned", "Include retired"). */
export function FilterToggle({ label, checked, onChange, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  const pill = usePill();
  const text = textOf(label, 'On');
  useEffect(() => {
    pill?.report(checked ? { label: text, count: 1 } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, text]);
  return (
    <button type="button" onClick={() => onChange(!checked)} role="switch" aria-checked={checked} className="flex items-center gap-2 rounded-md px-2 h-8 w-full text-[12.5px] text-left text-secondary hover:text-default hover:bg-surface-2 transition-colors" title={typeof hint === 'string' ? hint : undefined}>
      <span className={cn('relative inline-flex h-4 w-7 items-center rounded-full transition-colors shrink-0', checked ? 'bg-brand-600' : 'bg-surface-3 border border-strong')}>
        <span className={cn('inline-block h-3 w-3 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-3.5' : 'translate-x-0.5')} />
      </span>
      <span className="truncate flex-1">{label}</span>
    </button>
  );
}
