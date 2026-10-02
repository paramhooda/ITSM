import { useEffect, useMemo, useState } from 'react';
import { PageHeader, EmptyState } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useListState } from '@/hooks/useListState';
import { CustomerDashboard } from '@/components/dashboards/CustomerDashboard';
import { ManagementDashboard, ManagementControls } from '@/components/dashboards/ManagementDashboard';
import { NocDashboard } from '@/components/dashboards/NocDashboard';
import { SocDashboard } from '@/components/dashboards/SocDashboard';
import { AmcDashboard } from '@/components/dashboards/AmcDashboard';
import { EngineerDashboard } from '@/components/dashboards/EngineerDashboard';
import { Segmented } from '@/components/dashboards/Panel';

type Tab = 'management' | 'noc' | 'soc' | 'amc' | 'engineer';
const STORAGE_KEY = 'dashboard.tab';
const META: Record<Tab, { label: string; title: string; subtitle: string }> = {
  management: { label: 'Management', title: 'Management overview', subtitle: 'Service delivery, SLA performance and commercial signals across customers' },
  noc: { label: 'NOC', title: 'Network operations', subtitle: 'Infrastructure incidents, SLA clocks and engineer load' },
  soc: { label: 'SOC', title: 'Security operations', subtitle: 'Security incidents, severity and SIEM activity' },
  amc: { label: 'AMC', title: 'AMC & field service', subtitle: 'AMC ticket queue, site visits and preventive maintenance' },
  engineer: { label: 'My work', title: 'My work', subtitle: 'Your queue, deadlines and schedule for today' },
};

function greeting(name: string) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name.split(' ')[0]}`;
}

/** Role-aware landing page: customer users get their portal overview, MSP users the views they may see. */
export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const { state, set } = useListState();
  const tabs = useMemo(() => {
    const list: Tab[] = [];
    if (can('dashboards:management')) list.push('management');
    if (can('dashboards:noc')) list.push('noc');
    if (can('dashboards:soc') && can('soc:read')) list.push('soc');
    if (can('dashboards:amc')) list.push('amc');
    list.push('engineer');
    return list;
  }, [can]);
  const [tab, setTab] = useState<Tab>(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    const wanted = (state.view as Tab | undefined) ?? (saved as Tab | null);
    return (wanted && tabs.includes(wanted) ? wanted : tabs[0] ?? 'engineer') as Tab;
  });
  useEffect(() => {
    const v = state.view as Tab | undefined;
    if (v && tabs.includes(v) && v !== tab) setTab(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.view]);
  useEffect(() => {
    if (!tabs.includes(tab)) setTab(tabs[0] ?? 'engineer');
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
        <PageHeader title={greeting(user.name)} subtitle="Your tickets, service levels, contracts and upcoming work" />
        {can('portal:access') ? <CustomerDashboard /> : <EmptyState title="Portal access required" description="Ask your administrator to grant portal access." />}
      </div>
    );
  }
  const days = Number(state.days ?? 30) || 30;
  const meta = META[tab];
  return (
    <div>
      <PageHeader
        title={meta.title}
        subtitle={meta.subtitle}
        actions={
          <div className="flex flex-wrap items-center gap-2 justify-end">
            {tab === 'management' && <ManagementControls days={days} customerId={state.customerId ?? ''} onDays={(d) => set({ days: d }, false)} onCustomer={(id) => set({ customerId: id }, false)} />}
            {tabs.length > 1 && <Segmented options={tabs.map((t) => ({ value: t, label: META[t].label }))} value={tab} onChange={pick} />}
          </div>
        }
      />
      {tab === 'management' && <ManagementDashboard days={days} customerId={state.customerId ?? ''} />}
      {tab === 'noc' && <NocDashboard />}
      {tab === 'soc' && <SocDashboard />}
      {tab === 'amc' && <AmcDashboard />}
      {tab === 'engineer' && <EngineerDashboard />}
    </div>
  );
}
