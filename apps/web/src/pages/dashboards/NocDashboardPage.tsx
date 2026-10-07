import { DashboardFrame, useDashboardScope } from '@/components/dashboards/DashboardFrame';
import { NocDashboard, useNocDashboard } from '@/components/dashboards/NocDashboard';

/** Network operations: every panel follows the period, the customer scope and the NOC team chosen in the hero. */
export default function NocDashboardPage() {
  const scope = useDashboardScope();
  const q = useNocDashboard(scope);
  return (
    <DashboardFrame title="Network operations" subtitle="Infrastructure incidents, SLA clocks and engineer load" teams={q.data?.teams ?? []} teamLabel="Team" teamPlaceholder="All NOC teams" period={q.data?.period} generatedAt={q.data?.generatedAt} fetching={q.isFetching} refreshNote="Live · refreshes every minute">
      {(s) => <NocDashboard days={s.days} customerId={s.customerId} teamId={s.teamId} />}
    </DashboardFrame>
  );
}
