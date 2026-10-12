import type { ReactNode } from 'react';
import { STATUS, type ComplianceTone } from '@itsm/shared';
import { cn } from '@/lib/utils';
import { fmtPct } from '@/lib/format';
import { DonutChart } from './DonutChart';

/** One outcome of a two-outcome ring: its legend label, its count and, when the count can reproduce on a list, the door. */
export interface Outcome {
  label: string;
  value: number;
  href?: string;
}

export interface OutcomeDonutProps {
  /** The good outcome (met, completed, on time): `STATUS.good`. */
  good: Outcome;
  /** The bad outcome (breached, missed): `STATUS.critical`. */
  bad: Outcome;
  /** The percentage printed in the centre (one decimal), `null` when nothing ended. */
  pct: number | null | undefined;
  /** The text tone of the percentage; `null` prints it in the default text colour. */
  tone: ComplianceTone | null;
  /** Caption under the percentage ("of 24 clocks ended"). */
  centerLabel?: string;
  emptyText?: string;
  /** Accessible name of the ring (`role="img"`), also the svg title. */
  title?: string;
  size?: number;
  /** Digits of the percentage. */
  digits?: number;
  className?: string;
  /** A line under the ring and its legend (the open clocks now, a note). */
  children?: ReactNode;
}

/** The text class of a compliance tone, the same three the KPI tiles use; a status colour never paints text. */
export const TONE_TEXT: Record<ComplianceTone, string> = { good: 'text-emerald-600', warning: 'text-amber-600', critical: 'text-red-600' };

/** The KPI tile tone of a compliance tone (`KpiItem.tone`, `Stat.tone`, `StatTile.tone`). */
export const toneToKpi = (tone: ComplianceTone | null): 'default' | 'good' | 'warn' | 'bad' => (tone === 'good' ? 'good' : tone === 'warning' ? 'warn' : tone === 'critical' ? 'bad' : 'default');

/**
 * A two-outcome donut: good against bad on the shared status scale (always
 * paired with the legend labels), the percentage in the centre as text in a
 * tone class, the counts and their shares in the legend. It never falls back
 * to bars (two segments read on a ring), and a segment or legend row with an
 * `href` is a door into the list it was counted on.
 */
export function OutcomeDonut({ good, bad, pct, tone, centerLabel = 'of all', emptyText = 'Nothing to show', title, size = 140, digits = 1, className, children }: OutcomeDonutProps) {
  const label = title ?? `${good.label} against ${bad.label}`;
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <DonutChart
        layout="donut"
        size={size}
        ariaLabel={`${label}: ${fmtPct(pct, digits)}`}
        centerLabel={centerLabel}
        emptyText={emptyText}
        centerValue={<span className={cn('text-[22px] leading-none font-semibold tracking-[-0.03em] tnum', tone ? TONE_TEXT[tone] : 'text-default')} data-testid="donut-center">{fmtPct(pct, digits)}</span>}
        slices={[
          { key: 'good', label: good.label, value: good.value, hex: STATUS.good, href: good.href },
          { key: 'bad', label: bad.label, value: bad.value, hex: STATUS.critical, href: bad.href },
        ]}
      />
      {children}
    </div>
  );
}
