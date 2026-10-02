import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode, useEffect, useId, useRef, useState, type HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, Search, ChevronLeft, ChevronRight, Inbox, AlertTriangle, Check } from 'lucide-react';
import { cn, colorClass } from '@/lib/utils';

// ------------------------------------------------------------------ Button
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variantClasses: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
  secondary: 'bg-surface-2 text-default hover:brightness-95 dark:hover:brightness-125 border border-default',
  outline: 'bg-transparent border border-default text-default hover:bg-surface-2',
  ghost: 'bg-transparent text-muted hover:bg-surface-2 hover:text-default',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
};
const sizeClasses: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8.5 px-3 text-[13px] gap-2',
  lg: 'h-10 px-4 text-sm gap-2',
  icon: 'h-8 w-8 p-0 justify-center',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant = 'primary', size = 'md', loading, icon, children, disabled, ...props }, ref) => (
  <button
    ref={ref}
    disabled={disabled || loading}
    className={cn('inline-flex items-center rounded-lg font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:opacity-50 disabled:cursor-not-allowed', variantClasses[variant], sizeClasses[size], className)}
    {...props}
  >
    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
    {children}
  </button>
));
Button.displayName = 'Button';

// ------------------------------------------------------------------ Inputs
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => <input ref={ref} className={cn('input', className)} {...props} />);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => <textarea ref={ref} className={cn('input min-h-[80px] resize-y', className)} {...props} />);
Textarea.displayName = 'Textarea';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;
}
export const Select = forwardRef<HTMLSelectElement, SelectProps>(({ className, options, placeholder, children, ...props }, ref) => (
  <select ref={ref} className={cn('input', className)} {...props}>
    {placeholder !== undefined && <option value="">{placeholder}</option>}
    {options?.map((o) => (
      <option key={o.value} value={o.value} disabled={o.disabled}>
        {o.label}
      </option>
    ))}
    {children}
  </select>
));
Select.displayName = 'Select';

export function Checkbox({ label, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={props.id ?? id} className={cn('inline-flex items-center gap-2 text-[13px] cursor-pointer select-none', className)}>
      <input id={props.id ?? id} type="checkbox" className="h-4 w-4 rounded border-default accent-brand-600" {...props} />
      {label}
    </label>
  );
}

export function Field({ label, hint, error, required, children, className }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && (
        <label className="text-[12.5px] font-medium text-muted">
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <div className="text-xs text-subtle">{hint}</div>}
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Badge
export function Badge({ color, className, children, dot, ...props }: HTMLAttributes<HTMLSpanElement> & { color?: string | null; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap', colorClass(color), className)} {...props}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

// ------------------------------------------------------------------ Card
export function Card({ className, children, title, actions, padded = true, ...props }: HTMLAttributes<HTMLDivElement> & { title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <div className={cn('card', className)} {...props}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-default">
          <div className="font-semibold text-[13px]">{title}</div>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      )}
      <div className={cn(padded && 'p-4')}>{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------ Page header
export function PageHeader({ title, subtitle, actions, breadcrumb }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
      <div className="min-w-0">
        {breadcrumb && <div className="text-xs text-subtle mb-1">{breadcrumb}</div>}
        <h1 className="text-lg font-semibold leading-tight truncate">{title}</h1>
        {subtitle && <div className="text-[13px] text-muted mt-0.5">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Empty / loading / error states
export function EmptyState({ title = 'Nothing here yet', description, action, icon }: { title?: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-4">
      <div className="h-10 w-10 rounded-full bg-surface-2 flex items-center justify-center text-subtle mb-3">{icon ?? <Inbox className="h-5 w-5" />}</div>
      <div className="font-medium">{title}</div>
      {description && <div className="text-[13px] text-muted mt-1 max-w-sm">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-subtle', className)} />;
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-muted text-[13px]">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorBlock({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = (error as { message?: string })?.message ?? 'Something went wrong';
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-4">
      <AlertTriangle className="h-6 w-6 text-amber-500 mb-2" />
      <div className="font-medium">Could not load data</div>
      <div className="text-[13px] text-muted mt-1">{message}</div>
      {retry && (
        <Button variant="outline" size="sm" className="mt-3" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Dialog / Drawer
export function Dialog({ open, onClose, title, children, footer, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:pt-[8vh]">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className={cn('relative card w-full shadow-xl fade-in max-h-[88vh] flex flex-col', width)} role="dialog" aria-modal>
        {title && (
          <div className="flex items-center justify-between px-5 py-3 border-b border-default">
            <div className="font-semibold">{title}</div>
            <button onClick={onClose} className="text-muted hover:text-default" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-default bg-surface-2/60 rounded-b-[10px]">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, children, width = 'max-w-xl', footer }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; width?: string; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className={cn('relative bg-surface border-l border-default w-full h-full shadow-2xl flex flex-col fade-in', width)}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-default">
          <div className="font-semibold">{title}</div>
          <button onClick={onClose} className="text-muted hover:text-default" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-default">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title = 'Are you sure?', description, confirmLabel = 'Confirm', danger, loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title?: ReactNode; description?: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13.5px] text-muted">{description}</div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Tabs
export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { key: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cn('flex items-center gap-1 border-b border-default overflow-x-auto', className)}>
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cn('px-3 py-2 text-[13px] font-medium border-b-2 -mb-px whitespace-nowrap transition-colors', value === t.key ? 'border-brand-600 text-default' : 'border-transparent text-muted hover:text-default')}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 text-[11px] text-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Table
export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  className?: string;
  width?: string;
  sortable?: boolean;
}

export function DataTable<T extends { id?: string }>({ columns, rows, onRowClick, loading, empty, rowKey, sort, onSort, dense }: { columns: Column<T>[]; rows: T[]; onRowClick?: (row: T) => void; loading?: boolean; empty?: ReactNode; rowKey?: (row: T) => string; sort?: { key: string; order: 'asc' | 'desc' }; onSort?: (key: string) => void; dense?: boolean }) {
  return (
    <div className="overflow-auto">
      <table className={cn('table', dense && '[&_td]:py-1.5 [&_th]:py-1.5')}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width } : undefined} className={cn(c.className, c.sortable && onSort && 'cursor-pointer select-none hover:text-default')} onClick={() => c.sortable && onSort?.(c.key)}>
                {c.header}
                {sort?.key === c.key && <span className="ml-1 text-[10px]">{sort.order === 'asc' ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 && (
            <tr>
              <td colSpan={columns.length}>
                <LoadingBlock />
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={columns.length}>{empty ?? <EmptyState />}</td>
            </tr>
          )}
          {rows.map((row, i) => (
            <tr key={rowKey ? rowKey(row) : row.id ?? i} className={cn(onRowClick && 'clickable')} onClick={() => onRowClick?.(row)}>
              {columns.map((c) => (
                <td key={c.key} className={c.className}>
                  {c.render ? c.render(row) : ((row as Record<string, unknown>)[c.key] as ReactNode) ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return <div className="text-xs text-muted px-3 py-2">{total} {total === 1 ? 'record' : 'records'}</div>;
  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs text-muted border-t border-default">
      <div>
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
      </div>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="px-2">
          {page} / {pages}
        </span>
        <Button variant="ghost" size="icon" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Search input
export function SearchInput({ value, onChange, placeholder = 'Search…', className, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean }) {
  const [local, setLocal] = useState(value);
  const t = useRef<number | null>(null);
  useEffect(() => setLocal(value), [value]);
  return (
    <div className={cn('relative', className)}>
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-subtle" />
      <input
        autoFocus={autoFocus}
        className="input pl-8"
        placeholder={placeholder}
        value={local}
        onChange={(e) => {
          setLocal(e.target.value);
          if (t.current) window.clearTimeout(t.current);
          t.current = window.setTimeout(() => onChange(e.target.value), 250);
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ Key/value descriptions
export function KeyValue({ items, columns = 2, className }: { items: { label: ReactNode; value: ReactNode; span?: number }[]; columns?: 1 | 2 | 3 | 4; className?: string }) {
  const cols = { 1: 'grid-cols-1', 2: 'grid-cols-1 sm:grid-cols-2', 3: 'grid-cols-1 sm:grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' }[columns];
  return (
    <dl className={cn('grid gap-x-6 gap-y-3', cols, className)}>
      {items.map((it, i) => (
        <div key={i} className={cn(it.span === 2 && 'sm:col-span-2', it.span === 3 && 'sm:col-span-3')}>
          <dt className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">{it.label}</dt>
          <dd className="text-[13.5px] mt-0.5 break-words">{it.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

// ------------------------------------------------------------------ Stat tile
export function StatTile({ label, value, hint, tone, onClick, icon }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'good' | 'warn' | 'bad'; onClick?: () => void; icon?: ReactNode }) {
  const toneClass = { default: '', good: 'text-emerald-600 dark:text-emerald-400', warn: 'text-amber-600 dark:text-amber-400', bad: 'text-red-600 dark:text-red-400' }[tone ?? 'default'];
  return (
    <div className={cn('card p-4 flex flex-col gap-1', onClick && 'cursor-pointer hover:border-brand-400 transition-colors')} onClick={onClick}>
      <div className="flex items-center justify-between text-[12px] text-muted font-medium">
        <span>{label}</span>
        {icon && <span className="text-subtle">{icon}</span>}
      </div>
      <div className={cn('text-2xl font-semibold tracking-tight', toneClass)}>{value}</div>
      {hint && <div className="text-xs text-subtle">{hint}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Avatar
export function Avatar({ name, size = 'sm', className }: { name?: string | null; size?: 'xs' | 'sm' | 'md'; className?: string }) {
  const s = { xs: 'h-5 w-5 text-[9px]', sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-sm' }[size];
  const txt = (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  return <span className={cn('inline-flex items-center justify-center rounded-full bg-brand-100 text-brand-800 dark:bg-brand-500/20 dark:text-brand-200 font-semibold shrink-0', s, className)}>{txt || '?'}</span>;
}

// ------------------------------------------------------------------ Progress bar
export function ProgressBar({ pct, tone, className }: { pct: number; tone?: 'auto' | 'good' | 'warn' | 'bad' | 'neutral'; className?: string }) {
  const p = Math.max(0, Math.min(100, pct));
  const t = tone === 'auto' || !tone ? (p >= 100 ? 'bad' : p >= 75 ? 'warn' : 'good') : tone;
  const color = { good: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', neutral: 'bg-brand-500' }[t];
  return (
    <div className={cn('h-1.5 w-full rounded-full bg-surface-2 overflow-hidden', className)}>
      <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${p}%` }} />
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none text-[13px]">
      <span role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={cn('relative inline-flex h-5 w-9 items-center rounded-full transition-colors', checked ? 'bg-brand-600' : 'bg-surface-2 border border-default')}>
        <span className={cn('inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
      </span>
      {label}
    </label>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-default bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-mono text-muted">{children}</kbd>;
}

export const CheckIcon = Check;
