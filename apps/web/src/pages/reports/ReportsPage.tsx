import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Download, FileText, FileSpreadsheet, Printer, CalendarClock, Plus, Pencil, Trash2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, ModuleNav, Tabs, Card, Button, Drawer, DataTable, Badge, Pagination, Select, ConfirmDialog, LoadingBlock, EmptyState, type Column } from '@/components/ui';
import { REPORT_MODULES } from '@/layouts/modules';
import { get, post, patch, del, download, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { REPORT_VISIBILITY_COLORS } from '@/lib/statusColors';
import { SpecSummary } from '@/components/reports/builder/SpecSummary';
import { ReportPicker } from '@/components/reports/ReportPicker';
import { ParameterForm, type ParamValues } from '@/components/reports/ParameterForm';
import { ReportPreview } from '@/components/reports/ReportPreview';
import { ScheduleForm, type SchedulePayload } from '@/components/reports/ScheduleForm';
import { RunsTable } from '@/components/reports/RunsTable';
import { FREQUENCIES, VISIBILITY_LABELS, visibilityOf, type ReportDefinition, type RunPreview, type ReportRun, type Schedule, type Paginated, type FileFormat } from '@/components/reports/types';

type Tab = 'run' | 'schedules' | 'history';

export default function ReportsPage() {
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const navigate = useNavigate();
  const isCustomer = user?.userType === 'customer';
  const canManage = !isCustomer && can('reports:manage');
  const canBuild = !isCustomer && can('reports:build');
  const { state, set, page, pageSize, setPage } = useListState({ tab: 'run' });
  const tab = (['run', 'schedules', 'history'].includes(state.tab) ? state.tab : 'run') as Tab;
  const defs = useQuery({ queryKey: ['reports', 'definitions'], queryFn: () => get<{ items: ReportDefinition[]; customerId: string | null; canManage: boolean; pdf: boolean }>('/reports/definitions'), staleTime: 5 * 60_000 });
  const tabs = useMemo(() => [{ key: 'run' as Tab, label: 'Run a report' }, ...(canManage ? [{ key: 'schedules' as Tab, label: 'Schedules' }] : []), { key: 'history' as Tab, label: 'History' }], [canManage]);
  const [scheduleDraft, setScheduleDraft] = useState<Partial<Schedule> | null>(null);
  return (
    <div>
      <PageHeader title="Reports" subtitle={isCustomer ? 'Service reports for your organization' : 'Ad-hoc reporting, custom reports, scheduled customer reports and history'} actions={canBuild ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/reports/builder')}>New custom report</Button> : undefined} />
      <ModuleNav items={REPORT_MODULES} />
      <Tabs tabs={tabs} value={tab} onChange={(t) => set({ tab: t }, false)} className="mb-4" />
      {defs.isPending && <LoadingBlock />}
      {defs.data && tab === 'run' && <RunTab definitions={defs.data.items} isCustomer={!!isCustomer} canManage={canManage} pdf={defs.data.pdf} initialKey={state.report} onSaveAsSchedule={(d) => { setScheduleDraft(d); set({ tab: 'schedules' }, false); }} />}
      {defs.data && tab === 'schedules' && canManage && <SchedulesTab definitions={defs.data.items} pdf={defs.data.pdf} draft={scheduleDraft} clearDraft={() => setScheduleDraft(null)} />}
      {defs.data && tab === 'history' && <HistoryTab definitions={defs.data.items} isCustomer={!!isCustomer} canManage={canManage} page={page} pageSize={pageSize} setPage={setPage} filters={{ reportKey: state.reportKey, customerId: state.customerId }} setFilters={(f) => set(f)} />}
    </div>
  );
}

// ---------------------------------------------------------------- run

function RunTab({ definitions, isCustomer, canManage, pdf, initialKey, onSaveAsSchedule }: { definitions: ReportDefinition[]; isCustomer: boolean; canManage: boolean; pdf: boolean; initialKey?: string; onSaveAsSchedule: (d: Partial<Schedule>) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [key, setKey] = useState<string | null>(initialKey && definitions.some((d) => d.key === initialKey) ? initialKey : definitions[0]?.key ?? null);
  const [params, setParams] = useState<ParamValues>({});
  const [preview, setPreview] = useState<RunPreview | null>(null);
  const def = definitions.find((d) => d.key === key) ?? null;
  useEffect(() => {
    setParams({});
    setPreview(null);
  }, [key]);
  const run = useMutation({
    mutationFn: () => post<RunPreview>('/reports/run', { reportKey: key, parameters: params, format: 'json' }),
    onSuccess: (p) => setPreview(p),
    onError: (e: ApiError) => toast.error(e.message),
  });
  const file = useMutation({
    mutationFn: (format: FileFormat) => post<ReportRun>('/reports/run', { reportKey: key, parameters: params, format }),
    onSuccess: async (r) => {
      qc.invalidateQueries({ queryKey: ['reports', 'runs'] });
      if (r.attachmentId) await download(`/attachments/${r.attachmentId}/download`, r.filename ?? `${r.name}.${r.format}`);
      toast.success(`${r.format.toUpperCase()} generated (${r.rowCount ?? 0} rows)`);
    },
    onError: (e: ApiError) => toast.error(e.message),
  });
  if (!definitions.length) return <EmptyState title="No reports available" description="You do not have permission to run any report." />;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 items-start">
      <Card padded className="lg:sticky lg:top-4">
        <ReportPicker definitions={definitions} value={key} onChange={setKey} />
      </Card>
      <div className="flex flex-col gap-4 min-w-0">
        {def && (
          <Card title={def.name} actions={<><Badge color="slate">{def.category}</Badge>{def.custom?.canEdit && <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => navigate(`/reports/builder/${def.custom!.id}`)}>Edit in builder</Button>}</>}>
            {!(def.custom && def.description === def.custom.summaryLines.join('; ')) && <p className="text-[13px] text-muted mb-3">{def.description}</p>}
            {def.custom && (
              <div className="mb-3 flex flex-col gap-1.5" data-custom-info>
                {def.custom.visibility !== null && (
                  <div className="text-[12.5px] text-muted flex flex-wrap items-center gap-1.5">
                    {def.custom.ownerName && <span>Built by {def.custom.ownerName}</span>}
                    {def.custom.ownerName && <span className="text-subtle">·</span>}
                    <Badge color={REPORT_VISIBILITY_COLORS[visibilityOf({ visibility: def.custom.visibility, portalVisible: def.custom.portalVisible })]}>{VISIBILITY_LABELS[visibilityOf({ visibility: def.custom.visibility, portalVisible: def.custom.portalVisible })]}</Badge>
                    {def.custom.visibility === 'shared' && def.custom.sharedWith && def.custom.sharedWith.length > 0 && <span>shared with {def.custom.sharedWith.join(', ')}</span>}
                  </div>
                )}
                <SpecSummary lines={def.custom.summaryLines} />
              </div>
            )}
            <ParameterForm definition={def} value={params} onChange={setParams} hide={isCustomer ? ['customer'] : []} />
            <div className="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-default">
              <Button icon={<Play className="h-4 w-4" />} loading={run.isPending} onClick={() => run.mutate()}>Run</Button>
              <Button variant="outline" icon={<Printer className="h-4 w-4" />} loading={file.isPending && file.variables === 'pdf'} disabled={!pdf || file.isPending} title={pdf ? 'A4 document with cover, executive summary, insights and appendix' : 'PDF output needs Chromium on the server (see Operations)'} onClick={() => file.mutate('pdf')}>Download PDF</Button>
              <Button variant="outline" icon={<FileSpreadsheet className="h-4 w-4" />} loading={file.isPending && file.variables === 'xlsx'} disabled={file.isPending} title="Excel workbook: one sheet per part" onClick={() => file.mutate('xlsx')}>Download Excel</Button>
              <Button variant="outline" icon={<Download className="h-4 w-4" />} loading={file.isPending && file.variables === 'csv'} disabled={file.isPending} onClick={() => file.mutate('csv')}>Download CSV</Button>
              <Button variant="outline" icon={<FileText className="h-4 w-4" />} loading={file.isPending && file.variables === 'html'} disabled={file.isPending} onClick={() => file.mutate('html')}>Download HTML</Button>
              {canManage && (
                <Button variant="ghost" icon={<CalendarClock className="h-4 w-4" />} onClick={() => onSaveAsSchedule({ reportKey: def.key, name: `${def.name} – weekly`, customerId: (params.customerId as string) || null, dateRange: typeof params.dateRange === 'string' && params.dateRange !== 'custom' ? params.dateRange : 'last_7_days', filters: Object.fromEntries(Object.entries(params).filter(([k]) => !['customerId', 'dateRange', 'from', 'to'].includes(k))) })}>
                  Save as schedule
                </Button>
              )}
              {preview && <span className="text-[12px] text-subtle ml-auto">{preview.period.label}</span>}
            </div>
          </Card>
        )}
        {run.isPending && <LoadingBlock label="Running report…" />}
        {preview && !run.isPending && <ReportPreview preview={preview} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- schedules

function SchedulesTab({ definitions, pdf, draft, clearDraft }: { definitions: ReportDefinition[]; pdf: boolean; draft: Partial<Schedule> | null; clearDraft: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['reports', 'schedules'], queryFn: () => get<{ items: Schedule[] }>('/reports/schedules') });
  const [editing, setEditing] = useState<Partial<Schedule> | null>(draft);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  useEffect(() => {
    if (draft) setEditing(draft);
  }, [draft]);
  const close = () => {
    setEditing(null);
    clearDraft();
  };
  const invalidate = () => qc.invalidateQueries({ queryKey: ['reports'] });
  const save = useMutation({
    mutationFn: (p: SchedulePayload) => (editing?.id ? patch<Schedule>(`/reports/schedules/${editing.id}`, p) : post<Schedule>('/reports/schedules', p)),
    onSuccess: (s) => {
      invalidate();
      toast.success(`Schedule "${s.name}" saved · next run ${s.nextRunAt ? fmtDateTime(s.nextRunAt) : 'paused'}`);
      close();
    },
    onError: (e: ApiError) => toast.error(e.message),
  });
  const runNow = useMutation({
    mutationFn: (id: string) => post<{ queued: boolean }>(`/reports/schedules/${id}/run-now`, {}),
    onSuccess: (r) => {
      toast.success(r.queued ? 'Queued on the worker; check History in a moment' : 'Could not queue the run');
      setTimeout(invalidate, 4000);
    },
    onError: (e: ApiError) => toast.error(e.message),
  });
  const toggle = useMutation({ mutationFn: (s: Schedule) => patch(`/reports/schedules/${s.id}`, { isActive: !s.isActive }), onSuccess: invalidate, onError: (e: ApiError) => toast.error(e.message) });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/reports/schedules/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
      toast.success('Schedule deleted');
    },
    onError: (e: ApiError) => toast.error(e.message),
  });
  const columns: Column<Schedule>[] = [
    { key: 'name', header: 'Name', render: (s) => <div className="min-w-0"><div className="font-medium truncate">{s.name}</div><div className="text-[11px] text-subtle">{s.reportName} · {s.format.toUpperCase()} · {s.delivery}</div></div> },
    { key: 'customer', header: 'Customer', render: (s) => <span className="text-muted">{s.customerName ?? (s.filters?.perCustomer ? <span>Every active customer</span> : <span className="text-subtle">MSP-wide</span>)}</span> },
    { key: 'frequency', header: 'Frequency', render: (s) => <span className="text-muted">{s.frequency === 'cron' ? <span className="font-mono text-[12px]">{s.cronExpression}</span> : FREQUENCIES.find((f) => f.value === s.frequency)?.label.split(' (')[0]}<span className="text-subtle"> · {s.timezone}</span></span> },
    { key: 'nextRunAt', header: 'Next run', render: (s) => <span className="text-muted whitespace-nowrap">{s.isActive && s.nextRunAt ? fmtDateTime(s.nextRunAt) : <span className="text-subtle">paused</span>}</span> },
    { key: 'lastRunAt', header: 'Last run', render: (s) => (s.lastRunAt ? <span className="whitespace-nowrap">{relativeTime(s.lastRunAt)} {s.lastRunStatus && <Badge color={s.lastRunStatus === 'completed' ? 'green' : s.lastRunStatus === 'failed' ? 'red' : 'slate'}>{s.lastRunStatus}</Badge>}</span> : <span className="text-subtle">never</span>) },
    { key: 'recipients', header: 'Recipients', render: (s) => { const n = s.recipients.length + s.recipientUsers.length; return <span className="text-muted text-[12px]" title={[...s.recipients, ...s.recipientUsers.map((u) => u.email)].join(', ')}>{n} {n === 1 ? 'recipient' : 'recipients'}{s.filters?.customerContacts ? ' + contacts' : ''}</span>; } },
    { key: 'isActive', header: 'Active', render: (s) => <Badge color={s.isActive ? 'green' : 'slate'}>{s.isActive ? 'active' : 'paused'}</Badge> },
    {
      key: 'actions', header: '', className: 'text-right whitespace-nowrap',
      render: (s) => (
        <div className="inline-flex items-center gap-1">
          <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={runNow.isPending && runNow.variables === s.id} onClick={() => runNow.mutate(s.id)}>Run now</Button>
          <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(s)}><Pencil className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="ghost" onClick={() => toggle.mutate(s)}>{s.isActive ? 'Pause' : 'Resume'}</Button>
          <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => setDeleting(s)}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end"><Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({})}>New schedule</Button></div>
      <Card padded={false}>
        <DataTable columns={columns} rows={q.data?.items ?? []} loading={q.isPending} empty={<EmptyState title="No scheduled reports" description="Create a schedule to deliver reports to customers and managers automatically." action={<Button onClick={() => setEditing({})}>New schedule</Button>} />} />
      </Card>
      <Drawer open={!!editing} onClose={close} title={editing?.id ? 'Edit schedule' : 'New schedule'} width="max-w-2xl">
        {editing && <ScheduleForm definitions={definitions} pdf={pdf} initial={editing} saving={save.isPending} onCancel={close} onSubmit={(p) => save.mutate(p)} />}
      </Drawer>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting.id)} title="Delete schedule?" description={`"${deleting?.name}" will no longer run. Past report runs are kept.`} confirmLabel="Delete" danger loading={remove.isPending} />
    </div>
  );
}

// ---------------------------------------------------------------- history

function HistoryTab({ definitions, isCustomer, canManage, page, pageSize, setPage, filters, setFilters }: { definitions: ReportDefinition[]; isCustomer: boolean; canManage: boolean; page: number; pageSize: number; setPage: (p: number) => void; filters: { reportKey?: string; customerId?: string }; setFilters: (f: Record<string, string | undefined>) => void }) {
  const qc = useQueryClient();
  const customers = useCustomersLookup();
  const q = useQuery({ queryKey: ['reports', 'runs', filters, page, pageSize], queryFn: () => get<Paginated<ReportRun>>('/reports/runs', { ...filters, page, pageSize }), placeholderData: (p) => p, refetchInterval: 30_000 });
  const [deleting, setDeleting] = useState<ReportRun | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['reports', 'runs'] });
  const visible = useMutation({ mutationFn: ({ run, v }: { run: ReportRun; v: boolean }) => patch(`/reports/runs/${run.id}`, { portalVisible: v }), onSuccess: invalidate, onError: (e: ApiError) => toast.error(e.message) });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/reports/runs/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
      toast.success('Report run deleted');
    },
    onError: (e: ApiError) => toast.error(e.message),
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-64" value={filters.reportKey ?? ''} onChange={(e) => setFilters({ reportKey: e.target.value || undefined })} placeholder="All reports" options={definitions.map((d) => ({ value: d.key, label: d.name }))} />
        {!isCustomer && <Select className="w-64" value={filters.customerId ?? ''} onChange={(e) => setFilters({ customerId: e.target.value || undefined })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} />}
        <span className="text-[12px] text-subtle ml-auto">{q.data ? `${q.data.total} runs` : ''}</span>
      </div>
      <Card padded={false}>
        <RunsTable runs={q.data?.items ?? []} loading={q.isPending} canManage={canManage} isCustomer={isCustomer} onToggleVisible={(run, v) => visible.mutate({ run, v })} onDelete={setDeleting} />
        {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
      </Card>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting.id)} title="Delete report run?" description="The generated file will be removed as well." confirmLabel="Delete" danger loading={remove.isPending} />
    </div>
  );
}
