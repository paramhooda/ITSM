import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, RefreshCw, Pencil, Trash2, Power, MessageSquare, Info, Ban } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Badge, LoadingBlock, ErrorBlock, Dialog, ConfirmDialog, DataTable, EmptyState, Pagination, type Column } from '@/components/ui';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RelatedTabs, ActivityStream, RailTabs, RailCard, RailRows, useAuditStream, type FormSection } from '@/components/record';
import { useListState } from '@/hooks/useListState';
import { useAuthStore } from '@/stores/auth';
import { fmtDateTime, fmtNumber, relativeTime, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SourceDrawer } from '@/components/cmdb/SourceDrawer';
import { RunStatusBadge, runSummary, runDurationText } from '@/components/cmdb/DiscoveryBits';
import { FindingsTable } from './FindingsTable';
import { errorMessage, CRON_PRESETS } from '@/components/cmdb/hooks';
import { discoveryApi, discoveryKeys, type DiscoveryRun } from '@/components/cmdb/api';

/** One discovery source as a record: scope and credentials on the form, its runs and findings as related lists. */
export default function SourcePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canManage = can('discovery:manage');
  const { page, pageSize, setPage } = useListState();
  const src = useQuery({ queryKey: discoveryKeys.source(id), queryFn: () => discoveryApi.source(id), enabled: !!id, refetchInterval: 15_000 });
  const providers = useQuery({ queryKey: discoveryKeys.providers, queryFn: () => discoveryApi.providers(), staleTime: 300_000 });
  const runsParams = useMemo(() => ({ page, pageSize: 25 }), [page]);
  const runs = useQuery({ queryKey: discoveryKeys.runs({ sourceId: id, ...runsParams }), queryFn: () => discoveryApi.sourceRuns(id, runsParams), enabled: !!id, refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'queued' || r.status === 'running') ? 3000 : 15_000) });
  const audit = useAuditStream('discovery_source', id);
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const [testResult, setTestResult] = useState<Awaited<ReturnType<typeof discoveryApi.test>> | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: discoveryKeys.all });
  const runNow = useMutation({ mutationFn: () => discoveryApi.runNow(id), onSuccess: (r) => { toast.success('Run queued'); invalidate(); navigate(`/cmdb/discovery/runs/${r.id}`); }, onError: (e) => toast.error(errorMessage(e)) });
  const test = useMutation({ mutationFn: () => discoveryApi.test(id), onSuccess: (r) => setTestResult(r), onError: (e) => toast.error(errorMessage(e)) });
  const toggle = useMutation({ mutationFn: (isActive: boolean) => import('@/api/client').then((m) => m.patch(`/discovery/sources/${id}`, { isActive })), onSuccess: invalidate, onError: (e) => toast.error(errorMessage(e)) });
  const cancel = useMutation({ mutationFn: (runId: string) => discoveryApi.cancelRun(runId), onSuccess: () => { toast.success('Run cancelled'); invalidate(); }, onError: (e) => toast.error(errorMessage(e)) });
  const remove = useMutation({ mutationFn: () => import('@/api/client').then((m) => m.del(`/discovery/sources/${id}`)), onSuccess: () => { toast.success('Source deleted'); invalidate(); navigate('/cmdb/discovery/sources'); }, onError: (e) => toast.error(errorMessage(e)) });

  if (src.isLoading) return <LoadingBlock />;
  if (src.isError || !src.data) return <ErrorBlock error={src.error} retry={() => src.refetch()} />;
  const s = src.data;
  const cfg = s.config;
  const providerLabel = providers.data?.items.find((p) => p.type === s.sourceType)?.label ?? titleCase(s.sourceType.replace(/_/g, ' '));
  const schedule = s.scheduleCron ? CRON_PRESETS.find((p) => p.value === s.scheduleCron)?.label ?? s.scheduleCron : 'Manual only';
  const lastRun = runs.data?.items[0];
  const running = runs.data?.items.find((r) => r.status === 'running' || r.status === 'queued');

  const sections: FormSection[] = [
    {
      key: 'scope',
      title: 'Scope',
      fields: [
        { label: 'Customer', value: s.customerName },
        { label: 'Site', value: s.siteName, hint: 'Discovered CIs are created at this site' },
        { label: 'Provider', value: providerLabel },
        { label: 'Targets', value: <div className="flex flex-wrap gap-1">{cfg.subnets.map((t) => <Badge key={t} color="slate" className="font-mono">{t}</Badge>)}</div>, span: 2 },
        { label: 'TCP ports', value: cfg.ports?.length ? cfg.ports.join(', ') : null, kind: 'mono' },
        { label: 'Max hosts per run', value: fmtNumber(cfg.maxHosts) },
      ],
    },
    {
      key: 'snmp',
      title: 'SNMP',
      fields: [
        { label: 'Version', value: cfg.snmp?.version === '3' ? 'v3 (user security)' : 'v2c (community)' },
        { label: 'Communities', value: cfg.snmp?.version !== '3' ? `${cfg.snmp?.communities?.length ?? 0} stored (encrypted)` : null, hidden: cfg.snmp?.version === '3' },
        { label: 'User', value: cfg.snmp?.v3?.username, hidden: cfg.snmp?.version !== '3' },
        { label: 'Auth / privacy', value: cfg.snmp?.version === '3' ? `${(cfg.snmp.v3?.authProtocol ?? 'none').toUpperCase()} / ${(cfg.snmp.v3?.privProtocol ?? 'none').toUpperCase()}` : null, hidden: cfg.snmp?.version !== '3' },
        { label: 'Always try SNMP', value: cfg.snmpAlways ? 'Yes' : 'Only when a port answers' },
      ],
    },
    {
      key: 'schedule',
      title: 'Scan & schedule',
      fields: [
        { label: 'Schedule', value: schedule },
        { label: 'Cron', value: s.scheduleCron, kind: 'mono', hidden: !s.scheduleCron },
        { label: 'Findings', value: s.autoApply ? <Badge color="green">applied automatically</Badge> : <Badge color="blue">reviewed before applying</Badge> },
        { label: 'Timeout · concurrency', value: `${cfg.timeoutMs} ms · ${cfg.concurrency} hosts at a time` },
        { label: 'Reverse DNS', value: cfg.dnsResolve ? 'Resolve hostnames' : 'Off' },
      ],
    },
  ];

  const runCols: Column<DiscoveryRun>[] = [
    { key: 'status', header: 'Status', width: '120px', render: (r) => <RunStatusBadge status={r.status} /> },
    { key: 'startedAt', header: 'Started', width: '170px', render: (r) => <span className="text-muted whitespace-nowrap">{fmtDateTime(r.startedAt ?? r.createdAt)}</span> },
    { key: 'duration', header: 'Duration', width: '100px', render: (r) => runDurationText(r) },
    { key: 'summary', header: 'Result', render: (r) => <span className="text-[12.5px]">{runSummary(r)}</span> },
    { key: 'trigger', header: 'Trigger', width: '130px', render: (r) => <span className="text-muted">{r.triggeredByName ?? 'schedule'}</span> },
    { key: 'actions', header: '', width: '90px', render: (r) => ((r.status === 'running' || r.status === 'queued') ? <Button size="sm" variant="ghost" icon={<Ban className="h-3.5 w-3.5" />} onClick={(e) => { e.stopPropagation(); cancel.mutate(r.id); }}>Cancel</Button> : null) },
  ];

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'Configuration', to: '/cmdb' }, { label: 'Discovery', to: '/cmdb/discovery' }, { label: 'Sources', to: '/cmdb/discovery/sources' }, { label: s.name }]}
            title={s.name}
            badges={<><Badge color="indigo">{providerLabel}</Badge>{!s.isActive && <Badge color="gray">inactive</Badge>}{s.autoApply && <Badge color="green">auto-apply</Badge>}</>}
            controls={lastRun ? <span className="text-[12.5px] text-muted inline-flex items-center gap-1.5">Last run <RunStatusBadge status={lastRun.status} /> {lastRun.finishedAt ? relativeTime(lastRun.finishedAt) : lastRun.startedAt ? relativeTime(lastRun.startedAt) : ''}</span> : <span className="text-[12.5px] text-subtle">Never run</span>}
            primary={
              <>
                <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={test.isPending} onClick={() => test.mutate()}>Test</Button>
                <Button size="sm" icon={<Play className="h-3.5 w-3.5" />} loading={runNow.isPending} disabled={!s.isActive || !!running} onClick={() => runNow.mutate()}>{running ? 'Running…' : 'Run now'}</Button>
              </>
            }
            menu={canManage ? [
              { label: 'Edit source…', icon: <Pencil className="h-4 w-4" />, onClick: () => setEdit(true) },
              { label: s.isActive ? 'Deactivate (pause schedule)' : 'Activate', icon: <Power className="h-4 w-4" />, onClick: () => toggle.mutate(!s.isActive) },
              { label: 'Delete source', icon: <Trash2 className="h-4 w-4" />, onClick: () => setDel(true), danger: true },
            ] : []}
            createdAt={s.createdAt}
            updatedAt={s.updatedAt}
          >
            <RecordRibbon
              columns={5}
              items={[
                { label: 'To review', value: fmtNumber(s.pendingFindings), tone: s.pendingFindings ? 'warn' : 'good' },
                { label: 'Targets', value: fmtNumber(cfg.subnets.length) },
                { label: 'Schedule', value: s.scheduleCron ? schedule : 'manual' },
                { label: 'Last run', value: lastRun ? runDurationText(lastRun) : '—', hint: lastRun ? runSummary(lastRun) : undefined },
                { label: 'Runs', value: fmtNumber(runs.data?.total ?? 0) },
              ]}
            />
          </RecordHeader>
        }
        main={
          <>
            <RecordForm sections={sections} />
            <RelatedTabs
              tabs={[
                { key: 'findings', label: 'Findings', count: s.pendingFindings || undefined, content: <FindingsTable sourceId={s.id} customerId={s.customerId} /> },
                {
                  key: 'runs',
                  label: 'Runs',
                  count: runs.data?.total,
                  content: (
                    <div className="card overflow-hidden">
                      <DataTable columns={runCols} rows={runs.data?.items ?? []} loading={runs.isLoading} dense onRowClick={(r) => navigate(`/cmdb/discovery/runs/${r.id}`)} rowClassName={(r) => (r.status === 'failed' ? 'row-rail-bad' : r.status === 'running' ? 'row-rail-warn' : undefined)} empty={<EmptyState title="No runs yet" description="Press Run now to start the first scan." />} />
                      <Pagination page={page} pageSize={pageSize} total={runs.data?.total ?? 0} onPage={setPage} />
                    </div>
                  ),
                },
              ]}
            />
          </>
        }
        aside={
          <RailTabs
            tabs={[
              { key: 'activity', label: 'Activity', icon: MessageSquare, badge: audit.entries.length, content: <ActivityStream entries={audit.entries} loading={audit.isLoading} title="History" emptyText="No configuration changes recorded." /> },
              { key: 'details', label: 'Details', icon: Info, content: <RailCard title="Record"><RailRows rows={[{ label: 'Active', value: s.isActive ? <Badge color="green" dot>yes</Badge> : <Badge color="gray" dot>no</Badge> }, { label: 'Last run at', value: s.lastRunAt ? fmtDateTime(s.lastRunAt) : null }, { label: 'Created', value: s.createdAt ? fmtDateTime(s.createdAt) : null }, { label: 'ID', value: <span className="font-mono text-[11px]">{s.id.slice(0, 8)}…</span> }]} /></RailCard> },
            ]}
          />
        }
      />
      <SourceDrawer open={edit} onClose={() => setEdit(false)} source={s} providers={providers.data?.items ?? [{ type: 'network_scan', label: 'Network scan' }]} />
      <Dialog open={!!testResult} onClose={() => setTestResult(null)} title="Connectivity test" width="max-w-2xl">
        {testResult && (
          <div className="flex flex-col gap-2">
            <div className={cn('text-[13px] font-medium', testResult.ok ? 'text-emerald-600' : 'text-red-600')}>{testResult.message}</div>
            <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
              <thead><tr><th>Host</th><th>Reachable</th><th>Open ports</th><th>SNMP</th><th>Hostname</th><th>Latency</th></tr></thead>
              <tbody>
                {testResult.results.map((r) => (
                  <tr key={r.host}>
                    <td className="font-mono text-xs">{r.host}</td>
                    <td>{r.reachable ? <Badge color="green" dot>yes</Badge> : <Badge color="slate" dot>no</Badge>}</td>
                    <td><div className="flex flex-wrap gap-1">{r.openPorts.map((p) => <Badge key={p} color="slate">{p}</Badge>)}</div></td>
                    <td>{r.snmp ? <Badge color="indigo">answered</Badge> : <span className="text-subtle">—</span>}</td>
                    <td className="text-xs">{r.hostname ?? '—'}{r.sysDescr && <div className="text-subtle truncate max-w-[220px]" title={r.sysDescr}>{r.sysDescr}</div>}</td>
                    <td className="text-muted">{r.latencyMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Dialog>
      <ConfirmDialog open={del} onClose={() => setDel(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger confirmLabel="Delete source" title={`Delete ${s.name}?`} description="Its runs and findings are removed. Configuration items already created stay in the CMDB." />
    </>
  );
}
