import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { Badge, SearchInput } from '@/components/ui';
import { cn } from '@/lib/utils';
import { REPORT_VISIBILITY_COLORS } from '@/lib/statusColors';
import { CATEGORY_LABELS, VISIBILITY_LABELS, visibilityOf, type ReportDefinition } from './types';

/** Definitions grouped by category with descriptions; custom reports sit last, with a pencil when the person may edit them. */
export function ReportPicker({ definitions, value, onChange }: { definitions: ReportDefinition[]; value: string | null; onChange: (key: string) => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = definitions.filter((d) => !needle || d.name.toLowerCase().includes(needle) || d.description.toLowerCase().includes(needle) || d.key.includes(needle));
    const map = new Map<string, ReportDefinition[]>();
    for (const d of list) map.set(d.category, [...(map.get(d.category) ?? []), d]);
    return [...map.entries()].sort((a, b) => Number(a[0] === 'custom') - Number(b[0] === 'custom'));
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
                <li key={d.key} className="relative">
                  <button onClick={() => onChange(d.key)} className={cn('w-full text-left rounded-md px-2 py-1.5 transition-colors', value === d.key ? 'bg-brand-600/10 text-brand-800' : 'hover:bg-surface-2', d.custom?.canEdit && 'pr-9')}>
                    <div className="text-[13px] font-medium flex items-center gap-1.5 min-w-0">
                      <span className="truncate">{d.name}</span>
                      {d.custom && d.custom.visibility !== null && <Badge color={REPORT_VISIBILITY_COLORS[visibilityOf({ visibility: d.custom.visibility, portalVisible: d.custom.portalVisible })]}>{VISIBILITY_LABELS[visibilityOf({ visibility: d.custom.visibility, portalVisible: d.custom.portalVisible })]}</Badge>}
                    </div>
                    <div className="text-[11.5px] text-muted line-clamp-2">{d.description}</div>
                  </button>
                  {d.custom?.canEdit && (
                    <button type="button" aria-label={`Edit ${d.name} in the builder`} title="Edit in the builder" onClick={() => navigate(`/reports/builder/${d.custom!.id}`)} className="absolute right-1.5 top-1.5 h-6 w-6 inline-flex items-center justify-center rounded-md text-subtle hover:text-default hover:bg-surface-2">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
