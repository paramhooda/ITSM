import { useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, GripVertical } from 'lucide-react';
import { Button, Input, Select, Field, Checkbox } from '@/components/ui';
import { cn } from '@/lib/utils';
import { camelKey } from './api';

export interface FormFieldDef {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
  helpText?: string;
  placeholder?: string;
}

export const REQUEST_FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Choice (select)' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'email', label: 'Email' },
];

export const ATTRIBUTE_FIELD_TYPES = REQUEST_FIELD_TYPES.filter((t) => ['text', 'number', 'select', 'date', 'boolean'].includes(t.value));

/**
 * Builder for JSON form definitions ([{ key, label, type, required, options, helpText }]).
 * Used by the request catalog (with live preview) and CI type attribute schemas.
 */
export function FormSchemaBuilder({ value, onChange, types = REQUEST_FIELD_TYPES, preview = true, keyStyle = 'camel' }: { value: FormFieldDef[]; onChange: (v: FormFieldDef[]) => void; types?: { value: string; label: string }[]; preview?: boolean; keyStyle?: 'camel' | 'snake' }) {
  const [selected, setSelected] = useState<number | null>(null);
  const toKey = (label: string) => (keyStyle === 'camel' ? camelKey(label) : camelKey(label).replace(/([A-Z])/g, '_$1').toLowerCase());
  const update = (i: number, patch: Partial<FormFieldDef>) => onChange(value.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    setSelected(j);
  };
  const add = () => {
    onChange([...value, { key: '', label: '', type: 'text', required: false }]);
    setSelected(value.length);
  };
  const keys = value.map((f) => f.key.toLowerCase());
  const duplicate = (i: number) => value[i].key && keys.filter((k) => k === value[i].key.toLowerCase()).length > 1;

  return (
    <div className={cn('grid gap-4', preview ? 'grid-cols-1 lg:grid-cols-5' : 'grid-cols-1')}>
      <div className={cn(preview && 'lg:col-span-3')}>
        <div className="rounded-lg border border-default divide-y divide-[var(--border)]">
          {value.length === 0 && <div className="px-3 py-4 text-[12.5px] text-subtle text-center">No fields yet. Add the questions the requester must answer.</div>}
          {value.map((f, i) => {
            const open = selected === i;
            const badKey = f.key && !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f.key);
            return (
              <div key={i} className={cn(open && 'bg-surface-2/40')}>
                <div className="flex items-center gap-2 px-2 py-1.5 cursor-pointer" onClick={() => setSelected(open ? null : i)}>
                  <GripVertical className="h-4 w-4 text-subtle shrink-0" />
                  <div className="flex-1 min-w-0 text-[13px]">
                    <span className={cn('font-medium', !f.label && 'text-subtle italic')}>{f.label || 'Untitled field'}</span>
                    <span className="ml-2 text-[11.5px] text-subtle">{types.find((t) => t.value === f.type)?.label ?? f.type}</span>
                    {f.required && <span className="ml-1 text-red-500">*</span>}
                    {(duplicate(i) || badKey) && <span className="ml-2 text-[11.5px] text-red-600">{badKey ? 'invalid key' : 'duplicate key'}</span>}
                  </div>
                  <span className="font-mono text-[11px] text-subtle hidden sm:inline">{f.key}</span>
                  <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="h-6 w-6 inline-flex items-center justify-center rounded text-subtle hover:text-default disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" className="h-6 w-6 inline-flex items-center justify-center rounded text-subtle hover:text-default disabled:opacity-30" disabled={i === value.length - 1} onClick={() => move(i, 1)} title="Move down">
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="h-6 w-6 inline-flex items-center justify-center rounded text-subtle hover:text-red-600"
                      title="Remove"
                      onClick={() => {
                        onChange(value.filter((_, j) => j !== i));
                        setSelected(null);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {open && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 px-3 pb-3 pt-1">
                    <Field label="Label" required>
                      <Input
                        value={f.label}
                        autoFocus
                        onChange={(e) => {
                          const label = e.target.value;
                          const autoKey = !f.key || f.key === toKey(f.label);
                          update(i, { label, ...(autoKey ? { key: toKey(label) } : {}) });
                        }}
                      />
                    </Field>
                    <Field label="Key" required hint="Stored as the field name in the request data">
                      <Input value={f.key} className="font-mono text-[12.5px]" spellCheck={false} onChange={(e) => update(i, { key: e.target.value.replace(/\s+/g, '') })} />
                    </Field>
                    <Field label="Type">
                      <Select value={f.type} options={types} onChange={(e) => update(i, { type: e.target.value, ...(e.target.value === 'select' && !f.options?.length ? { options: [''] } : {}) })} />
                    </Field>
                    <div className="flex items-end pb-1.5">
                      <Checkbox label="Required" checked={!!f.required} onChange={(e) => update(i, { required: e.target.checked })} />
                    </div>
                    {f.type === 'select' && (
                      <Field label="Options" hint="One option per line" className="sm:col-span-2">
                        <textarea className="input font-mono text-[12.5px]" rows={3} value={(f.options ?? []).join('\n')} onChange={(e) => update(i, { options: e.target.value.split('\n') })} onBlur={() => update(i, { options: (f.options ?? []).map((o) => o.trim()).filter(Boolean) })} />
                      </Field>
                    )}
                    <Field label="Help text" className="sm:col-span-2">
                      <Input value={f.helpText ?? ''} onChange={(e) => update(i, { helpText: e.target.value })} placeholder="Shown under the field" />
                    </Field>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <Button type="button" variant="outline" size="sm" className="mt-2" icon={<Plus className="h-3.5 w-3.5" />} onClick={add}>
          Add field
        </Button>
      </div>
      {preview && (
        <div className="lg:col-span-2">
          <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mb-2">Preview</div>
          <div className="rounded-lg border border-dashed border-default p-3">
            <FormPreview fields={value} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Read-only rendering of a form definition as the requester would see it. */
export function FormPreview({ fields }: { fields: FormFieldDef[] }) {
  if (!fields.length) return <div className="text-[12.5px] text-subtle">The form is empty.</div>;
  return (
    <div className="flex flex-col gap-3">
      {fields.map((f, i) => (
        <Field key={i} label={f.label || 'Untitled'} required={f.required} hint={f.helpText}>
          {f.type === 'textarea' ? (
            <textarea className="input" rows={2} readOnly placeholder={f.placeholder} />
          ) : f.type === 'select' ? (
            <Select placeholder="Select…" options={(f.options ?? []).filter(Boolean).map((o) => ({ value: o, label: o }))} disabled />
          ) : f.type === 'boolean' ? (
            <Checkbox label="Yes" readOnly />
          ) : (
            <Input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text'} readOnly placeholder={f.placeholder} />
          )}
        </Field>
      ))}
    </div>
  );
}
