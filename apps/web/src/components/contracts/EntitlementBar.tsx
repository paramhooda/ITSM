import { ProgressBar } from '@/components/ui';
import { fmtDate, fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Entitlement } from './types';
import { PERIOD_LABELS, entitlementTone } from './ContractBits';

/** Utilisation bar: used / quantity unit, remaining and the current period window. */
export function EntitlementBar({ entitlement, compact = false, showContract = false, className }: { entitlement: Entitlement; compact?: boolean; showContract?: boolean; className?: string }) {
  const u = entitlement.utilization;
  const tone = entitlementTone(entitlement);
  const toneText = { good: 'text-muted', warn: 'text-amber-600 dark:text-amber-400', bad: 'text-red-600 dark:text-red-400' }[tone];
  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex items-center justify-between gap-2 text-[12.5px]">
        <div className="min-w-0 truncate">
          <span className="font-medium">{entitlement.name}</span>
          {showContract && entitlement.contractNumber && <span className="text-subtle"> · {entitlement.contractNumber}</span>}
          {!compact && entitlement.serviceName && <span className="text-subtle"> · {entitlement.serviceName}</span>}
        </div>
        <div className={cn('tabular-nums whitespace-nowrap', toneText)}>
          {fmtNumber(u.used, 2)} / {fmtNumber(u.quantity, 2)} {entitlement.unit}
          <span className="text-subtle"> · {fmtNumber(u.pct, 0)}%</span>
        </div>
      </div>
      <ProgressBar pct={u.pct} tone={tone} className="mt-1" />
      {!compact && (
        <div className="flex items-center justify-between text-[11px] text-subtle mt-1">
          <span>
            {PERIOD_LABELS[u.period] ?? u.period}: {fmtDate(u.periodStart)} – {fmtDate(u.periodEnd)}
          </span>
          <span>
            {u.exhausted ? 'Exhausted' : `${fmtNumber(u.remaining, 2)} ${entitlement.unit} remaining`} · warn at {u.warnThresholdPct}%
          </span>
        </div>
      )}
    </div>
  );
}
