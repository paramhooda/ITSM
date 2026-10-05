import { cn } from '@/lib/utils';
import type { CatalogEntity } from '../types';

/** The grid of entity tiles; a tile whose permission the person lacks is disabled and says which one it needs. */
export function EntityPicker({ entities, value, onChange }: { entities: CatalogEntity[]; value: string | null; onChange: (key: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Entity">
      {entities.map((e) => {
        const on = e.key === value;
        const needs = e.permissionsOk ? null : `Needs ${e.permissions.join(', ')}`;
        return (
          <button
            key={e.key}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={!e.permissionsOk}
            title={needs ?? e.description}
            onClick={() => onChange(e.key)}
            className={cn('rounded-lg border px-3 py-2 text-left transition-colors', on ? 'border-brand-500 bg-brand-600/10 ring-2 ring-brand-500/25' : 'border-default hover:bg-surface-2', needs && 'opacity-50 cursor-not-allowed hover:bg-transparent')}
          >
            <div className="text-[13px] font-medium text-default truncate">{e.label}</div>
            <div className="text-[11.5px] text-muted line-clamp-2">{needs ?? e.description}</div>
          </button>
        );
      })}
    </div>
  );
}
