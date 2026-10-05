import { useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button, Input, Select } from '@/components/ui';
import { Segmented } from '@/components/dashboards/Panel';
import { useLookups, useCustomersLookup, useEngineers } from '@/hooks/useLookups';
import { useSites } from '@/components/cmdb/hooks';
import { OPERATOR_LABELS, VALUELESS_OPERATORS, type CatalogField, type FieldType, type ReportFilter } from '../types';

const DATE_TYPES: FieldType[] = ['date', 'datetime'];
const NUMBER_TYPES: FieldType[] = ['number', 'minutes', 'pct'];
const PICK_TYPES: FieldType[] = ['option', 'enum', 'ref'];
let seq = 0;
/** A client-side id per row, so React keeps each row's controls (the value picker's search text, focus) with its row when another row is removed. */
const newId = () => `f${++seq}`;

/** Resolves the choices of an option, enum or ref field from the lookups the rest of the app already loads. */
function useChoices(field: CatalogField, scopeCustomerId: string | null): { choices: { value: string; label: string }[]; note?: string } {
  const { options, lookups } = useLookups();
  const customers = useCustomersLookup();
  const engineers = useEngineers();
  const o = field.options ?? {};
  const sites = useSites(o.lookup === 'site' ? scopeCustomerId : null);
  if (o.values) return { choices: o.values };
  if (o.optionType) return { choices: options(o.optionType).map((x) => ({ value: x.id, label: x.label })) };
  switch (o.lookup) {
    case 'customer':
      return { choices: (customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` })) };
    case 'site':
      return scopeCustomerId ? { choices: (sites.data ?? []).map((s) => ({ value: s.id, label: s.name })) } : { choices: [], note: 'Fix the report to one customer (Scope and period) to pick its sites' };
    case 'service':
      return { choices: (lookups?.services ?? []).map((s) => ({ value: s.id, label: s.name })) };
    case 'team':
      return { choices: (lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name })) };
    case 'user':
      return { choices: (engineers.data ?? []).map((u) => ({ value: u.id, label: u.name })) };
    case 'ciType':
      return { choices: (lookups?.ciTypes ?? []).map((t) => ({ value: t.id, label: t.name })) };
    default:
      return { choices: [] };
  }
}

function ValuePicker({ field, value, onChange, scopeCustomerId }: { field: CatalogField; value: string[]; onChange: (v: string[]) => void; scopeCustomerId: string | null }) {
  const { choices, note } = useChoices(field, scopeCustomerId);
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? choices.filter((c) => c.label.toLowerCase().includes(needle) || value.includes(c.value)) : choices;
  }, [choices, q, value]);
  if (note) return <div className="text-[12px] text-subtle py-1.5">{note}</div>;
  return (
    <div className="flex flex-col gap-1.5">
      {choices.length > 12 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${choices.length} options…`} className="h-8 text-[12.5px]" />}
      <div className="flex flex-wrap gap-1.5">
        {choices.length === 0 && <span className="text-[12px] text-subtle">No options</span>}
        {shown.map((c) => {
          const on = value.includes(c.value);
          return (
            <button key={c.value} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((v) => v !== c.value) : [...value, c.value])} className={`rounded-md border px-2 py-0.5 text-[12px] transition-colors ${on ? 'bg-brand-600 border-brand-600 text-white' : 'border-default text-muted hover:bg-surface-2'}`}>
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ValueControl({ field, flt, onValue, scopeCustomerId }: { field: CatalogField; flt: ReportFilter; onValue: (v: unknown) => void; scopeCustomerId: string | null }) {
  if (VALUELESS_OPERATORS.includes(flt.op)) return <div className="text-[12px] text-subtle py-2">No value needed</div>;
  const pair = Array.isArray(flt.value) ? (flt.value as unknown[]) : ['', ''];
  if (PICK_TYPES.includes(field.type)) return <ValuePicker field={field} value={Array.isArray(flt.value) ? (flt.value as string[]) : []} onChange={onValue} scopeCustomerId={scopeCustomerId} />;
  if (DATE_TYPES.includes(field.type)) {
    if (flt.op === 'last_n_days' || flt.op === 'next_n_days') return <Input type="number" min={1} max={3650} value={flt.value === undefined ? '' : String(flt.value)} onChange={(e) => onValue(e.target.value === '' ? undefined : Number(e.target.value))} placeholder="Days" aria-label="Days" />;
    if (flt.op === 'between')
      return (
        <div className="grid grid-cols-2 gap-1.5">
          <Input type="date" value={String(pair[0] ?? '')} onChange={(e) => onValue([e.target.value, pair[1] ?? ''])} aria-label="From" />
          <Input type="date" value={String(pair[1] ?? '')} onChange={(e) => onValue([pair[0] ?? '', e.target.value])} aria-label="To" />
        </div>
      );
    return <Input type="date" value={typeof flt.value === 'string' ? flt.value : ''} onChange={(e) => onValue(e.target.value || undefined)} aria-label="Date" />;
  }
  if (NUMBER_TYPES.includes(field.type)) {
    if (flt.op === 'between')
      return (
        <div className="grid grid-cols-2 gap-1.5">
          <Input type="number" value={pair[0] === undefined || pair[0] === '' ? '' : String(pair[0])} onChange={(e) => onValue([e.target.value === '' ? '' : Number(e.target.value), pair[1] ?? ''])} placeholder="From" aria-label="From" />
          <Input type="number" value={pair[1] === undefined || pair[1] === '' ? '' : String(pair[1])} onChange={(e) => onValue([pair[0] ?? '', e.target.value === '' ? '' : Number(e.target.value)])} placeholder="To" aria-label="To" />
        </div>
      );
    return <Input type="number" value={flt.value === undefined || flt.value === '' ? '' : String(flt.value)} onChange={(e) => onValue(e.target.value === '' ? undefined : Number(e.target.value))} placeholder="Value" aria-label="Value" />;
  }
  return <Input value={typeof flt.value === 'string' ? flt.value : ''} maxLength={200} onChange={(e) => onValue(e.target.value || undefined)} placeholder="Text" aria-label="Value" />;
}

/** Rows of field · operator · value; the operator list follows the field type and the value control follows the field. */
export function FilterEditor({ fields, filters, match, operators, operatorLabels, scopeCustomerId, onChange, onMatch }: { fields: CatalogField[]; filters: ReportFilter[]; match: 'all' | 'any'; operators: Record<FieldType, string[]>; operatorLabels?: Record<string, string>; scopeCustomerId: string | null; onChange: (f: ReportFilter[]) => void; onMatch: (m: 'all' | 'any') => void }) {
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const groups = useMemo(() => {
    const map = new Map<string, CatalogField[]>();
    for (const f of fields) map.set(f.group, [...(map.get(f.group) ?? []), f]);
    return [...map.entries()];
  }, [fields]);
  const labels = { ...OPERATOR_LABELS, ...(operatorLabels ?? {}) };
  const ids = useRef<string[]>([]);
  if (ids.current.length !== filters.length) ids.current = filters.map((_, i) => ids.current[i] ?? newId());
  const update = (i: number, next: ReportFilter) => onChange(filters.map((f, j) => (j === i ? next : f)));
  const removeAt = (i: number) => {
    ids.current = ids.current.filter((_, j) => j !== i);
    onChange(filters.filter((_, j) => j !== i));
  };
  const setField = (i: number, key: string) => {
    const f = byKey.get(key);
    if (!f) return;
    update(i, { field: key, op: operators[f.type]?.[0] ?? 'eq', value: undefined });
  };
  const setOp = (i: number, op: string) => {
    const cur = filters[i]!;
    const wasPair = cur.op === 'between';
    const isPair = op === 'between';
    update(i, { ...cur, op, value: wasPair !== isPair || VALUELESS_OPERATORS.includes(op) ? undefined : cur.value });
  };
  const add = () => {
    const f = fields[0];
    if (!f) return;
    ids.current = [...ids.current, newId()];
    onChange([...filters, { field: f.key, op: operators[f.type]?.[0] ?? 'eq', value: undefined }]);
  };
  return (
    <div className="flex flex-col gap-2.5">
      {filters.length > 1 && (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <span>Rows match</span>
          <Segmented size="sm" value={match} onChange={onMatch} options={[{ value: 'all', label: 'every filter' }, { value: 'any', label: 'any filter' }]} />
        </div>
      )}
      {filters.length === 0 && <div className="text-[12px] text-subtle">No filters: every row of the entity (within the period and the customer scope)</div>}
      {filters.map((flt, i) => {
        const f = byKey.get(flt.field);
        return (
          <div key={ids.current[i]} className="rounded-md border border-default p-2 flex flex-col gap-1.5" data-filter-row>
            <div className="grid grid-cols-[1fr_auto] gap-1.5">
              <Select value={flt.field} onChange={(e) => setField(i, e.target.value)} aria-label="Field">
                {groups.map(([g, list]) => (
                  <optgroup key={g} label={g}>
                    {list.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </optgroup>
                ))}
              </Select>
              <Button size="icon" variant="ghost" className="h-9 w-9 justify-self-end" aria-label="Remove filter" onClick={() => removeAt(i)}><X className="h-4 w-4" /></Button>
            </div>
            {f && (
              <>
                <Select value={flt.op} onChange={(e) => setOp(i, e.target.value)} aria-label="Operator" options={(operators[f.type] ?? []).map((op) => ({ value: op, label: labels[op] ?? op }))} />
                <ValueControl field={f} flt={flt} onValue={(v) => update(i, { ...flt, value: v })} scopeCustomerId={scopeCustomerId} />
              </>
            )}
          </div>
        );
      })}
      <div>
        <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={add} disabled={!fields.length || filters.length >= 30}>Add filter</Button>
      </div>
    </div>
  );
}
