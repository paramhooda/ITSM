import { Navigate } from 'react-router-dom';
import { ErrorBlock } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useListState } from '@/hooks/useListState';
import PortalHomePage from '@/pages/portal/PortalHomePage';
import { DashboardFrame, useDashboardScope } from '@/components/dashboards/DashboardFrame';
import { KpiSkeleton } from '@/components/dashboards/Panel';
import { useOverview } from '@/components/dashboards/overviewApi';
import { greeting, shiftLine, MyDayStrip, AnnouncementsPanel, UpcomingPanel, DeskKpiRow, SlaCompliancePanel } from '@/components/dashboards/OverviewSections';
import { TicketFlowPanel, OpenByTypePanel, OverviewAgeingPanel, OverviewArrivalsPanel, LoadPanel, ResponseByPriorityPanel, ChangesPanel } from '@/components/dashboards/OverviewDesk';
import { OperationsStrips, ManagementExtras, SectionLabel } from '@/components/dashboards/OverviewExtras';
import type { TicketListLink } from '@itsm/shared';

/** Where an old `/?view=` link lands: the dedicated dashboard page, or the Overview itself. */
const VIEW_ROUTES: Record<string, string> = { noc: '/dashboards/noc', soc: '/dashboards/soc', amc: '/dashboards/amc', engineer: '/dashboards/my-work', 'my-work': '/dashboards/my-work', management: '/' };

function legacyViewPath(state: Record<string, string>): string {
  const to = VIEW_ROUTES[state.view ?? ''] ?? '/';
  const p = new URLSearchParams();
  if (state.days) p.set('days', state.days);
  if (state.customerId) p.set('customerId', state.customerId);
  const q = p.toString();
  return q ? `${to}?${q}` : to;
}

/**
 * The Overview every staff member lands on: a greeting with the shift running
 * now, then the numbers and charts first: the desk's health for the period
 * (tickets:read), the operations strips they may open and the management
 * extras (dashboards:management); their own day (My day, upcoming work and
 * announcements) sits below. Its filters live in the hero, every number is a
 * door into the ticket list it was counted on, and a panel's own control
 * (kept in the URL) changes that panel alone.
 */
function OverviewPage() {
  const user = useAuthStore((s) => s.user)!;
  const scope = useDashboardScope();
  const q = useOverview(scope);
  const d = q.data;
  const subtitle = (d && shiftLine(d.me.shift)) ?? 'Your desk, your work and the operations you may see';
  return (
    <DashboardFrame title={greeting(user.name)} subtitle={subtitle} period={d?.period} generatedAt={d?.generatedAt} fetching={q.isFetching} refreshNote="Refreshes every minute" briefing>
      {({ days, customerId }) => {
        if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
        if (!d) return <KpiSkeleton count={5} />;
        const today = d.period.to;
        const link: TicketListLink = { customerId: customerId || null };
        const open: TicketListLink = { ...link, status: 'open' };
        const hasStrips = !!(d.strips.noc || d.strips.soc || d.strips.amc);
        return (
          <div className="flex flex-col gap-6">
            {d.desk && (
              <>
                <SectionLabel hint={`Open now, and the last ${days} days`}>Service desk</SectionLabel>
                <DeskKpiRow overview={d} customerId={customerId} />
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                  <TicketFlowPanel d={d} scope={link} className="xl:col-span-2 rise-in rise-in-2" />
                  <SlaCompliancePanel d={d} scope={link} className="rise-in rise-in-2" />
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                  <OverviewArrivalsPanel desk={d.desk} scope={link} className="xl:col-span-2 rise-in rise-in-3" />
                  <OpenByTypePanel desk={d.desk} open={open} className="rise-in rise-in-3" />
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                  <OverviewAgeingPanel desk={d.desk} open={open} className="rise-in rise-in-4" />
                  <LoadPanel desk={d.desk} open={open} className="rise-in rise-in-4" />
                  <ChangesPanel d={d} open={open} className="rise-in rise-in-4" />
                </div>
                <ResponseByPriorityPanel d={d} scope={link} className="rise-in rise-in-4" />
              </>
            )}
            {hasStrips && (
              <div className="flex flex-col gap-3 rise-in rise-in-4">
                <SectionLabel hint="Each number is the dashboard's own tile">Operations</SectionLabel>
                <OperationsStrips d={d} scope={{ days, customerId }} />
              </div>
            )}
            {d.management && (
              <>
                <SectionLabel hint="Accounts, satisfaction and service levels">Management</SectionLabel>
                <ManagementExtras d={d} />
              </>
            )}
            <SectionLabel hint="Your queue, announcements and what is scheduled today and tomorrow">Your day</SectionLabel>
            <MyDayStrip me={d.me} customerId={customerId} today={today} className="rise-in rise-in-4" />
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              <UpcomingPanel upcoming={d.upcoming} today={today} className="xl:col-span-2 rise-in rise-in-4" />
              <AnnouncementsPanel items={d.announcements} className="rise-in rise-in-4" />
            </div>
          </div>
        );
      }}
    </DashboardFrame>
  );
}

/** Role-aware landing page: customer users get the portal home (the organisation's dashboard on the same frame), staff the Overview; old `?view=` links redirect to the dashboard pages. */
export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const { state } = useListState();
  if (!user) return null;
  if (user.userType === 'customer') return <PortalHomePage />;
  if (state.view) return <Navigate replace to={legacyViewPath(state)} />;
  return <OverviewPage />;
}
