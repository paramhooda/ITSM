import type { ReactNode } from 'react';
import { Select, ModuleNav } from '@/components/ui';
import { DASHBOARD_MODULES } from '@/layouts/modules';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDate } from '@/lib/format';
import { DashboardHero, PeriodPicker } from './Hero';
import { Updated } from './Panel';
import { BriefingCard } from './BriefingCard';

/** The interactive filters every dashboard shares, read from the URL: `days`, `customerId` and, on the NOC, `teamId`. */
export interface DashboardScope {
  days: number;
  /** Empty for all customers. */
  customerId: string;
  /** Empty for every team (only the dashboards that offer a team control read it). */
  teamId: string;
  set: ReturnType<typeof useListState>['set'];
}

export function useDashboardScope(): DashboardScope {
  const { state, set } = useListState();
  const days = Number(state.days ?? 30) || 30;
  return { days, customerId: state.customerId ?? '', teamId: state.teamId ?? '', set };
}

export interface DashboardTeam {
  id: string;
  name: string;
}

export interface DashboardFrameProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Offer a team control in the hero (the NOC); the list comes from the dashboard's own payload. */
  teams?: DashboardTeam[];
  teamLabel?: string;
  teamPlaceholder?: string;
  /** The period the payload was counted over, printed on the scope line. */
  period?: { from: string; to: string } | null;
  /** When the payload was computed, for the "Updated" stamp. */
  generatedAt?: string | Date | null;
  fetching?: boolean;
  /** "refreshes every minute" and the like. */
  refreshNote?: ReactNode;
  /** The daily briefing card (the Overview and My work). */
  briefing?: boolean;
  /** The dashboard's body, given the scope every panel follows. */
  children: (scope: DashboardScope) => ReactNode;
}

/** A dashboard page's path with the period and the customer scope carried along (the strip, the Overview's "Open dashboard" links), so moving between dashboards never loses them. */
export const dashboardPath = (to: string, scope: Pick<DashboardScope, 'days' | 'customerId'>) => {
  const p = new URLSearchParams();
  if (scope.days !== 30) p.set('days', String(scope.days));
  if (scope.customerId) p.set('customerId', scope.customerId);
  const q = p.toString();
  return q ? `${to}?${q}` : to;
};

/**
 * The frame every dashboard page renders in: the hero with the interactive
 * filters (period, customer scope and, where offered, a team), the module strip
 * (Overview · Network operations · Security operations · AMC & field service ·
 * My work · custom dashboards later), a scope line that says in words what
 * every panel is counted over, the "Updated" stamp and the body. The filters
 * live in the URL, change every panel and are the only thing on a dashboard
 * that filters the dashboard; every number is a door into the list it was
 * counted on, and a panel's own controls change that panel alone.
 */
export function DashboardFrame({ title, subtitle, teams, teamLabel = 'Team', teamPlaceholder = 'All teams', period, generatedAt, fetching, refreshNote, briefing, children }: DashboardFrameProps) {
  const scope = useDashboardScope();
  const customers = useCustomersLookup();
  const customerItems = customers.data?.items ?? [];
  const customerName = scope.customerId ? customerItems.find((c) => c.id === scope.customerId)?.name : undefined;
  const team = scope.teamId ? teams?.find((t) => t.id === scope.teamId) : undefined;
  const scopeLine = [
    customerName ?? (scope.customerId ? 'One customer' : 'All customers'),
    `last ${scope.days} days${period ? ` (${fmtDate(period.from)} – ${fmtDate(period.to)})` : ''}`,
    // A team id the list does not hold yet (first paint, or an id from another dashboard's URL) still reads as one team, never as the placeholder.
    teams ? (scope.teamId ? (team?.name ?? 'One team') : teamPlaceholder) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div>
      <DashboardHero title={title} subtitle={subtitle}>
        <PeriodPicker days={scope.days} onChange={(d) => scope.set({ days: d }, false)} />
        {/* Global scope: every panel on the page follows it; the scope line below says what is applied. A label and its control wrap together on a phone. */}
        <span className="inline-flex items-center gap-2 ml-2">
          <span className="text-[12px] text-subtle">Scope</span>
          <Select className="w-56 max-w-[70vw] h-8 py-0 text-[12.5px] bg-white" value={scope.customerId} onChange={(e) => scope.set({ customerId: e.target.value }, false)} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} aria-label="Customer scope" />
        </span>
        {teams && (
          <span className="inline-flex items-center gap-2 ml-2">
            <span className="text-[12px] text-subtle">{teamLabel}</span>
            <Select className="w-48 max-w-[70vw] h-8 py-0 text-[12.5px] bg-white" value={scope.teamId} onChange={(e) => scope.set({ teamId: e.target.value }, false)} placeholder={teamPlaceholder} options={teams.map((t) => ({ value: t.id, label: t.name }))} aria-label={teamLabel} />
          </span>
        )}
      </DashboardHero>
      <ModuleNav items={DASHBOARD_MODULES.map((m) => ({ ...m, to: dashboardPath(m.to, scope) }))} label="Dashboards" />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 -mt-1 mb-4 text-[12.5px]" data-testid="dashboard-scope">
        <span className="text-muted">
          <span className="text-subtle">Showing</span> <span className="font-medium text-default">{scopeLine}</span>
        </span>
        <span className="inline-flex items-center gap-2 text-subtle">
          {refreshNote}
          <Updated at={generatedAt} fetching={fetching} />
        </span>
      </div>
      {briefing && <BriefingCard />}
      {children(scope)}
    </div>
  );
}
