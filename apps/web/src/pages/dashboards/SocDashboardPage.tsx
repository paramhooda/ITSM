import { EmptyState } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { DashboardFrame, useDashboardScope } from '@/components/dashboards/DashboardFrame';
import { SocDashboard, useSocDashboard } from '@/components/dashboards/SocDashboard';

/** Security operations: the security domain only, under the period and the customer scope chosen in the hero. */
export default function SocDashboardPage() {
  const can = useAuthStore((s) => s.can);
  const scope = useDashboardScope();
  // The API fences security tickets behind soc:read; the page says so instead of showing an error.
  const allowed = can('soc:read');
  const q = useSocDashboard(scope, allowed);
  return (
    <DashboardFrame title="Security operations" subtitle="Security incidents, severity and SIEM activity" period={q.data?.period} generatedAt={q.data?.generatedAt} fetching={q.isFetching} refreshNote="Live · refreshes every minute">
      {(s) => (allowed ? <SocDashboard days={s.days} customerId={s.customerId} /> : <EmptyState title="Security data is fenced" description="This dashboard reads security tickets, which need the security read permission. Ask your administrator for it." />)}
    </DashboardFrame>
  );
}
