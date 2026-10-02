import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { get } from '@/api/client';
import { Button, Tabs } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useAuthStore } from '@/stores/auth';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { integrationTypesQuery } from '@/components/integrations/IntegrationForm';
import type { Integration } from '@/components/integrations/types';
import { EventsTab } from './EventsTab';
import { IntegrationsTab } from './IntegrationsTab';
import { OverviewTab } from './OverviewTab';

type Tab = 'events' | 'integrations' | 'overview';

/** Monitoring & SIEM: inbound events from PRTG / FortiSIEM / webhooks, their correlation to customers, CIs and tickets, and the integrations themselves. */
export default function IntegrationsPage() {
  const { state, set } = useListState({ tab: 'events' });
  const can = useAuthStore((s) => s.can);
  const tab = (state.tab as Tab) ?? 'events';
  const integrations = useQuery({ queryKey: ['integrations', 'list'], queryFn: () => get<{ items: Integration[] }>('/integrations'), refetchInterval: 30_000 });
  const types = useQuery(integrationTypesQuery());
  const items = integrations.data?.items ?? [];
  const unresolved = items.reduce((n, i) => n + (i.counts?.unresolved7d ?? 0), 0);
  /** Bumped by the header button; the Integrations tab opens its editor when it changes. */
  const [newRequest, setNewRequest] = useState(0);

  return (
    <div>
      <SectionHeader
        title="Monitoring & SIEM"
        description="Events from PRTG, FortiSIEM and other sources, correlated to customers, configuration items and tickets."
        actions={can('integrations:manage') ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => { if (tab !== 'integrations') set({ tab: 'integrations', page: undefined }, false); setNewRequest((n) => n + 1); }}>New integration</Button> : undefined}
      />
      <Tabs<Tab>
        className="mb-4"
        value={tab}
        onChange={(t) => set({ tab: t, page: undefined }, false)}
        tabs={[
          { key: 'events', label: 'Events', count: unresolved || undefined },
          { key: 'integrations', label: 'Integrations', count: items.length || undefined },
          { key: 'overview', label: 'Overview' },
        ]}
      />
      {tab === 'events' && <EventsTab integrations={items} />}
      {tab === 'integrations' && <IntegrationsTab integrations={items} types={types.data?.items ?? []} loading={integrations.isLoading || types.isLoading} newRequest={newRequest} />}
      {tab === 'overview' && <OverviewTab onShowEvents={(filter) => set({ tab: 'events', q: undefined, host: undefined, integrationId: undefined, integrationType: undefined, customerId: state.customerId, processingStatus: undefined, severity: undefined, unresolvedOnly: undefined, range: state.days === '1' ? '1' : state.days === '30' ? '30' : '7', ...filter })} />}
      {!can('integrations:manage') && tab === 'integrations' && <div className="mt-3 text-xs text-subtle">You can view integrations; configuring them requires the integrations:manage permission.</div>}
    </div>
  );
}
