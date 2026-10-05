import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { ticketsApi } from '@/components/tickets/api';
import { EntityPicker } from '@/components/tickets/EntityPicker';
import { cn } from '@/lib/utils';

export interface FixChangeRef {
  id: string;
  number: string;
  title: string;
}

/** Picks the change ticket that delivers the permanent fix: changes of the same customer, found by number or title. */
export function FixChangePicker({ customerId, value, onChange, disabled, className }: { customerId: string; value: FixChangeRef | null; onChange: (next: FixChangeRef | null) => void; disabled?: boolean; className?: string }) {
  if (value) {
    return (
      <div className={cn('flex items-center gap-2 min-w-0 text-[13px]', className)}>
        <Link to={`/tickets/${value.id}`} className="font-mono text-brand-700 hover:underline shrink-0">{value.number}</Link>
        <span className="truncate text-default">{value.title}</span>
        {!disabled && (
          <button type="button" onClick={() => onChange(null)} className="text-subtle hover:text-red-600 shrink-0" aria-label="Clear the fix change" title="Clear">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }
  return (
    <EntityPicker
      className={className}
      queryKey={`fix-change-${customerId}`}
      placeholder="Search changes by number or title…"
      value={[]}
      onChange={(items) => {
        const it = items[0];
        if (!it) return onChange(null);
        const [number, ...rest] = it.label.split(' · ');
        onChange({ id: it.id, number: number ?? it.label, title: rest.join(' · ') });
      }}
      minChars={2}
      disabled={disabled}
      search={async (q) => (await ticketsApi.lookup(q, customerId)).items.filter((t) => t.type === 'change').map((t) => ({ id: t.id, label: `${t.number} · ${t.title}`, sublabel: t.status?.label ?? null }))}
    />
  );
}
