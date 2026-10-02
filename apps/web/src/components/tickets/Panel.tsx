import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Card variant whose title accepts rich content (icons, badges); mirrors the UI kit's Card markup. */
export function Panel({ className, children, title, actions, padded = true, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & { title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <div className={cn('card', className)} {...props}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-default">
          <div className="font-semibold text-[13px] min-w-0 flex items-center gap-2">{title}</div>
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        </div>
      )}
      <div className={cn(padded && 'p-4')}>{children}</div>
    </div>
  );
}
