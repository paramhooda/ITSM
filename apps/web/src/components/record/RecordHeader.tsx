import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, MoreHorizontal, Pencil, Check, X } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { Menu, type MenuItem } from '@/components/Menu';
import { cn } from '@/lib/utils';
import { fmtDateTime, relativeTime } from '@/lib/format';

export interface Crumb {
  label: ReactNode;
  to?: string;
}

/**
 * ServiceNow-style record header: breadcrumb trail (Application / Module / Record),
 * the record number and title on one line, state controls and badges beneath, and at
 * most two primary actions on the right with everything else in an overflow menu.
 */
export function RecordHeader({
  crumbs,
  number,
  title,
  onTitleChange,
  titleMinLength = 3,
  badges,
  controls,
  primary,
  menu,
  updatedAt,
  createdAt,
  createdBy,
  children,
  className,
}: {
  crumbs: Crumb[];
  number?: ReactNode;
  title: ReactNode;
  /** When set, the title is click-to-edit. */
  onTitleChange?: (next: string) => void;
  titleMinLength?: number;
  /** Type / major / escalation style badges, shown after the number. */
  badges?: ReactNode;
  /** State, priority, scope controls shown under the title. */
  controls?: ReactNode;
  /** At most two primary buttons. */
  primary?: ReactNode;
  /** Everything else, shown in the "…" menu. */
  menu?: MenuItem[];
  updatedAt?: string | null;
  createdAt?: string | null;
  createdBy?: string | null;
  /** Optional ribbon rendered inside the header card (RecordRibbon). */
  children?: ReactNode;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const titleText = typeof title === 'string' ? title : '';
  const commit = () => {
    if (draft !== null && draft.trim().length >= titleMinLength) onTitleChange?.(draft.trim());
    setDraft(null);
  };
  const items = (menu ?? []).filter(Boolean);
  return (
    <header className={cn('card px-5 py-4', className)}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <ChevronRight className="h-3 w-3 text-subtle" />}
            {c.to ? (
              <Link to={c.to} className="hover:text-default hover:underline">
                {c.label}
              </Link>
            ) : (
              <span className="text-default font-medium">{c.label}</span>
            )}
          </Fragment>
        ))}
        {(createdAt || updatedAt) && (
          <span className="ml-auto text-subtle" title={updatedAt ? `Updated ${fmtDateTime(updatedAt)}` : undefined}>
            {createdAt && <>Opened {relativeTime(createdAt)}{createdBy ? ` by ${createdBy}` : ''}</>}
            {createdAt && updatedAt && ' · '}
            {updatedAt && <>updated {relativeTime(updatedAt)}</>}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[260px]">
          <div className="flex flex-wrap items-center gap-2">
            {number && <span className="font-mono text-[13px] font-medium text-secondary">{number}</span>}
            {badges}
          </div>
          {onTitleChange && draft !== null ? (
            <div className="mt-1 flex items-center gap-2">
              <Input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="text-[16px] font-semibold"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') setDraft(null);
                }}
              />
              <Button size="icon" variant="ghost" onClick={commit} aria-label="Save title"><Check className="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" onClick={() => setDraft(null)} aria-label="Cancel"><X className="h-4 w-4" /></Button>
            </div>
          ) : (
            <h1 className={cn('mt-0.5 text-[20px] font-semibold leading-snug tracking-[-0.02em] group flex items-start gap-2', onTitleChange && 'cursor-text')} onClick={() => onTitleChange && setDraft(titleText)} title={onTitleChange ? 'Click to edit' : undefined}>
              <span className="min-w-0 break-words">{title}</span>
              {onTitleChange && <Pencil className="h-3.5 w-3.5 text-subtle opacity-0 group-hover:opacity-100 mt-2 shrink-0" />}
            </h1>
          )}
          {controls && <div className="mt-2 flex flex-wrap items-center gap-2">{controls}</div>}
        </div>
        {(primary || items.length > 0) && (
          <div className="flex items-center gap-1.5 shrink-0">
            {primary}
            {items.length > 0 && (
              <Menu
                trigger={
                  <Button size="sm" variant="outline" aria-label="More actions" className="px-2">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                }
                items={items}
              />
            )}
          </div>
        )}
      </div>
      {children}
    </header>
  );
}

/** Compact numbers strip inside the record header: age, clocks, counts. */
export function RecordRibbon({ items, columns }: { items: { label: ReactNode; value: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'default'; hint?: string }[]; columns?: number }) {
  if (!items.length) return null;
  const n = columns ?? Math.min(6, items.length);
  return (
    <div className="mt-3 pt-3 border-t border-default grid grid-cols-2 gap-x-6 gap-y-2" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0" title={it.hint}>
          <div className="text-[11.5px] text-muted truncate">{it.label}</div>
          <div className={cn('text-[15px] font-semibold tracking-[-0.01em] tnum truncate', it.tone === 'bad' ? 'text-red-600' : it.tone === 'warn' ? 'text-amber-600' : it.tone === 'good' ? 'text-emerald-600' : 'text-default')}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}
