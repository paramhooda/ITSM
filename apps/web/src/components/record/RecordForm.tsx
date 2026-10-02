import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface FieldDef {
  label: ReactNode;
  /** Read value. `null`/`undefined`/'' render as an em dash. */
  value?: ReactNode;
  /** Inline control rendered instead of the value (ServiceNow edits fields in place). */
  edit?: ReactNode;
  /** `prose` collapses long text to three lines with "Show more"; `mono` for identifiers. */
  kind?: 'text' | 'prose' | 'mono';
  /** Take the full width of the section. */
  span?: 1 | 2;
  hint?: string;
  hidden?: boolean;
}

export interface FormSection {
  key: string;
  title?: ReactNode;
  description?: ReactNode;
  fields: FieldDef[];
  columns?: 1 | 2;
  collapsible?: boolean;
  defaultOpen?: boolean;
  actions?: ReactNode;
  /** Free content rendered under the fields (tables, pickers). */
  children?: ReactNode;
  hidden?: boolean;
}

const isEmpty = (v: ReactNode) => v === null || v === undefined || v === '' || v === false;

/** Long text that starts folded, so descriptions stop dominating the record. */
export function ProseText({ text, lines = 3, className }: { text: string | null | undefined; lines?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className="text-subtle">—</span>;
  const long = text.length > 220 || text.split('\n').length > lines;
  return (
    <div className={cn('min-w-0', className)}>
      <div className={cn('text-[13.5px] whitespace-pre-wrap break-words', !open && long && 'line-clamp-3')}>{text}</div>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-0.5 text-[12px] font-medium text-brand-600 hover:underline">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** One label-left / value-right row. */
export function FieldRow({ field, className }: { field: FieldDef; className?: string }) {
  const content = field.edit ?? (field.kind === 'prose' ? <ProseText text={typeof field.value === 'string' ? field.value : null} /> : isEmpty(field.value) ? <span className="text-subtle">—</span> : field.value);
  return (
    <div className={cn('grid grid-cols-[132px_minmax(0,1fr)] items-start gap-x-3 py-[7px] border-b border-default/70 last:border-b-0', field.span === 2 && 'md:col-span-2', className)} title={field.hint}>
      <div className="text-[12.5px] text-muted leading-[22px] truncate">{field.label}</div>
      <div className={cn('text-[13.5px] text-default leading-[22px] min-w-0 break-words', field.kind === 'mono' && 'font-mono text-[12.5px]')}>{content}</div>
    </div>
  );
}

/** A section of the record form: a quiet title, then rows in one or two columns. */
export function FormSectionCard({ section }: { section: FormSection }) {
  const [open, setOpen] = useState(section.defaultOpen ?? true);
  const fields = section.fields.filter((f) => !f.hidden);
  if (section.hidden || (fields.length === 0 && !section.children)) return null;
  const cols = section.columns ?? 2;
  return (
    <section className="card">
      {(section.title || section.actions) && (
        <header className={cn('flex items-center justify-between gap-3 px-5 py-2.5', open && 'border-b border-default')}>
          <button type="button" onClick={() => section.collapsible && setOpen((o) => !o)} className={cn('flex items-center gap-2 min-w-0 text-left', section.collapsible ? 'cursor-pointer' : 'cursor-default')} aria-expanded={open}>
            <span className="text-[13px] font-semibold text-default truncate">{section.title}</span>
            {section.description && <span className="text-[12px] text-subtle truncate hidden sm:inline">· {section.description}</span>}
            {section.collapsible && <ChevronDown className={cn('h-3.5 w-3.5 text-subtle transition-transform', !open && '-rotate-90')} />}
          </button>
          {section.actions && <div className="flex items-center gap-1.5 shrink-0">{section.actions}</div>}
        </header>
      )}
      {open && (
        <div className="px-5 py-1.5">
          {fields.length > 0 && (
            <div className={cn('grid grid-cols-1 gap-x-8', cols === 2 && 'md:grid-cols-2')}>
              {fields.map((f, i) => (
                <FieldRow key={i} field={f} />
              ))}
            </div>
          )}
          {section.children && <div className={cn(fields.length > 0 && 'mt-3 mb-2')}>{section.children}</div>}
        </div>
      )}
    </section>
  );
}

/** The form part of a record page: sections stacked top to bottom. */
export function RecordForm({ sections, className }: { sections: FormSection[]; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {sections.map((s) => (
        <FormSectionCard key={s.key} section={s} />
      ))}
    </div>
  );
}
