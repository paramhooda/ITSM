import { Field, Input, Select, Textarea, Checkbox } from '@/components/ui';

export interface AttributeDef {
  key: string;
  label?: string;
  type?: string;
  required?: boolean;
  options?: (string | { value: string; label?: string })[];
  helpText?: string;
}

/** Renders the dynamic attribute fields defined on a CI type's attributeSchema. */
export function AttributeFields({ schema, value, onChange, columns = 2 }: { schema: AttributeDef[] | Record<string, unknown>[]; value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void; columns?: 1 | 2 }) {
  const defs = (schema as AttributeDef[]).filter((d) => d && typeof d.key === 'string');
  if (!defs.length) return <div className="text-[13px] text-subtle">This type has no additional attributes.</div>;
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <div className={columns === 2 ? 'grid grid-cols-1 sm:grid-cols-2 gap-3' : 'flex flex-col gap-3'}>
      {defs.map((d) => {
        const v = value[d.key];
        const label = d.label ?? d.key;
        const opts = (d.options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value }));
        switch (d.type) {
          case 'select':
            return (
              <Field key={d.key} label={label} required={d.required} hint={d.helpText}>
                <Select value={(v as string) ?? ''} onChange={(e) => set(d.key, e.target.value || null)} placeholder="—" options={opts} />
              </Field>
            );
          case 'multiselect':
            return (
              <Field key={d.key} label={label} required={d.required} hint={d.helpText}>
                <div className="flex flex-wrap gap-2 py-1">
                  {opts.map((o) => {
                    const arr = Array.isArray(v) ? (v as string[]) : [];
                    return <Checkbox key={o.value} label={o.label} checked={arr.includes(o.value)} onChange={(e) => set(d.key, e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))} />;
                  })}
                </div>
              </Field>
            );
          case 'boolean':
            return (
              <Field key={d.key} label={label} hint={d.helpText}>
                <Checkbox label={v ? 'Yes' : 'No'} checked={!!v} onChange={(e) => set(d.key, e.target.checked)} />
              </Field>
            );
          case 'number':
            return (
              <Field key={d.key} label={label} required={d.required} hint={d.helpText}>
                <Input type="number" value={v === null || v === undefined ? '' : String(v)} onChange={(e) => set(d.key, e.target.value === '' ? null : Number(e.target.value))} />
              </Field>
            );
          case 'date':
            return (
              <Field key={d.key} label={label} required={d.required} hint={d.helpText}>
                <Input type="date" value={(v as string) ?? ''} onChange={(e) => set(d.key, e.target.value || null)} />
              </Field>
            );
          case 'textarea':
            return (
              <Field key={d.key} label={label} required={d.required} hint={d.helpText} className="sm:col-span-2">
                <Textarea value={(v as string) ?? ''} onChange={(e) => set(d.key, e.target.value)} />
              </Field>
            );
          default:
            return (
              <Field key={d.key} label={label} required={d.required} hint={d.helpText}>
                <Input value={v === null || v === undefined ? '' : String(v)} onChange={(e) => set(d.key, e.target.value)} />
              </Field>
            );
        }
      })}
    </div>
  );
}

/** Read-only rendering of attributes according to the schema (for detail pages). */
export function attributeItems(schema: AttributeDef[] | Record<string, unknown>[], value: Record<string, unknown>) {
  const defs = (schema as AttributeDef[]).filter((d) => d && typeof d.key === 'string');
  const known = new Set(defs.map((d) => d.key));
  const items = defs.map((d) => {
    const v = value[d.key];
    const text = v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
    return { label: d.label ?? d.key, value: text };
  });
  for (const [k, v] of Object.entries(value)) {
    if (known.has(k) || v === null || v === undefined || typeof v === 'object') continue;
    items.push({ label: k, value: String(v) });
  }
  return items;
}
