import { ProgressBar } from '@/components/ui';
import { fmtDate, fmtNumber, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { PortalEntitlement } from './api';

const PERIOD_LABEL: Record<string, string> = { contract: 'for the whole contract', yearly: 'per year', half_yearly: 'per half year', quarterly: 'per quarter', monthly: 'per month' };

/** Entitlement utilisation bars (visits, hours...) with the current period. */
export function EntitlementBars({ entitlements, className }: { entitlements: PortalEntitlement[]; className?: string }) {
  if (!entitlements.length) return <div className="text-[12.5px] text-muted">Your contracts have no quantified entitlements.</div>;
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {entitlements.map((e) => {
        const u = e.utilization;
        const tone = u.exhausted ? 'bad' : u.overThreshold ? 'warn' : 'good';
        return (
          <div key={e.id}>
            <div className="flex items-baseline justify-between gap-2 text-[13px]">
              <div className="min-w-0">
                <span className="font-medium">{e.name}</span>
                {e.serviceName && <span className="text-muted"> · {e.serviceName}</span>}
              </div>
              <span className="tabular-nums text-muted shrink-0">
                <span className={cn('font-medium', u.exhausted ? 'text-red-600' : u.overThreshold ? 'text-amber-600' : 'text-default')}>{fmtNumber(u.used, 2)}</span> / {fmtNumber(u.quantity, 2)} {titleCase(e.unit).toLowerCase()}
              </span>
            </div>
            <ProgressBar pct={u.pct} tone={tone} className="my-1.5 h-2" />
            <div className="flex flex-wrap justify-between gap-x-3 text-[11.5px] text-subtle">
              <span>
                {fmtNumber(u.remaining, 2)} remaining {PERIOD_LABEL[e.period] ?? e.period}
                {e.period !== 'contract' && ` · period ${fmtDate(u.periodStart)} – ${fmtDate(u.periodEnd)}`}
              </span>
              {e.contractNumber && <span>{e.contractNumber}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
