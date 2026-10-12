import { Link } from 'react-router-dom';
import { STATUS, complianceTone, ticketListPath, type TicketListLink } from '@itsm/shared';
import { fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { OutcomeDonut } from './OutcomeDonut';

/** The one SLA compliance figure every dashboard carries: resolution clocks that ended in the period, and the open clocks now. */
export interface SlaFigures {
  met: number;
  breached: number;
  /** `met / (met + breached)` to one decimal; null when nothing ended. */
  compliancePct: number | null;
  /** The same figures over the previous period, where the payload carries a delta. */
  previous?: { met: number; breached: number; compliancePct: number | null };
  /** Open tickets now by the shared SLA vocabulary (at risk = running and warned, breached = the engine flag). */
  open?: { atRisk: number; breached: number };
}

export interface SlaPeriod {
  from: string;
  to: string;
}

/** The two doors of a compliance figure: the tickets whose resolution clock was met, or breached, inside the period (`status: 'any'`: the tickets behind an ended clock may be resolved). */
export const slaOutcomeLink = (link: TicketListLink, period: SlaPeriod, outcome: 'met' | 'breached'): TicketListLink => ({ ...link, status: 'any', slaOutcome: outcome, slaEndedFrom: period.from, slaEndedTo: period.to });

export interface SlaComplianceDonutProps {
  sla: SlaFigures;
  period: SlaPeriod;
  /** The scope every door carries (customer, domain, team, assignee, site). */
  link: TicketListLink;
  /** The link builder: `ticketListPath` for staff, `portalTicketListPath` on the portal. */
  path?: (link: TicketListLink) => string;
  size?: number;
  className?: string;
}

/**
 * SLA compliance · Nd as a donut: met against breached on the shared status
 * scale, the percentage in the centre in its compliance tone (good from the
 * target, warning from the band below it, critical under that), "of N clocks
 * ended" beneath it; the Met and Breached segments open the tickets behind
 * them (`slaOutcome` with `slaEndedFrom/To` = the period), and the "Open now"
 * line is the dashboards' at-risk and breached doors. The number is the one
 * helper computes on the API, so the same organisation reads the same figure
 * on the Overview, the dedicated dashboards, the portal home and its record.
 */
export function SlaComplianceDonut({ sla, period, link, path = ticketListPath, size = 140, className }: SlaComplianceDonutProps) {
  const ended = sla.met + sla.breached;
  const open = sla.open;
  return (
    <OutcomeDonut
      className={className}
      size={size}
      title="Resolution SLA compliance"
      pct={sla.compliancePct}
      tone={complianceTone(sla.compliancePct)}
      centerLabel={`of ${fmtNumber(ended)} ${ended === 1 ? 'clock' : 'clocks'} ended`}
      emptyText="No resolution clock ended in this period"
      good={{ label: 'Met', value: sla.met, href: path(slaOutcomeLink(link, period, 'met')) }}
      bad={{ label: 'Breached', value: sla.breached, href: path(slaOutcomeLink(link, period, 'breached')) }}
    >
      {open && (
        <div className="pt-3 border-t border-default text-[12px] text-muted flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="sla-open-now">
          <span>Open now:</span>
          <Link to={path({ ...link, status: 'open', sla: 'at_risk' })} className={cn('inline-flex items-center gap-1.5 tnum hover:underline underline-offset-2', open.atRisk > 0 ? 'text-amber-600 font-medium' : 'text-muted')}>
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: STATUS.warning }} aria-hidden />
            {fmtNumber(open.atRisk)} at risk
          </Link>
          <Link to={path({ ...link, status: 'open', sla: 'breached' })} className={cn('inline-flex items-center gap-1.5 tnum hover:underline underline-offset-2', open.breached > 0 ? 'text-red-600 font-medium' : 'text-muted')}>
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: STATUS.critical }} aria-hidden />
            {fmtNumber(open.breached)} breached
          </Link>
        </div>
      )}
    </OutcomeDonut>
  );
}

/** The panel's one subtitle, so every dashboard says the same thing under "SLA compliance · Nd". */
export const SLA_PANEL_SUBTITLE = 'Resolution clocks that ended in the period; met and breached open the tickets behind them';
