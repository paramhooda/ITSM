import { useEffect, useMemo, useState } from 'react';
import { EmptyState, Select } from '@/components/ui';
import { useCustomersLookup } from '@/hooks/useLookups';
import { DashboardHero, PeriodPicker } from '@/components/dashboards/Hero';
import { useAuthStore } from '@/stores/auth';
import { useListState } from '@/hooks/useListState';
import { CustomerDashboard } from '@/components/dashboards/CustomerDashboard';
import { ManagementDashboard } from '@/components/dashboards/ManagementDashboard';
import { NocDashboard } from '@/components/dashboards/NocDashboard';
import { SocDashboard } from '@/components/dashboards/SocDashboard';
import { AmcDashboard } from '@/components/dashboards/AmcDashboard';
import { EngineerDashboard } from '@/components/dashboards/EngineerDashboard';
import { Segmented } from '@/components/dashboards/Panel';
import { BriefingCard } from '@/components/dashboards/BriefingCard';

type Tab = 'management' | 'noc' | 'soc' | 'amc' | 'engineer';
const STORAGE_KEY = 'dashboard.tab';
const META: Record<Tab, { label: string; title: string; subtitle: string }> = {
  management: { label: 'Management', title: 'Management overview', subtitle: 'Service delivery, SLA performance and contract health across customers' },
  noc: { label: 'NOC', title: 'Network operations', subtitle: 'Infrastructure incidents, SLA clocks and engineer load' },
  soc: { label: 'SOC', title: 'Security operations', subtitle: 'Security incidents, severity and SIEM activity' },
  amc: { label: 'AMC', title: 'AMC & field service', subtitle: 'AMC ticket queue, site visits and preventive maintenance' },
  engineer: { label: 'My work', title: 'My work', subtitle: 'Your queue, deadlines and schedule for today' },
};
/** Which allowed view opens when nothing was chosen: broadest first, "My work" before AMC. AMC is only ever picked explicitly. */
const DEFAULT_ORDER: Tab[] = ['management', 'noc', 'soc', 'engineer', 'amc'];

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
  const fallback = useMemo(() => DEFAULT_ORDER.find((t) => tabs.includes(t)) ?? 'engineer', [tabs]);
  const [tab, setTab] = useState<Tab>(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    const wanted = (state.view as Tab | undefined) ?? (saved as Tab | null);
    return (wanted && tabs.includes(wanted) ? wanted : fallback) as Tab;
  });
  useEffect(() => {
    const v = state.view as Tab | undefined;
    if (v && tabs.includes(v) && v !== tab) setTab(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.view]);
  useEffect(() => {
    if (!tabs.includes(tab)) setTab(fallback);
  }, [tabs, tab, fallback]);
  const pick = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  };

  const customers = useCustomersLookup();
  if (!user) return null;
  // The same 7 / 30 / 90-day period heads every home view, staff and customer alike.
  const days = Number(state.days ?? 30) || 30;
  const period = <PeriodPicker days={days} onChange={(d) => set({ days: d }, false)} />;
  if (user.userType === 'customer') {
    return (
      <div>
        <DashboardHero title={greeting(user.name)} subtitle="Your tickets, service levels, contracts and upcoming work">
          {period}
        </DashboardHero>
        {can('portal:access') ? <CustomerDashboard days={days} /> : <EmptyState title="Portal access required" description="Ask your administrator to grant portal access." />}
      </div>
    );
  }
  const meta = META[tab];
  const customerId = state.customerId ?? '';
  return (
    <div>
      <DashboardHero title={tab === 'engineer' ? greeting(user.name) : meta.title} subtitle={meta.subtitle} right={tabs.length > 1 ? <Segmented options={tabs.map((t) => ({ value: t, label: META[t].label }))} value={tab} onChange={pick} /> : undefined}>
        {period}
        {/* Global scope: every panel on every staff view follows it. */}
        <span className="text-[12px] text-subtle ml-2 mr-1">Scope</span>
        <Select className="w-56 h-8 py-0 text-[12.5px] bg-white" value={customerId} onChange={(e) => set({ customerId: e.target.value }, false)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} aria-label="Customer scope" />
      </DashboardHero>
      <BriefingCard />
      {tab === 'management' && <ManagementDashboard days={days} customerId={customerId} />}
      {tab === 'noc' && <NocDashboard days={days} customerId={customerId} />}
      {tab === 'soc' && <SocDashboard days={days} customerId={customerId} />}
      {tab === 'amc' && <AmcDashboard days={days} customerId={customerId} />}
      {tab === 'engineer' && <EngineerDashboard days={days} customerId={customerId} />}
    </div>
  );
}
