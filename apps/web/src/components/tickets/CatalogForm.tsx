import { Field, Input, Textarea, Select, Checkbox } from '@/components/ui';
import type { CatalogField } from './types';

const optionsOf = (f: CatalogField) => (f.options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));

/** Renders a catalog item's `formSchema` as controlled inputs into `value`. */
export function CatalogForm({ schema, value, onChange, disabled }: { schema: CatalogField[]; value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void; disabled?: boolean }) {
  if (!schema?.length) return null;
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {schema.map((f) => {
        const v = value[f.key];
        const wide = f.type === 'textarea';
        const common = { disabled, required: f.required };
        let input: React.ReactNode;
        switch (f.type) {
          case 'textarea':
            input = <Textarea value={(v as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} {...common} />;
            break;
          case 'number':
            input = <Input type="number" value={v === undefined || v === null ? '' : String(v)} onChange={(e) => set(f.key, e.target.value === '' ? null : Number(e.target.value))} placeholder={f.placeholder} {...common} />;
            break;
          case 'select':
            input = <Select value={(v as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} options={optionsOf(f)} placeholder="Select…" {...common} />;
            break;
          case 'date':
            input = <Input type="date" value={(v as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} {...common} />;
            break;
          case 'boolean':
            input = <Checkbox checked={!!v} onChange={(e) => set(f.key, e.target.checked)} label={f.helpText ?? 'Yes'} disabled={disabled} />;
            break;
          case 'email':
            input = <Input type="email" value={(v as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} {...common} />;
            break;
          default:
            input = <Input value={(v as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} {...common} />;
        }
        return (
          <Field key={f.key} label={f.label} required={f.required} hint={f.type === 'boolean' ? undefined : f.helpText} className={wide ? 'sm:col-span-2' : undefined}>
            {input}
          </Field>
        );
      })}
    </div>
  );
}

/** Read-only rendering of submitted form data next to its schema. */
export function CatalogFormValues({ schema, value }: { schema: CatalogField[]; value: Record<string, unknown> }) {
  const entries = schema?.length ? schema.map((f) => ({ label: f.label, value: value[f.key] })) : Object.entries(value).map(([k, v]) => ({ label: k, value: v }));
  if (!entries.length) return null;
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
      {entries.map((e) => (
        <div key={e.label}>
          <dt className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">{e.label}</dt>
          <dd className="text-[13px] break-words">{e.value === true ? 'Yes' : e.value === false ? 'No' : e.value === null || e.value === undefined || e.value === '' ? '—' : String(e.value)}</dd>
        </div>
      ))}
    </dl>
  );
}
