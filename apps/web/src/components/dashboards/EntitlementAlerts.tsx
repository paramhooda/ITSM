import { Link } from 'react-router-dom';
import { ProgressBar, Badge } from '@/components/ui';
import { fmtNumber } from '@/lib/format';

export interface EntitlementAlert {
  id: string;
  name: string;
  unit: string;
  contractId?: string;
  contractNumber?: string | null;
  customerId?: string;
  customerName?: string;
  utilization: { pct: number; used: number; quantity: number; remaining: number; exhausted: boolean; overThreshold: boolean; periodEnd?: string };
}

/** Entitlements over their warning threshold or exhausted. */
export function EntitlementAlerts({ items, showCustomer = true, emptyText = 'No entitlements over threshold' }: { items: EntitlementAlert[]; showCustomer?: boolean; emptyText?: string }) {
  if (!items.length) return <div className="text-[13px] text-subtle py-4 text-center">{emptyText}</div>;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((e) => (
        <li key={e.id} className="text-[12.5px]">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate min-w-0">
              {e.contractId ? <Link to={`/contracts/${e.contractId}`} className="hover:underline font-medium">{e.name}</Link> : <span className="font-medium">{e.name}</span>}
              {showCustomer && e.customerName && <span className="text-muted"> · {e.customerName}</span>}
              {e.contractNumber && <span className="text-subtle font-mono text-[11px] ml-1.5">{e.contractNumber}</span>}
            </span>
            <span className="shrink-0 inline-flex items-center gap-1.5 tabular-nums text-muted">
              {fmtNumber(e.utilization.used, 1)}/{fmtNumber(e.utilization.quantity, 1)} {e.unit}
              <Badge color={e.utilization.exhausted ? 'red' : e.utilization.overThreshold ? 'amber' : 'green'}>{Math.round(e.utilization.pct)}%</Badge>
            </span>
          </div>
          <ProgressBar pct={e.utilization.pct} className="mt-1" />
        </li>
      ))}
    </ul>
  );
}
