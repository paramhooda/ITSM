import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Gavel, CalendarClock, CheckCircle2 } from 'lucide-react';
import { PageHeader, DataTable, Pagination, EmptyState, ErrorBlock, Badge, Button, ListShell, FilterGroup, FilterOptions, type AppliedFilter, type Column } from '@/components/ui';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { FormDialog, type FieldSpec } from '@/components/admin/FormDialog';
import { useListState } from '@/hooks/useListState';
import { useEngineers } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { CHANGE_MODULES } from '@/layouts/modules';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { changesApi, changeKeys, type CabMeeting } from '@/components/changes/api';

const STATUS_OPTIONS = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'closed', label: 'Closed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'Everything' },
];
export const CAB_STATUS_COLOR: Record<string, string> = { scheduled: 'blue', in_progress: 'amber', closed: 'green', cancelled: 'slate' };
export const CAB_STATUS_LABEL: Record<string, string> = { scheduled: 'Scheduled', in_progress: 'In progress', closed: 'Closed', cancelled: 'Cancelled' };
type Values = Record<string, unknown>;

/** The change advisory board's meetings: agenda, decisions and minutes. */
export default function CabMeetingsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const { state, set, page, pageSize } = useListState({ status: 'upcoming', pageSize: '25' });
  const engineers = useEngineers();
  const params = useMemo(() => ({ status: state.status || 'upcoming', q: state.q || undefined, page, pageSize }), [state.status, state.q, page, pageSize]);
  const q = useQuery({ queryKey: changeKeys.meetings(params), queryFn: () => changesApi.meetings(params), placeholderData: (p) => p });
  const [creating, setCreating] = useState(false);
  const create = useMutation({
    mutationFn: (v: Values) => changesApi.createMeeting({ title: String(v.title), scheduledAt: new Date(String(v.scheduledAt)).toISOString(), chairUserId: (v.chairUserId as string) || null }),
    onSuccess: (m) => {
      toast.success('Meeting created');
      void qc.invalidateQueries({ queryKey: ['cab'] });
      navigate(`/operations/cab/${m.id}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const data = q.data;
  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode) => applied.push({ key, label, onRemove: () => set({ [key]: undefined }) });
  if (state.status && state.status !== 'upcoming') addApplied('status', `State: ${STATUS_OPTIONS.find((s) => s.value === state.status)?.label ?? state.status}`);

  const columns: Column<CabMeeting>[] = [
    { key: 'title', header: 'Meeting', width: '100%', render: (r) => <div className="min-w-0"><div className="font-medium truncate">{r.title}</div><div className="text-[11.5px] text-muted">{r.chairName ? `Chair: ${r.chairName}` : 'No chair set'}</div></div> },
    { key: 'scheduledAt', header: 'When', width: '200px', render: (r) => <div className="text-[12.5px]"><div>{fmtDateTime(r.scheduledAt)}</div><div className="text-[11.5px] text-muted">{relativeTime(r.scheduledAt)}</div></div> },
    { key: 'status', header: 'State', width: '120px', render: (r) => <Badge color={CAB_STATUS_COLOR[r.status] ?? 'slate'} dot>{CAB_STATUS_LABEL[r.status] ?? r.status}</Badge> },
    { key: 'items', header: 'Agenda', width: '150px', render: (r) => <span className="text-[12.5px] tabular-nums">{r.items} change{r.items === 1 ? '' : 's'}{r.pending ? <span className="text-amber-700"> · {r.pending} pending</span> : ''}</span> },
  ];
  const fields: FieldSpec<Values>[] = [
    { key: 'title', label: 'Title', type: 'text', required: true, span: 2, placeholder: 'Weekly CAB' },
    { key: 'scheduledAt', label: 'When', type: 'datetime', required: true },
    { key: 'chairUserId', label: 'Chair', type: 'select', options: (engineers.data ?? []).map((e) => ({ value: e.id, label: e.name })), hint: 'Defaults to you' },
  ];
  const summary = data ? { upcoming: data.items.filter((m) => m.status === 'scheduled' || m.status === 'in_progress').length, pending: data.items.reduce((n, m) => n + m.pending, 0), closed: data.items.filter((m) => m.status === 'closed').length } : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Change advisory board" subtitle="Meetings with their agenda of changes, the decisions taken and the minutes" actions={can('changes:cab') ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New meeting</Button> : undefined} />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
      <ListShell
        id="cab-meetings"
        modules={CHANGE_MODULES}
        filters={
          <FilterGroup label="State">
            <FilterOptions options={STATUS_OPTIONS} value={state.status || 'upcoming'} onChange={(v) => set({ status: (v as string | undefined) ?? 'upcoming' })} />
          </FilterGroup>
        }
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Meeting title…' }}
        applied={applied}
        activeCount={applied.length}
        onClear={() => set({ status: undefined, q: undefined })}
        insights={
          summary && (
            <KpiGrid
              columns={3}
              items={[
                { label: 'Upcoming meetings', value: summary.upcoming, icon: <CalendarClock className="h-4 w-4" />, hint: 'scheduled or in progress' },
                { label: 'Changes awaiting a decision', value: summary.pending, tone: summary.pending ? 'warn' : 'good', icon: <Gavel className="h-4 w-4" />, hint: 'on the agenda, not yet decided' },
                { label: 'Closed in this list', value: summary.closed, icon: <CheckCircle2 className="h-4 w-4" />, hint: 'minutes recorded' },
              ]}
            />
          )
        }
        count={data ? `${data.total} meeting${data.total === 1 ? '' : 's'}` : undefined}
      >
        <div className="card overflow-x-auto">
          <DataTable columns={columns} rows={data?.items ?? []} loading={q.isLoading} dense onRowClick={(r) => navigate(`/operations/cab/${r.id}`)} empty={<EmptyState icon={<Gavel className="h-5 w-5" />} title="No CAB meetings" description="Create a meeting and put the changes awaiting a decision on its agenda." action={can('changes:cab') ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New meeting</Button> : undefined} />} />
          {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set({ page: p }, false)} />}
        </div>
      </ListShell>
      <FormDialog<Values> open={creating} onClose={() => setCreating(false)} title="New CAB meeting" fields={fields} initial={{ title: '', scheduledAt: '', chairUserId: '' }} onSubmit={(v) => create.mutateAsync(v).then(() => undefined)} submitLabel="Create" />
    </div>
  );
}
