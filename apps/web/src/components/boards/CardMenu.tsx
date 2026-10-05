import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MenuItem } from '@/components/Menu';

const ITEM = '[role=menuitem]:not(:disabled)';

/**
 * The overflow menu on a board card. Rendered through a portal so a lane's scrolling
 * body never clips it; the same flat `MenuItem[]` the shared `Menu` takes. The menu
 * follows its trigger when a lane or the strip scrolls, and the arrow keys walk it.
 */
export function CardMenu({ items, label = 'Card actions' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    return r ? { x: r.right, y: r.bottom + 4 } : { x: 0, y: 0 };
  };
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest('[data-card-menu]')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      btn.current?.focus();
    };
    // A lane or the strip may scroll under the menu (the browser nudges a button into view, the strip auto-scrolls): follow the trigger.
    const follow = () =>
      setPos((p) => {
        const n = place();
        return n.x === p.x && n.y === p.y ? p : n;
      });
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    menu.current?.querySelector<HTMLButtonElement>(ITEM)?.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [open]);
  const toggle = () => {
    if (open) setOpen(false);
    else {
      setPos(place());
      setOpen(true);
    }
  };
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const entries = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>(ITEM) ?? []);
    if (!entries.length) return;
    const i = entries.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = (i + 1) % entries.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + entries.length) % entries.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = entries.length - 1;
    if (next === null) return;
    e.preventDefault();
    entries[next]!.focus();
  };
  if (!items.length) return null;
  return (
    <>
      <button
        ref={btn}
        type="button"
        data-card-menu
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        className={cn('h-6 w-6 rounded-md inline-flex items-center justify-center text-subtle hover:text-default hover:bg-surface-2 transition-colors shrink-0', open && 'bg-surface-2 text-default')}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open &&
        createPortal(
          <div ref={menu} role="menu" aria-label={label} data-card-menu onKeyDown={onMenuKey} className="fixed z-[60] min-w-[190px] card shadow-pop py-1 fade-in" style={{ left: pos.x, top: pos.y, transform: 'translateX(-100%)' }}>
            {items.map((it, i) => (
              <button
                key={i}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
                className={cn('w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:opacity-50', it.danger && 'text-red-600')}
              >
                {it.icon}
                {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
