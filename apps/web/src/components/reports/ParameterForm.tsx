import { Field, Select, Input, Checkbox } from '@/components/ui';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { DATE_PRESETS, type ReportDefinition, type ReportParameter } from './types';

export type ParamValues = Record<string, unknown>;

function useChoices(p: ReportParameter) {
  const { options, lookups } = useLookups();
  if (p.options) return p.options;
  if (!p.optionType) return [];
  if (p.optionType === 'ci_type') return (lookups?.ciTypes ?? []).map((t) => ({ value: t.id, label: t.name }));
  if (p.optionType === 'service') return (lookups?.services ?? []).map((s) => ({ value: s.id, label: s.name }));
  if (p.optionType === 'team') return (lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }));
  return options(p.optionType).map((o) => ({ value: o.id, label: o.label }));
}

function MultiSelect({ p, value, onChange }: { p: ReportParameter; value: string[]; onChange: (v: string[]) => void }) {
  const choices = useChoices(p);
  return (
    <div className="flex flex-wrap gap-1.5">
      {choices.length === 0 && <span className="text-[12px] text-subtle">No options</span>}
      {choices.map((c) => {
        const on = value.includes(c.value);
        return (
          <button key={c.value} type="button" onClick={() => onChange(on ? value.filter((v) => v !== c.value) : [...value, c.value])} className={`rounded-md border px-2 py-0.5 text-[12px] ${on ? 'bg-brand-600 border-brand-600 text-white' : 'border-default text-muted hover:bg-surface-2'}`}>
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function SingleSelect({ p, value, onChange }: { p: ReportParameter; value: string; onChange: (v: string) => void }) {
  const choices = useChoices(p);
  return <Select value={value} onChange={(e) => onChange(e.target.value)} placeholder="Any" options={choices} />;
}

/**
 * Renders a definition's parameters. `hide` removes the customer/date range
 * controls (portal users, schedule filters) while keeping report-specific ones.
 */
export function ParameterForm({ definition, value, onChange, hide = [] }: { definition: ReportDefinition; value: ParamValues; onChange: (v: ParamValues) => void; hide?: ('customer' | 'daterange')[] }) {
  const customers = useCustomersLookup();
  const setKey = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  const params = definition.parameters.filter((p) => !(p.type === 'customer' && hide.includes('customer')) && !(p.type === 'daterange' && hide.includes('daterange')));
  const preset = String(value.dateRange ?? definition.defaultDateRange ?? 'last_30_days');
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {params.map((p) => {
        if (p.type === 'customer') {
          return (
            <Field key={p.key} label={p.label} hint="Leave empty for all customers you can see">
              <Select value={String(value.customerId ?? '')} onChange={(e) => setKey('customerId', e.target.value || undefined)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} />
            </Field>
          );
        }
        if (p.type === 'daterange') {
          return (
            <div key={p.key} className="contents">
              <Field label={p.label} required>
                <Select value={preset} onChange={(e) => setKey('dateRange', e.target.value)} options={DATE_PRESETS} />
              </Field>
              {preset === 'custom' && (
                <>
                  <Field label="From"><Input type="date" value={String(value.from ?? '')} onChange={(e) => setKey('from', e.target.value)} /></Field>
                  <Field label="To"><Input type="date" value={String(value.to ?? '')} onChange={(e) => setKey('to', e.target.value)} /></Field>
                </>
              )}
            </div>
          );
        }
        if (p.type === 'boolean') {
          return (
            <Field key={p.key} label={p.label} hint={p.help}>
              <Checkbox checked={value[p.key] === undefined ? p.default === true : value[p.key] === true || value[p.key] === 'true'} onChange={(e) => setKey(p.key, e.target.checked)} label={p.label} />
            </Field>
          );
        }
        if (p.type === 'number') return <Field key={p.key} label={p.label} hint={p.help} required={p.required}><Input type="number" value={String(value[p.key] ?? p.default ?? '')} onChange={(e) => setKey(p.key, e.target.value === '' ? undefined : Number(e.target.value))} /></Field>;
        if (p.type === 'select') return <Field key={p.key} label={p.label} hint={p.help} required={p.required}><SingleSelect p={p} value={String(value[p.key] ?? p.default ?? '')} onChange={(v) => setKey(p.key, v || undefined)} /></Field>;
        if (p.type === 'multiselect') return <Field key={p.key} label={p.label} hint={p.help} className="sm:col-span-2 lg:col-span-3"><MultiSelect p={p} value={Array.isArray(value[p.key]) ? (value[p.key] as string[]) : []} onChange={(v) => setKey(p.key, v.length ? v : undefined)} /></Field>;
        return <Field key={p.key} label={p.label} hint={p.help} required={p.required}><Input value={String(value[p.key] ?? '')} onChange={(e) => setKey(p.key, e.target.value || undefined)} /></Field>;
      })}
    </div>
  );
}
