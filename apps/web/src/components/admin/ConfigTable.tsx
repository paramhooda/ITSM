import { type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { DataTable, ErrorBlock, EmptyState, type Column } from '@/components/ui';
import { Menu, type MenuItem } from '@/components/Menu';
import { cn } from '@/lib/utils';

export interface RowAction<T> {
  label: string;
  icon?: ReactNode;
  onClick: (row: T) => void;
  danger?: boolean;
  hidden?: (row: T) => boolean;
  disabled?: (row: T) => boolean;
  /** Show as an inline icon button instead of inside the overflow menu. */
  inline?: boolean;
}

export interface ConfigTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  error?: unknown;
  retry?: () => void;
  actions?: RowAction<T>[];
  onRowClick?: (row: T) => void;
  toolbar?: ReactNode;
  footer?: ReactNode;
  empty?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  rowKey?: (row: T) => string;
  dense?: boolean;
  className?: string;
}

/**
 * Generic configuration list: optional toolbar, columns, inline icon actions
 * and an overflow menu per row. Wraps the UI kit DataTable in a card.
 */
export function ConfigTable<T extends { id?: string }>({ columns, rows, loading, error, retry, actions, onRowClick, toolbar, footer, empty, emptyTitle, emptyDescription, rowKey, dense = true, className }: ConfigTableProps<T>) {
  const cols: Column<T>[] = [...columns];
  if (actions?.length) {
    cols.push({
      key: '__actions',
      header: '',
      className: 'text-right w-px whitespace-nowrap',
      render: (row) => {
        const visible = actions.filter((a) => !a.hidden?.(row));
        const inline = visible.filter((a) => a.inline && a.icon);
        const menu = visible.filter((a) => !(a.inline && a.icon));
        return (
          <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
            {inline.map((a) => (
              <button
                key={a.label}
                title={a.label}
                disabled={a.disabled?.(row)}
                onClick={() => a.onClick(row)}
                className={cn('h-7 w-7 inline-flex items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-default disabled:opacity-40 disabled:cursor-not-allowed', a.danger && 'hover:text-red-600')}
              >
                {a.icon}
              </button>
            ))}
            {menu.length > 0 && (
              <Menu
                trigger={
                  <button className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-default" title="More">
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                }
                items={menu.map<MenuItem>((a) => ({ label: a.label, icon: a.icon, danger: a.danger, disabled: a.disabled?.(row), onClick: () => a.onClick(row) }))}
              />
            )}
          </div>
        );
      },
    });
  }
  return (
    <div className={cn('card overflow-hidden', className)}>
      {toolbar && <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-default">{toolbar}</div>}
      {error ? (
        <ErrorBlock error={error} retry={retry} />
      ) : (
        <DataTable<T> columns={cols} rows={rows} loading={loading} onRowClick={onRowClick} rowKey={rowKey} dense={dense} empty={empty ?? <EmptyState title={emptyTitle ?? 'Nothing configured yet'} description={emptyDescription} />} />
      )}
      {footer}
    </div>
  );
}

/** Small helpers for common cells. */
export function MutedCell({ children }: { children: ReactNode }) {
  return <span className="text-muted text-[12.5px]">{children}</span>;
}

export function MonoCell({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[12px] text-muted">{children}</span>;
}

export function ActiveDot({ active }: { active: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[12.5px]', active ? 'text-emerald-600 dark:text-emerald-400' : 'text-subtle')}>
      <span className={cn('h-1.5 w-1.5 rounded-full', active ? 'bg-emerald-500' : 'bg-slate-400')} />
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}
