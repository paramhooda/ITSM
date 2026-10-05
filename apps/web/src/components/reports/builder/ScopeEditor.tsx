import { Field, Select } from '@/components/ui';
import { Segmented } from '@/components/dashboards/Panel';
import { useCustomersLookup } from '@/hooks/useLookups';
import { DATE_PRESETS, type CatalogField } from '../types';

/** Customer scope (chosen at run time or fixed), the period field and the default period. */
export function ScopeEditor({ scopeCustomerId, dateField, dateFields, fields, defaultDateRange, presets, onChange }: { scopeCustomerId: string | null; dateField: string | null; dateFields: string[]; fields: CatalogField[]; defaultDateRange: string; presets: string[]; onChange: (patch: { scopeCustomerId?: string | null; dateField?: string | null; defaultDateRange?: string }) => void }) {
  const customers = useCustomersLookup();
  const fixed = scopeCustomerId !== null;
  const list = customers.data?.items ?? [];
  return (
    <div className="flex flex-col gap-3">
      <Field label="Customer">
        <div className="flex flex-col gap-2">
          <Segmented size="sm" value={fixed ? 'fixed' : 'any'} onChange={(v) => onChange({ scopeCustomerId: v === 'fixed' ? list[0]?.id ?? '' : null })} options={[{ value: 'any', label: 'Chosen at run time' }, { value: 'fixed', label: 'Fixed to one customer' }]} />
          {fixed && <Select value={scopeCustomerId ?? ''} onChange={(e) => onChange({ scopeCustomerId: e.target.value })} placeholder="Choose a customer" options={list.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} aria-label="Customer" />}
        </div>
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Field label="Period field" hint={dateField ? undefined : 'No period: every row, whatever the date'}>
          <Select value={dateField ?? ''} onChange={(e) => onChange({ dateField: e.target.value || null })} placeholder="None" options={dateFields.map((k) => ({ value: k, label: fields.find((f) => f.key === k)?.label ?? k }))} aria-label="Period field" />
        </Field>
        <Field label="Default period">
          <Select value={defaultDateRange} onChange={(e) => onChange({ defaultDateRange: e.target.value })} options={DATE_PRESETS.filter((p) => presets.includes(p.value))} aria-label="Default period" disabled={!dateField} />
        </Field>
      </div>
      {!fixed && !dateField && <div className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">Neither a period field nor a fixed customer: this report reads every row of the entity, so it can be slow and is capped by the row limit.</div>}
    </div>
  );
}
