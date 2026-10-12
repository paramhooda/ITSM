import { useQuery } from '@tanstack/react-query';
import { EmptyState } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { DashboardFrame, useDashboardScope } from '@/components/dashboards/DashboardFrame';
import { CustomerDashboard, useCustomerHome } from '@/components/dashboards/CustomerDashboard';
import { greeting } from '@/components/dashboards/OverviewSections';
import { portalApi, pk } from '@/components/portal/api';

/**
 * The customer portal home: the organisation's dashboard on the same frame as
 * the staff dashboards, with the period and, when the organisation has more
 * than one site, a site scope in the hero; no customer picker, no dashboards
 * strip, no briefing. The scope line names the organisation, the site and the
 * period, and every number opens My tickets with the conditions it was counted
 * with.
 */
export default function PortalHomePage() {
  const user = useAuthStore((s) => s.user)!;
  const can = useAuthStore((s) => s.can);
  const allowed = can('portal:access');
  const scope = useDashboardScope();
  const me = useQuery({ queryKey: pk.me, queryFn: portalApi.me, staleTime: 5 * 60_000, enabled: allowed });
  const q = useCustomerHome(scope, allowed);
  const sites = (me.data?.sites ?? []).map((s) => ({ id: s.id, name: s.name }));
  return (
    <DashboardFrame
      title={greeting(user.name)}
      subtitle="Your tickets, service levels, contracts and upcoming work"
      strip={null}
      scope="none"
      scopeName={q.data?.customer.name || me.data?.customer.name || 'Your organisation'}
      sites={sites}
      period={q.data?.period}
      generatedAt={q.data?.generatedAt}
      fetching={q.isFetching}
      refreshNote="Refreshes every minute"
    >
      {(s) => (allowed ? <CustomerDashboard days={s.days} siteId={s.siteId} sites={sites} /> : <EmptyState title="Portal access required" description="Ask your administrator to grant portal access." />)}
    </DashboardFrame>
  );
}
