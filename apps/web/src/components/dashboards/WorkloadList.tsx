import { Link } from 'react-router-dom';
import { Avatar } from '@/components/ui';
import { cn } from '@/lib/utils';

export interface WorkloadItem {
  id: string;
  name: string;
  open: number;
  critical?: number;
  breached?: number;
  stale?: number;
  teams?: string | null;
}

/** Open tickets per engineer with critical/breached markers. */
export function WorkloadList({ items, emptyText = 'No engineers with open tickets' }: { items: WorkloadItem[]; emptyText?: string }) {
  if (!items.length) return <div className="text-[13px] text-subtle py-4 text-center">{emptyText}</div>;
  const max = Math.max(1, ...items.map((i) => i.open));
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((i) => (
        <li key={i.id}>
          <Link to={`/tickets?assigneeId=${i.id}&open=true`} className="flex items-center gap-2.5 rounded-md hover:bg-surface-2 px-1 -mx-1 py-1">
            <Avatar name={i.name} size="xs" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2 text-[12.5px]">
                <span className="truncate">
                  {i.name}
                  {i.teams && <span className="text-subtle ml-1.5 text-[11px]">{i.teams}</span>}
                </span>
                <span className="tabular-nums text-muted shrink-0">
                  {i.open}
                  {!!i.critical && <span className="ml-1.5 text-orange-600 dark:text-orange-400" title="P1/P2">{i.critical} crit</span>}
                  {!!i.breached && <span className="ml-1.5 text-red-600 dark:text-red-400" title="SLA breached">{i.breached} breached</span>}
                  {!!i.stale && <span className="ml-1.5 text-subtle" title="No update in 24h">{i.stale} stale</span>}
                </span>
              </div>
              <div className="h-1 w-full rounded-full bg-surface-2 overflow-hidden mt-0.5">
                <div className={cn('h-full rounded-full', i.breached ? 'bg-red-500' : 'bg-brand-500')} style={{ width: `${Math.max(2, (i.open / max) * 100)}%` }} />
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
