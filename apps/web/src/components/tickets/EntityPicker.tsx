import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PickerItem {
  id: string;
  label: string;
  sublabel?: string | null;
  badge?: ReactNode;
}

/**
 * Search-as-you-type picker used for CIs, assets and tickets. `search` runs
 * against the API (debounced); selected items are shown as chips when
 * `multiple`, or as a single value otherwise.
 */
export function EntityPicker({ search, value, onChange, placeholder = 'Search…', multiple, disabled, className, queryKey, minChars = 1 }: { search: (q: string) => Promise<PickerItem[]>; value: PickerItem[]; onChange: (items: PickerItem[]) => void; placeholder?: string; multiple?: boolean; disabled?: boolean; className?: string; queryKey: string; minChars?: number }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const results = useQuery({ queryKey: ['picker', queryKey, debounced], queryFn: () => search(debounced), enabled: open && debounced.length >= minChars, staleTime: 15_000, retry: false });
  const items = (results.data ?? []).filter((r) => !value.some((v) => v.id === r.id));

  function pick(item: PickerItem) {
    onChange(multiple ? [...value, item] : [item]);
    setQ('');
    setOpen(false);
  }
  const remove = (id: string) => onChange(value.filter((v) => v.id !== id));

  return (
    <div ref={ref} className={cn('relative', className)}>
      {(multiple || value.length === 0) && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-subtle" />
          <input
            disabled={disabled}
            className="input pl-8 h-8 py-0 text-[13px]"
            placeholder={placeholder}
            value={q}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, items.length - 1));
              if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
              if (e.key === 'Enter' && items[active]) {
                e.preventDefault();
                pick(items[active]);
              }
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          {results.isFetching && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-subtle" />}
        </div>
      )}
      {open && debounced.length >= minChars && (
        <div className="absolute z-30 mt-1 w-full card shadow-lg max-h-64 overflow-y-auto py-1">
          {results.isError && <div className="px-3 py-2 text-[12.5px] text-muted">Search unavailable.</div>}
          {!results.isError && !results.isFetching && items.length === 0 && <div className="px-3 py-2 text-[12.5px] text-muted">No matches.</div>}
          {items.map((it, i) => (
            <button key={it.id} type="button" onMouseEnter={() => setActive(i)} onClick={() => pick(it)} className={cn('w-full text-left px-3 py-1.5 flex items-center gap-2', i === active && 'bg-surface-2')}>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] truncate">{it.label}</div>
                {it.sublabel && <div className="text-[11.5px] text-muted truncate">{it.sublabel}</div>}
              </div>
              {it.badge}
            </button>
          ))}
        </div>
      )}
      {value.length > 0 && (
        <div className={cn('flex flex-wrap gap-1.5', multiple && 'mt-1.5')}>
          {value.map((v) => (
            <span key={v.id} className="inline-flex items-center gap-1 rounded-md bg-surface-2 border border-default px-2 py-0.5 text-[12.5px] max-w-full">
              <span className="truncate">{v.label}</span>
              {v.sublabel && <span className="text-subtle truncate hidden sm:inline">· {v.sublabel}</span>}
              {!disabled && (
                <button type="button" onClick={() => remove(v.id)} className="text-subtle hover:text-default" aria-label="Remove">
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
