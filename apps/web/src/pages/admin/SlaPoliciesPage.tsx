import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Pencil, Copy, Trash2, Star } from 'lucide-react';
import { get, post, del } from '@/api/client';
import { Button, Badge, type Column } from '@/components/ui';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MutedCell } from '@/components/admin/ConfigTable';
import { useAdminMutation } from '@/components/admin/api';

export interface SlaTarget {
  id?: string;
  ticketType: string;
  priorityId: string | null;
  priorityLabel?: string | null;
  metric: string;
  minutes: number;
  warnPct: number;
  calendarTime: boolean;
}

export interface SlaPolicy {
  id: string;
  name: string;
  description: string | null;
  calendarId: string | null;
  calendarName: string | null;
  calendarIs24x7: boolean | null;
  holidayCalendarId: string | null;
  holidayCalendarName: string | null;
  isDefault: boolean;
  isActive: boolean;
  targets: SlaTarget[];
  pauseStatusIds: string[];
  pauseStatuses: { id: string; label: string }[];
  usage: { contracts: number; contractServices: number; catalogItems: number; services: number; tickets: number };
}

export const useSlaPolicies = () => useQuery({ queryKey: ['sla', 'policies'], queryFn: () => get<{ items: SlaPolicy[] }>('/sla/policies') });

export function usageSummary(u: SlaPolicy['usage']) {
  const parts: string[] = [];
  if (u.contracts) parts.push(`${u.contracts} contract${u.contracts > 1 ? 's' : ''}`);
  if (u.contractServices) parts.push(`${u.contractServices} contract service${u.contractServices > 1 ? 's' : ''}`);
  if (u.services) parts.push(`${u.services} service${u.services > 1 ? 's' : ''}`);
  if (u.catalogItems) parts.push(`${u.catalogItems} catalog item${u.catalogItems > 1 ? 's' : ''}`);
  if (u.tickets) parts.push(`${u.tickets} ticket${u.tickets > 1 ? 's' : ''}`);
  return parts.length ? parts.join(', ') : 'Not referenced';
}

export default function SlaPoliciesPage() {
  const navigate = useNavigate();
  const q = useSlaPolicies();
  const invalidate = [['sla'], ['sla', 'policies']];
  const clone = useAdminMutation((id: string) => post<SlaPolicy>(`/sla/policies/${id}/clone`, {}), { invalidate, lookups: true, success: 'Policy cloned', onSuccess: (p) => navigate(`/admin/sla/${p.id}`) });
  const remove = useAdminMutation((id: string) => del(`/sla/policies/${id}`), { invalidate, lookups: true, success: 'Policy deleted' });

  const columns: Column<SlaPolicy>[] = [
    { key: 'name', header: 'Policy', render: (r) => (
      <div>
        <div className="inline-flex items-center gap-2 font-medium">
          {r.name}
          {r.isDefault && <Badge color="amber"><Star className="h-3 w-3" /> default</Badge>}
        </div>
        {r.description && <div className="text-[12px] text-muted truncate max-w-md">{r.description}</div>}
      </div>
    ) },
    { key: 'calendar', header: 'Calendar', render: (r) => <MutedCell>{r.calendarName ?? 'Platform default'}{r.holidayCalendarName ? ` · ${r.holidayCalendarName}` : ''}</MutedCell> },
    { key: 'targets', header: 'Targets', render: (r) => <span>{r.targets.length}</span> },
    { key: 'pause', header: 'Pause statuses', render: (r) => <MutedCell>{r.pauseStatuses.length ? r.pauseStatuses.map((s) => s.label).join(', ') : 'Status defaults'}</MutedCell> },
    { key: 'usage', header: 'Used by', render: (r) => <MutedCell>{usageSummary(r.usage)}</MutedCell> },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  return (
    <div>
      <SectionHeader
        title="SLA policies"
        description="Targets per ticket type, priority and metric. Policy selection order: catalog item → contract service → contract → service default → platform default."
        actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/admin/sla/new')}>New policy</Button>}
      />
      <ConfigTable<SlaPolicy>
        columns={columns}
        rows={q.data?.items ?? []}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={(r) => navigate(`/admin/sla/${r.id}`)}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: (r) => navigate(`/admin/sla/${r.id}`) },
          { label: 'Clone', icon: <Copy className="h-4 w-4" />, inline: true, onClick: (r) => clone.mutate(r.id) },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, disabled: (r) => r.isDefault, onClick: (r) => { if (confirm(`Delete policy "${r.name}"?`)) remove.mutate(r.id); } },
        ]}
      />
    </div>
  );
}
