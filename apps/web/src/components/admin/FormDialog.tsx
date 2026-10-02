import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button, Dialog, Drawer, Field, Input, Select, Textarea, Toggle } from '@/components/ui';
import { cn } from '@/lib/utils';
import { errorMessage } from './api';
import { MultiSelect, ColorPicker, LinesInput, KeyInput, type Option } from './inputs';
import { DurationInput } from './DurationInput';

export type FieldType = 'text' | 'key' | 'textarea' | 'number' | 'select' | 'multiselect' | 'boolean' | 'color' | 'json' | 'email' | 'password' | 'duration' | 'date' | 'datetime' | 'lines' | 'custom';

export type Values = Record<string, unknown>;

export interface FieldSpec<V extends Values = Values> {
  key: string;
  label?: ReactNode;
  type: FieldType;
  options?: Option[] | ((values: V) => Option[]);
  required?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  /** Grid columns the field spans (the form has 2 columns). */
  span?: 1 | 2;
  visible?: (values: V) => boolean;
  disabled?: boolean | ((values: V) => boolean);
  mono?: boolean;
  rows?: number;
  min?: number;
  max?: number;
  step?: number;
  /** Custom control. */
  render?: (p: { value: unknown; onChange: (v: unknown) => void; values: V; setValues: (patch: Partial<V>) => void; disabled: boolean }) => ReactNode;
  /** Group heading rendered above this field. */
  section?: ReactNode;
}

export function isEmptyValue(v: unknown) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function validate<V extends Values>(fields: FieldSpec<V>[], values: V) {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (f.visible && !f.visible(values)) continue;
    const v = values[f.key];
    if (f.required && f.type !== 'boolean' && isEmptyValue(v)) errors[f.key] = 'Required';
    if (f.type === 'json' && typeof v === 'string' && v.trim()) {
      try {
        JSON.parse(v);
      } catch {
        errors[f.key] = 'Invalid JSON';
      }
    }
    if (f.type === 'key' && typeof v === 'string' && v && !/^[a-z0-9_]+$/.test(v)) errors[f.key] = 'Lowercase letters, digits and underscores only';
    if (f.type === 'email' && typeof v === 'string' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errors[f.key] = 'Invalid email address';
  }
  return errors;
}

/** Renders a field spec against a values object. Reused by FormDialog and bespoke editors. */
export function FormFields<V extends Values>({ fields, values, setValues, errors = {}, columns = 2 }: { fields: FieldSpec<V>[]; values: V; setValues: (patch: Partial<V>) => void; errors?: Record<string, string>; columns?: 1 | 2 }) {
  return (
    <div className={cn('grid gap-x-4 gap-y-3', columns === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1')}>
      {fields.map((f) => {
        if (f.visible && !f.visible(values)) return null;
        const disabled = typeof f.disabled === 'function' ? f.disabled(values) : !!f.disabled;
        const value = values[f.key];
        const set = (v: unknown) => setValues({ [f.key]: v } as Partial<V>);
        const opts = typeof f.options === 'function' ? f.options(values) : f.options ?? [];
        const span = f.span ?? (['textarea', 'json', 'multiselect', 'lines', 'custom', 'color'].includes(f.type) ? 2 : 1);
        let control: ReactNode;
        switch (f.type) {
          case 'text':
          case 'email':
          case 'password':
            control = <Input type={f.type} value={(value as string) ?? ''} placeholder={f.placeholder} disabled={disabled} onChange={(e) => set(e.target.value)} className={cn(f.mono && 'font-mono text-[12.5px]')} />;
            break;
          case 'key':
            control = <KeyInput value={(value as string) ?? ''} placeholder={f.placeholder} disabled={disabled} onChange={(e) => set(e.target.value)} />;
            break;
          case 'number':
            control = <Input type="number" value={value === null || value === undefined ? '' : String(value)} placeholder={f.placeholder} disabled={disabled} min={f.min} max={f.max} step={f.step} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} />;
            break;
          case 'date':
            control = <Input type="date" value={(value as string) ?? ''} disabled={disabled} onChange={(e) => set(e.target.value || null)} />;
            break;
          case 'datetime':
            control = <Input type="datetime-local" value={(value as string) ?? ''} disabled={disabled} onChange={(e) => set(e.target.value || null)} />;
            break;
          case 'textarea':
          case 'json':
            control = <Textarea value={(value as string) ?? ''} placeholder={f.placeholder} disabled={disabled} rows={f.rows ?? (f.type === 'json' ? 6 : 3)} onChange={(e) => set(e.target.value)} className={cn((f.mono || f.type === 'json') && 'font-mono text-[12.5px]')} />;
            break;
          case 'select':
            control = <Select value={(value as string) ?? ''} disabled={disabled} placeholder={f.placeholder ?? (f.required ? 'Select…' : '— none —')} options={opts} onChange={(e) => set(e.target.value || null)} />;
            break;
          case 'multiselect':
            control = <MultiSelect value={(value as string[]) ?? []} options={opts} disabled={disabled} onChange={set} />;
            break;
          case 'boolean':
            control = (
              <div className="h-8.5 flex items-center">
                <Toggle checked={!!value} onChange={(v) => !disabled && set(v)} label={f.placeholder} />
              </div>
            );
            break;
          case 'color':
            control = <ColorPicker value={value as string | null} onChange={set} />;
            break;
          case 'duration':
            control = <DurationInput value={(value as number | null) ?? null} onChange={set} placeholder={f.placeholder} disabled={disabled} />;
            break;
          case 'lines':
            control = <LinesInput value={(value as string[]) ?? []} onChange={set} placeholder={f.placeholder} rows={f.rows} />;
            break;
          case 'custom':
            control = f.render?.({ value, onChange: set, values, setValues, disabled });
            break;
        }
        return (
          <div key={f.key} className={cn(span === 2 && 'sm:col-span-2')}>
            {f.section && <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mb-2 mt-1">{f.section}</div>}
            <Field label={f.label} hint={f.hint} error={errors[f.key]} required={f.required}>
              {control}
            </Field>
          </div>
        );
      })}
    </div>
  );
}

export interface FormDialogProps<V extends Values> {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  fields: FieldSpec<V>[];
  initial: V;
  onSubmit: (values: V) => Promise<unknown> | unknown;
  submitLabel?: string;
  variant?: 'dialog' | 'drawer';
  width?: string;
  columns?: 1 | 2;
  /** Extra content rendered below the fields (receives current values). */
  children?: ReactNode | ((values: V, setValues: (patch: Partial<V>) => void) => ReactNode);
  /** Extra buttons on the left of the footer. */
  extraActions?: ReactNode;
  /** Additional validation; return field errors. */
  validate?: (values: V) => Record<string, string> | undefined;
}

/**
 * Generic create/edit form rendered from a field spec in a Dialog or Drawer.
 * Handles local state, required-field validation, submission and error toasts.
 */
export function FormDialog<V extends Values>({ open, onClose, title, description, fields, initial, onSubmit, submitLabel = 'Save', variant = 'dialog', width, columns = 2, children, extraActions, validate: extraValidate }: FormDialogProps<V>) {
  const [values, setValuesState] = useState<V>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setValuesState(initial);
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const setValues = (patch: Partial<V>) => setValuesState((v) => ({ ...v, ...patch }));

  async function submit() {
    const errs = { ...validate(fields, values), ...(extraValidate?.(values) ?? {}) };
    setErrors(errs);
    if (Object.keys(errs).length) {
      toast.error('Please correct the highlighted fields');
      return;
    }
    setSaving(true);
    try {
      await onSubmit(values);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const body = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onClickCapture={(e) => {
        // UI-kit buttons (Tabs, Button) have no explicit type; stop them from implicitly submitting the form.
        const b = (e.target as HTMLElement).closest('button');
        if (b && b.form === e.currentTarget && !b.hasAttribute('type')) e.preventDefault();
      }}
      className="flex flex-col gap-4"
    >
      {/* First submit button in tree order = the default button for Enter-to-submit. */}
      <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      {description && <div className="text-[13px] text-muted -mt-1">{description}</div>}
      <FormFields fields={fields} values={values} setValues={setValues} errors={errors} columns={columns} />
      {typeof children === 'function' ? children(values, setValues) : children}
    </form>
  );
  const footer = (
    <>
      {extraActions && <div className="mr-auto flex items-center gap-2">{extraActions}</div>}
      <Button variant="ghost" type="button" onClick={onClose} disabled={saving}>
        Cancel
      </Button>
      <Button type="button" onClick={() => void submit()} loading={saving}>
        {submitLabel}
      </Button>
    </>
  );
  if (variant === 'drawer') {
    return (
      <Drawer open={open} onClose={onClose} title={title} width={width ?? 'max-w-xl'} footer={footer}>
        {body}
      </Drawer>
    );
  }
  return (
    <Dialog open={open} onClose={onClose} title={title} width={width ?? 'max-w-lg'} footer={footer}>
      {body}
    </Dialog>
  );
}

/** Small helper to keep "which row is being edited" state for a list page. */
export function useEditor<T>() {
  const [state, setState] = useState<{ open: boolean; row: T | null }>({ open: false, row: null });
  return {
    open: state.open,
    row: state.row,
    create: () => setState({ open: true, row: null }),
    edit: (row: T) => setState({ open: true, row }),
    close: () => setState((s) => ({ ...s, open: false })),
  };
}
