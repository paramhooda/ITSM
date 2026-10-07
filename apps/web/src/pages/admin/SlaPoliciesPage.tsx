import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Pencil, Trash2, Star, Copy, FileSignature } from 'lucide-react';
import { post, del } from '@/api/client';
import { Button, Badge, type Column } from '@/components/ui';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { useAdminMutation } from '@/components/admin/api';
import { formatDuration } from '@/components/admin/DurationInput';
import { PolicyDrawer } from '@/components/sla/PolicyDrawer';
import { useSlaPolicies, usageSummary, type SlaPolicy } from '@/components/sla/api';
import { PRIORITY_LEVEL_COLORS } from '@/lib/statusColors';

/**
 * SLA policies are managed here like every other configuration list: the
 * table, "New policy" in the header and one drawer for create and edit.
 * `?new=1`, `?edit=<id>` (and `&tab=`) open the drawer so the Service levels
 * page, contracts and old links can deep-link into the editor; the search and
 * "Include inactive" live in the URL too (`q`, `inactive`) beside them.
 */
export default function SlaPoliciesPage() {
  const [params, setParams] = useSearchParams();
  const q = useSlaPolicies();
  const editId = params.get('edit');
  const isNew = params.get('new') === '1';
  const tab = params.get('tab');

  const openEditor = (id: string | null, nextTab?: string) => {
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('edit');
    next.delete('tab');
    if (id) next.set('edit', id);
    else next.set('new', '1');
    if (nextTab) next.set('tab', nextTab);
    setParams(next, { replace: true });
  };
  const closeEditor = () => {
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('edit');
    next.delete('tab');
    setParams(next, { replace: true });
  };

  const invalidate = [['sla']];
  const clone = useAdminMutation((id: string) => post<SlaPolicy>(`/sla/policies/${id}/clone`, {}), { invalidate, lookups: true, success: 'Policy cloned', onSuccess: (copy) => openEditor(copy.id) });
  const remove = useAdminMutation((id: string) => del(`/sla/policies/${id}`), { invalidate, lookups: true, success: 'Policy deleted' });

  const all = useMemo(() => q.data?.items ?? [], [q.data]);
  const f = useConfigFilter(all, {
    search: [(p) => p.name, (p) => p.description, (p) => p.calendarName, (p) => p.holidayCalendarName, (p) => p.targetSummary?.map((t) => t.priorityLabel)],
    active: (p) => p.isActive,
    noun: ['policy', 'policies'],
    searchPlaceholder: 'Search policies',
  });

  const columns: Column<SlaPolicy>[] = [
    { key: 'name', header: 'Policy', render: (r) => (
      <div className="min-w-0">
        <div className="inline-flex items-center gap-2 font-medium">
          {r.name}
          {r.isDefault && <Badge color="amber"><Star className="h-3 w-3" /> default</Badge>}
        </div>
        <div className="text-[12px] text-muted truncate">
          {r.calendarIs24x7 ? '24x7 clock' : r.calendarName ?? 'Platform default calendar'}
          {r.holidayCalendarName ? ` · ${r.holidayCalendarName}` : ''}
          {r.description ? ` · ${r.description}` : ''}
        </div>
      </div>
    ) },
    { key: 'targets', header: 'Incident targets', render: (r) => {
      const summary = (r.targetSummary ?? []).filter((t) => t.response !== null || t.resolution !== null);
      if (!summary.length) return <MutedCell>{r.targets.length ? `${r.targets.length} targets` : 'No targets yet'}</MutedCell>;
      return (
        <div className="flex flex-wrap gap-1">
          {summary.map((t) => (
            <span key={t.priorityLabel} className="inline-flex items-center gap-1 text-[12px] tnum" title={`${t.priorityLabel}: respond ${t.response !== null ? formatDuration(t.response) : '—'} · resolve ${t.resolution !== null ? formatDuration(t.resolution) : '—'}`}>
              <Badge color={PRIORITY_LEVEL_COLORS[t.priorityLevel ?? 0] ?? 'slate'}>{t.priorityLabel}</Badge>
              <span className="text-muted">{t.response !== null ? formatDuration(t.response) : '—'}/{t.resolution !== null ? formatDuration(t.resolution) : '—'}</span>
            </span>
          ))}
        </div>
      );
    } },
    { key: 'contracts', header: 'Contracts', render: (r) => (
      <div className="tnum">
        <span className={r.usage.contracts + r.usage.contractServices > 0 ? 'font-medium' : 'text-subtle'}>{r.usage.contracts + r.usage.contractServices}</span>
        {r.usage.contractServices > 0 && <span className="text-[12px] text-muted"> · {r.usage.contractServices} per service</span>}
      </div>
    ) },
    { key: 'usage', header: 'Also used by', render: (r) => <MutedCell>{[r.usage.services ? `${r.usage.services} service${r.usage.services > 1 ? 's' : ''}` : null, r.usage.catalogItems ? `${r.usage.catalogItems} catalog item${r.usage.catalogItems > 1 ? 's' : ''}` : null, r.usage.tickets ? `${r.usage.tickets} ticket${r.usage.tickets > 1 ? 's' : ''}` : null].filter(Boolean).join(', ') || '—'}</MutedCell> },
    { key: 'isActive', header: 'Status', render: (r) => <ActiveDot active={r.isActive} /> },
  ];

  return (
    <div>
      <SectionHeader title="SLA policies" description="Response and resolution targets per ticket type and priority. Contracts, services and catalog items pick a policy; one policy is the platform default." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => openEditor(null)}>New policy</Button>} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<SlaPolicy>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={(r) => openEditor(r.id)}
        emptyTitle={f.filtered ? 'No policies match' : 'No SLA policies yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Create a policy with targets per priority, then map contracts to it.'}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: (r) => openEditor(r.id) },
          { label: 'Assign contracts', icon: <FileSignature className="h-4 w-4" />, onClick: (r) => openEditor(r.id, 'contracts') },
          { label: 'Clone', icon: <Copy className="h-4 w-4" />, onClick: (r) => clone.mutate(r.id) },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, disabled: (r) => r.isDefault, confirm: (r) => ({ title: `Delete "${r.name}"?`, description: `Used by ${usageSummary(r.usage)}. Contracts on this policy fall back to their service or the platform default.`, confirmLabel: 'Delete policy' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <PolicyDrawer open={isNew || !!editId} policyId={isNew ? null : editId} initialTab={tab} onClose={closeEditor} onSaved={(id) => openEditor(id)} />
    </div>
  );
}
