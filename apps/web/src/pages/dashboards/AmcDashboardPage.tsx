import { DashboardFrame, useDashboardScope } from '@/components/dashboards/DashboardFrame';
import { AmcDashboard, useAmcDashboard } from '@/components/dashboards/AmcDashboard';

/** AMC and field service: the AMC ticket queue, site visits and preventive maintenance under the hero's period and scope. */
export default function AmcDashboardPage() {
  const scope = useDashboardScope();
  const q = useAmcDashboard(scope);
  return (
    <DashboardFrame title="AMC & field service" subtitle="AMC ticket queue, site visits and preventive maintenance" period={q.data?.period} generatedAt={q.data?.generatedAt} fetching={q.isFetching} refreshNote="Refreshes every two minutes">
      {(s) => <AmcDashboard days={s.days} customerId={s.customerId} />}
    </DashboardFrame>
  );
}
