import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Lock, X } from 'lucide-react';
import { Button, Checkbox, SearchInput } from '@/components/ui';
import type { CatalogField } from '../types';

/** The checklist of the entity's fields grouped by their catalogue group, and the ordered list of the chosen columns. */
export function ColumnPicker({ fields, value, onChange }: { fields: CatalogField[]; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const map = new Map<string, CatalogField[]>();
    for (const f of fields) {
      if (needle && !f.label.toLowerCase().includes(needle) && !f.key.includes(needle)) continue;
      map.set(f.group, [...(map.get(f.group) ?? []), f]);
    }
    return [...map.entries()];
  }, [fields, q]);
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const toggle = (k: string) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      <SearchInput value={q} onChange={setQ} placeholder="Find a field…" />
      <div className="max-h-64 overflow-y-auto rounded-md border border-default p-2 flex flex-col gap-2.5">
        {groups.length === 0 && <div className="text-[12px] text-subtle text-center py-3">No fields match</div>}
        {groups.map(([g, list]) => (
          <div key={g}>
            <div className="text-[11px] uppercase tracking-wide text-subtle font-medium mb-1">{g}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
              {list.map((f) => (
                <Checkbox key={f.key} checked={value.includes(f.key)} onChange={() => toggle(f.key)} label={<span className="inline-flex items-center gap-1 min-w-0"><span className="truncate">{f.label}</span>{!f.portal && <Lock className="h-3 w-3 text-subtle shrink-0" aria-label="Internal field, not shown in the portal" />}</span>} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div>
        <div className="text-[12px] font-medium text-secondary mb-1">Selected · {value.length}</div>
        {value.length === 0 ? (
          <div className="text-[12px] text-subtle">Pick at least one column</div>
        ) : (
          <ol className="flex flex-col gap-1">
            {value.map((k, i) => (
              <li key={k} className="flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1 text-[12.5px]">
                <span className="text-subtle tnum w-5 shrink-0">{i + 1}.</span>
                <span className="flex-1 truncate">{byKey.get(k)?.label ?? k}</span>
                <Button size="icon" variant="ghost" className="h-6 w-6" aria-label={`Move ${byKey.get(k)?.label ?? k} up`} disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp className="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="ghost" className="h-6 w-6" aria-label={`Move ${byKey.get(k)?.label ?? k} down`} disabled={i === value.length - 1} onClick={() => move(i, 1)}><ChevronDown className="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="ghost" className="h-6 w-6" aria-label={`Remove ${byKey.get(k)?.label ?? k}`} onClick={() => toggle(k)}><X className="h-3.5 w-3.5" /></Button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
