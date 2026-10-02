import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { get } from '@/api/client';
import { cn } from '@/lib/utils';
import { CiTypeBadge } from './CiTypeBadge';

export interface CiMin { id: string; name: string; hostname?: string | null; ipAddress?: string | null; typeKey: string; typeName?: string; typeColor?: string | null; status: string; customerId: string }

/** Search-as-you-type picker for configuration items (optionally limited to a customer). */
export function CiPicker({ customerId, value, onChange, exclude = [], placeholder = 'Search CIs by name, hostname, IP or serial…', autoFocus }: { customerId?: string | null; value: CiMin | null; onChange: (ci: CiMin | null) => void; exclude?: string[]; placeholder?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data, isFetching } = useQuery({
    queryKey: ['cmdb', 'picker', customerId ?? 'all', q],
    queryFn: () => get<{ items: CiMin[] }>('/cmdb/cis', { fields: 'min', q: q || undefined, customerId: customerId ?? undefined, pageSize: 20, sort: 'name', order: 'asc' }),
    enabled: open,
    staleTime: 10_000,
  });
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const items = (data?.items ?? []).filter((i) => !exclude.includes(i.id));
  if (value) {
    return (
      <div className="input flex items-center gap-2">
        <CiTypeBadge typeKey={value.typeKey} name={value.typeName} color={value.typeColor} />
        <span className="truncate flex-1">{value.name}</span>
        {value.ipAddress && <span className="text-xs text-subtle font-mono">{value.ipAddress}</span>}
        <button type="button" onClick={() => onChange(null)} className="text-subtle hover:text-default" aria-label="Clear">
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
  return (
    <div ref={ref} className="relative">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-subtle" />
      <input autoFocus={autoFocus} className="input pl-8" placeholder={placeholder} value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
      {open && (
        <div className="absolute z-40 mt-1 w-full card shadow-lg max-h-64 overflow-y-auto py-1">
          {isFetching && items.length === 0 && <div className="px-3 py-2 text-xs text-muted">Searching…</div>}
          {!isFetching && items.length === 0 && <div className="px-3 py-2 text-xs text-muted">No matching CIs</div>}
          {items.map((i) => (
            <button key={i.id} type="button" onClick={() => { onChange(i); setOpen(false); setQ(''); }} className={cn('w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-2')}>
              <CiTypeBadge typeKey={i.typeKey} name={i.typeName} color={i.typeColor} />
              <span className="truncate flex-1">{i.name}</span>
              <span className="text-xs text-subtle font-mono">{i.hostname ?? i.ipAddress ?? ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
