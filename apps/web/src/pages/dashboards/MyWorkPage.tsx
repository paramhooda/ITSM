import { useAuthStore } from '@/stores/auth';
import { DashboardFrame, useDashboardScope } from '@/components/dashboards/DashboardFrame';
import { EngineerDashboard, useEngineerDashboard } from '@/components/dashboards/EngineerDashboard';
import { greeting } from '@/components/dashboards/OverviewSections';

/** My work: the person's own queue, deadlines and schedule, with the daily briefing. */
export default function MyWorkPage() {
  const user = useAuthStore((s) => s.user)!;
  const scope = useDashboardScope();
  const q = useEngineerDashboard(scope);
  return (
    <DashboardFrame title={greeting(user.name)} subtitle="Your queue, deadlines and schedule for today" period={q.data?.period} generatedAt={q.data?.generatedAt} fetching={q.isFetching} refreshNote="Refreshes every two minutes" briefing>
      {(s) => <EngineerDashboard days={s.days} customerId={s.customerId} />}
    </DashboardFrame>
  );
}
