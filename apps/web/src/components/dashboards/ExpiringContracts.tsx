import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui';
import { fmtDate } from '@/lib/format';

export interface ExpiringContract {
  id: string;
  number: string;
  name: string;
  customerId?: string;
  customerName?: string | null;
  endDate: string;
  daysToExpiry: number;
  status: string;
  autoRenew?: boolean;
}

/** Contracts ending soon; the days-left badge carries the urgency, the label carries the meaning. */
export function ExpiringContracts({ items, showCustomer = true, emptyText = 'No contracts expiring in the next 90 days' }: { items: ExpiringContract[]; showCustomer?: boolean; emptyText?: string }) {
  if (!items.length) return <div className="text-[13px] text-subtle py-4 text-center">{emptyText}</div>;
  return (
    <ul className="flex flex-col divide-y divide-[var(--border)]">
      {items.map((c) => (
        <li key={c.id} className="py-1.5 flex items-center justify-between gap-2 text-[12.5px]">
          <div className="min-w-0">
            <Link to={`/contracts/${c.id}`} className="hover:underline font-medium truncate block">{c.name}</Link>
            <div className="text-subtle text-[11.5px] truncate">
              <span className="font-mono">{c.number}</span>
              {showCustomer && c.customerName && <> · {c.customerName}</>} · ends {fmtDate(c.endDate)}
              {c.autoRenew && ' · auto-renew'}
            </div>
          </div>
          <Badge color={c.daysToExpiry <= 7 ? 'red' : c.daysToExpiry <= 30 ? 'amber' : 'slate'}>{c.daysToExpiry < 0 ? 'expired' : `${c.daysToExpiry}d left`}</Badge>
        </li>
      ))}
    </ul>
  );
}
