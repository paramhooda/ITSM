import { useMemo, useState, type ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import { cn, COLOR_CLASSES, colorClass } from '@/lib/utils';
import { Input } from '@/components/ui';

export interface Option {
  value: string;
  label: string;
  hint?: string;
  color?: string | null;
}

/** Checkbox list with search; shows selected items as removable chips. */
export function MultiSelect({ value, onChange, options, placeholder = 'Search…', className, maxHeight = 'max-h-48', disabled, emptyText = 'No options' }: { value: string[]; onChange: (v: string[]) => void; options: Option[]; placeholder?: string; className?: string; maxHeight?: string; disabled?: boolean; emptyText?: string }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => (q.trim() ? options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q.toLowerCase())) : options), [options, q]);
  const selected = value.map((v) => options.find((o) => o.value === v) ?? { value: v, label: v });
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className={cn('rounded-lg border border-default bg-surface', disabled && 'opacity-60 pointer-events-none', className)}>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 p-2 border-b border-default">
          {selected.map((s) => (
            <span key={s.value} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[12px]">
              {s.label}
              <button type="button" onClick={() => toggle(s.value)} className="text-subtle hover:text-default" aria-label={`Remove ${s.label}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {options.length > 7 && (
        <div className="p-1.5 border-b border-default">
          <input className="input py-1 text-[12.5px]" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className={cn('overflow-y-auto p-1', maxHeight)}>
        {filtered.length === 0 && <div className="px-2 py-2 text-[12.5px] text-subtle">{emptyText}</div>}
        {filtered.map((o) => {
          const on = value.includes(o.value);
          return (
            <button type="button" key={o.value} onClick={() => toggle(o.value)} className={cn('w-full flex items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-surface-2', on && 'text-default')}>
              <span className={cn('h-4 w-4 rounded border border-default flex items-center justify-center shrink-0', on && 'bg-brand-600 border-brand-600 text-white')}>{on && <Check className="h-3 w-3" />}</span>
              <span className="truncate">{o.label}</span>
              {o.hint && <span className="ml-auto text-[11.5px] text-subtle truncate">{o.hint}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Colour name picker using the platform palette (lib/utils COLOR_CLASSES). */
export function ColorPicker({ value, onChange, allowNone = true }: { value: string | null | undefined; onChange: (v: string | null) => void; allowNone?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {allowNone && (
        <button type="button" title="No colour" onClick={() => onChange(null)} className={cn('h-6 px-2 rounded-md border border-dashed border-default text-[11px] text-muted', !value && 'ring-2 ring-brand-500')}>
          none
        </button>
      )}
      {Object.keys(COLOR_CLASSES).map((c) => (
        <button type="button" key={c} title={c} onClick={() => onChange(c)} className={cn('h-6 w-6 rounded-md flex items-center justify-center', colorClass(c), value === c && 'ring-2 ring-brand-500 ring-offset-1 ring-offset-surface')}>
          {value === c && <Check className="h-3.5 w-3.5" />}
        </button>
      ))}
    </div>
  );
}

export function ColorSwatch({ color, label }: { color?: string | null; label?: ReactNode }) {
  if (!color) return <span className="text-subtle text-[12px]">—</span>;
  return <span className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11.5px] font-medium', colorClass(color))}>{label ?? color}</span>;
}

/** Textarea bound to a string[] (one entry per line). */
export function LinesInput({ value, onChange, placeholder, rows = 3, className }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; rows?: number; className?: string }) {
  const [text, setText] = useState(value.join('\n'));
  return (
    <textarea
      className={cn('input resize-y', className)}
      rows={rows}
      placeholder={placeholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() =>
        onChange(
          text
            .split(/\r?\n|,/)
            .map((s) => s.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

/** Small inline checkbox group for a fixed set of flags. */
export function CheckboxGroup({ value, onChange, options, columns = 2 }: { value: string[]; onChange: (v: string[]) => void; options: Option[]; columns?: 1 | 2 | 3 }) {
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className={cn('grid gap-x-4 gap-y-1.5', { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3' }[columns])}>
      {options.map((o) => (
        <label key={o.value} className="inline-flex items-center gap-2 text-[13px] cursor-pointer select-none">
          <input type="checkbox" className="h-4 w-4 rounded border-default accent-brand-600" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
          <span>{o.label}</span>
          {o.hint && <span className="text-[11.5px] text-subtle">{o.hint}</span>}
        </label>
      ))}
    </div>
  );
}

export function KeyInput(props: React.ComponentProps<typeof Input>) {
  return <Input {...props} className={cn('font-mono text-[12.5px]', props.className)} spellCheck={false} autoCapitalize="off" />;
}

/** Common IANA timezones + whatever the browser supports. */
export function timezoneOptions(): Option[] {
  const common = ['UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney'];
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    all = [];
  }
  const set = new Set([...common, ...all]);
  return [...set].map((z) => ({ value: z, label: z }));
}
