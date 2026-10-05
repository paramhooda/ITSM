import { useRef } from 'react';
import { Plus, X } from 'lucide-react';
import { Button, Field, Input, Select, Toggle } from '@/components/ui';
import { AGGREGATE_LABELS, aggregateAlias, type AggregateFn, type CatalogField, type ReportAggregate } from '../types';

const FNS: AggregateFn[] = ['count', 'sum', 'avg', 'min', 'max'];
let seq = 0;
/** A client-side id per aggregate row, so removing one keeps the others' controls in place. */
const newId = () => `a${++seq}`;

/** Grouping on or off; when on, one or two group fields and the aggregates computed per group. */
export function GroupEditor({ fields, groupBy, aggregates, onChange }: { fields: CatalogField[]; groupBy: string[]; aggregates: ReportAggregate[]; onChange: (patch: { groupBy: string[]; aggregates: ReportAggregate[] }) => void }) {
  const groupable = fields.filter((f) => f.groupable).map((f) => ({ value: f.key, label: f.label }));
  const aggregatable = fields.filter((f) => f.aggregatable).map((f) => ({ value: f.key, label: f.label }));
  const grouped = groupBy.length > 0;
  const toggle = (on: boolean) => {
    if (on) onChange({ groupBy: [groupable[0]?.value ?? ''].filter(Boolean), aggregates: [{ fn: 'count', label: 'Count' }] });
    else onChange({ groupBy: [], aggregates: [] });
  };
  const setGroup = (i: number, key: string) => {
    const next = [...groupBy];
    if (!key) next.splice(i, 1);
    else next[i] = key;
    onChange({ groupBy: next.filter((k, j) => k && next.indexOf(k) === j), aggregates });
  };
  const ids = useRef<string[]>([]);
  if (ids.current.length !== aggregates.length) ids.current = aggregates.map((_, i) => ids.current[i] ?? newId());
  const removeAgg = (i: number) => {
    ids.current = ids.current.filter((_, j) => j !== i);
    onChange({ groupBy, aggregates: aggregates.filter((_, j) => j !== i) });
  };
  const addAgg = () => {
    ids.current = [...ids.current, newId()];
    onChange({ groupBy, aggregates: [...aggregates, { fn: aggregatable.length ? 'sum' : 'count', field: aggregatable[0]?.value }] });
  };
  const setAgg = (i: number, patch: Partial<ReportAggregate>) => onChange({ groupBy, aggregates: aggregates.map((a, j) => (j === i ? { ...a, ...patch, ...(patch.fn === 'count' ? { field: undefined } : {}) } : a)) });
  const aliases = aggregates.map(aggregateAlias);
  return (
    <div className="flex flex-col gap-3">
      <Toggle checked={grouped} onChange={toggle} label="Group rows and compute totals" />
      {!groupable.length && <div className="text-[12px] text-subtle">This entity has no groupable field.</div>}
      {grouped && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Field label="Group by">
              <Select value={groupBy[0] ?? ''} onChange={(e) => setGroup(0, e.target.value)} options={groupable} aria-label="First group field" />
            </Field>
            <Field label="Then by">
              <Select value={groupBy[1] ?? ''} onChange={(e) => setGroup(1, e.target.value)} placeholder="None" options={groupable.filter((o) => o.value !== groupBy[0])} aria-label="Second group field" />
            </Field>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="text-[12.5px] font-medium text-secondary">Aggregates</div>
            {aggregates.map((a, i) => {
              const dup = aliases.indexOf(aggregateAlias(a)) !== i;
              return (
                <div key={ids.current[i]} className="rounded-md border border-default p-2 flex flex-col gap-1.5" data-aggregate-row>
                  <div className="grid grid-cols-[1fr_auto] gap-1.5">
                    <div className={`grid gap-1.5 ${a.fn === 'count' ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
                      <Select value={a.fn} onChange={(e) => setAgg(i, { fn: e.target.value as AggregateFn })} aria-label="Function" options={FNS.map((fn) => ({ value: fn, label: AGGREGATE_LABELS[fn] }))} />
                      {a.fn !== 'count' && <Select value={a.field ?? ''} onChange={(e) => setAgg(i, { field: e.target.value || undefined })} placeholder="Choose a field" options={aggregatable} aria-label="Aggregate field" />}
                    </div>
                    <Button size="icon" variant="ghost" className="h-9 w-9" aria-label="Remove aggregate" disabled={aggregates.length === 1} onClick={() => removeAgg(i)}><X className="h-4 w-4" /></Button>
                  </div>
                  <Input value={a.label ?? ''} maxLength={60} onChange={(e) => setAgg(i, { label: e.target.value || undefined })} placeholder={a.fn === 'count' ? 'Count' : `${AGGREGATE_LABELS[a.fn]} ${aggregatable.find((o) => o.value === a.field)?.label.toLowerCase() ?? '…'}`} aria-label="Label" />
                  {dup && <div className="text-[11.5px] text-red-600">This aggregate is listed twice</div>}
                </div>
              );
            })}
            <div>
              <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} disabled={aggregates.length >= 6} onClick={addAgg}>Add aggregate</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
