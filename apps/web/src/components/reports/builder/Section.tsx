import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** One collapsible block of the configuration card: a title row with a one-line summary, then the controls. */
export function Section({ title, summary, hint, open: initial = true, children, className }: { title: ReactNode; summary?: ReactNode; hint?: ReactNode; open?: boolean; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(initial);
  // a block that opens because of another block's edit (the chart once grouping is on) follows its prop
  useEffect(() => setOpen(initial), [initial]);
  return (
    <div className={cn('border-b border-default last:border-b-0', className)}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-2 transition-colors">
        {open ? <ChevronDown className="h-3.5 w-3.5 text-subtle shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-subtle shrink-0" />}
        <span className="text-[13px] font-semibold text-default">{title}</span>
        {summary && <span className="ml-auto text-[12px] text-muted truncate max-w-[55%] text-right">{summary}</span>}
      </button>
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-3">
          {hint && <div className="text-[12px] text-subtle">{hint}</div>}
          {children}
        </div>
      )}
    </div>
  );
}
