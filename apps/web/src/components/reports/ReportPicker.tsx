import { useMemo, useState } from 'react';
import { SearchInput } from '@/components/ui';
import { cn } from '@/lib/utils';
import { CATEGORY_LABELS, type ReportDefinition } from './types';

/** Definitions grouped by category with descriptions. */
export function ReportPicker({ definitions, value, onChange }: { definitions: ReportDefinition[]; value: string | null; onChange: (key: string) => void }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = definitions.filter((d) => !needle || d.name.toLowerCase().includes(needle) || d.description.toLowerCase().includes(needle) || d.key.includes(needle));
    const map = new Map<string, ReportDefinition[]>();
    for (const d of list) map.set(d.category, [...(map.get(d.category) ?? []), d]);
    return [...map.entries()];
  }, [definitions, q]);
  return (
    <div className="flex flex-col gap-2">
      <SearchInput value={q} onChange={setQ} placeholder="Find a report…" />
      <div className="flex flex-col gap-3 overflow-y-auto max-h-[70vh] pr-1">
        {groups.length === 0 && <div className="text-[13px] text-subtle py-4 text-center">No reports match</div>}
        {groups.map(([cat, defs]) => (
          <div key={cat}>
            <div className="text-[11px] uppercase tracking-wide text-subtle font-medium px-1 mb-1">{CATEGORY_LABELS[cat] ?? cat}</div>
            <ul className="flex flex-col gap-0.5">
              {defs.map((d) => (
                <li key={d.key}>
                  <button onClick={() => onChange(d.key)} className={cn('w-full text-left rounded-md px-2 py-1.5 transition-colors', value === d.key ? 'bg-brand-600/10 text-brand-800 dark:text-brand-200' : 'hover:bg-surface-2')}>
                    <div className="text-[13px] font-medium">{d.name}</div>
                    <div className="text-[11.5px] text-muted line-clamp-2">{d.description}</div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
