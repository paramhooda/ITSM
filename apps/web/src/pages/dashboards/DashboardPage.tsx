import { useEffect, useMemo, useState } from 'react';
import { PageHeader, Tabs, EmptyState } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useListState } from '@/hooks/useListState';
import { CustomerDashboard } from '@/components/dashboards/CustomerDashboard';
import { ManagementDashboard } from '@/components/dashboards/ManagementDashboard';
import { NocDashboard } from '@/components/dashboards/NocDashboard';
import { SocDashboard } from '@/components/dashboards/SocDashboard';
import { EngineerDashboard } from '@/components/dashboards/EngineerDashboard';

type Tab = 'management' | 'noc' | 'soc' | 'engineer';
const STORAGE_KEY = 'dashboard.tab';

/** Role-aware landing page: customer users get their portal overview, MSP users the dashboards they may see. */
export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const { state, set } = useListState();
  const tabs = useMemo(() => {
    const list: { key: Tab; label: string }[] = [];
    if (can('dashboards:management')) list.push({ key: 'management', label: 'Management' });
    if (can('dashboards:noc')) list.push({ key: 'noc', label: 'NOC' });
    if (can('dashboards:soc') && can('soc:read')) list.push({ key: 'soc', label: 'SOC' });
    list.push({ key: 'engineer', label: 'My work' });
    return list;
  }, [can]);
  const [tab, setTab] = useState<Tab>(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    return (tabs.find((t) => t.key === saved)?.key ?? tabs[0]?.key ?? 'engineer') as Tab;
  });
  useEffect(() => {
    if (!tabs.some((t) => t.key === tab)) setTab(tabs[0]?.key ?? 'engineer');
  }, [tabs, tab]);
  const pick = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  };

  if (!user) return null;
  if (user.userType === 'customer') {
    return (
      <div>
        <PageHeader title="Overview" subtitle="Your tickets, service levels, contracts and upcoming work" />
        {can('portal:access') ? <CustomerDashboard /> : <EmptyState title="Portal access required" description="Ask your administrator to grant portal access." />}
      </div>
    );
  }
  const days = Number(state.days ?? 30) || 30;
  return (
    <div>
      <PageHeader title="Dashboard" subtitle={`Welcome back, ${user.name.split(' ')[0]}`} />
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={pick} className="mb-4" />}
      {tab === 'management' && <ManagementDashboard days={days} customerId={state.customerId ?? ''} onDays={(d) => set({ days: d }, false)} onCustomer={(id) => set({ customerId: id }, false)} />}
      {tab === 'noc' && <NocDashboard />}
      {tab === 'soc' && <SocDashboard />}
      {tab === 'engineer' && <EngineerDashboard />}
    </div>
  );
}
