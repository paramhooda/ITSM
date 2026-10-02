import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * Small dark tooltip rendered through a portal, so it is never clipped by a
 * scrolling container (the collapsed sidebar). Shown on hover and keyboard focus.
 * With no `label` the children render unchanged.
 */
export function Tooltip({ label, children, side = 'right', className, delay = 120 }: { label?: ReactNode; children: ReactNode; side?: 'right' | 'bottom' | 'top' | 'left'; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  if (!label) return <>{children}</>;
  const show = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      setPos(side === 'right' ? { x: r.right + 10, y: r.top + r.height / 2 } : side === 'left' ? { x: r.left - 10, y: r.top + r.height / 2 } : side === 'top' ? { x: r.left + r.width / 2, y: r.top - 8 } : { x: r.left + r.width / 2, y: r.bottom + 8 });
    }, delay);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setPos(null);
  };
  const transform = { right: 'translateY(-50%)', left: 'translate(-100%, -50%)', top: 'translate(-50%, -100%)', bottom: 'translateX(-50%)' }[side];
  return (
    <div ref={ref} className={cn('relative', className)} onMouseEnter={show} onMouseLeave={hide} onFocusCapture={show} onBlurCapture={hide}>
      {children}
      {pos &&
        createPortal(
          <div role="tooltip" className="fixed z-[70] pointer-events-none rounded-md bg-[#18181b] px-2 py-1.5 text-[12px] font-medium leading-none text-white shadow-[0_4px_12px_rgba(9,9,11,0.18)] whitespace-nowrap fade-in" style={{ left: pos.x, top: pos.y, transform }}>
            {label}
          </div>,
          document.body,
        )}
    </div>
  );
}
