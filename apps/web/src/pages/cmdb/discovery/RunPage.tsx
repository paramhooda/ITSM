import { useNavigate, useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ClipboardList, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Badge, LoadingBlock, ErrorBlock } from '@/components/ui';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RelatedTabs, type FormSection } from '@/components/record';
import { fmtDateTime, fmtNumber, titleCase } from '@/lib/format';
import { RunStatusBadge, runDurationText } from '@/components/cmdb/DiscoveryBits';
import { FindingsTable } from './FindingsTable';
import { errorMessage } from '@/components/cmdb/hooks';
import { discoveryApi, discoveryKeys } from '@/components/cmdb/api';

/** One scan: its outcome in numbers, the devices it found, and the log for when something went wrong. */
export default function RunPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: discoveryKeys.run(id), queryFn: () => discoveryApi.run(id), enabled: !!id, refetchInterval: (x) => (x.state.data?.status === 'running' || x.state.data?.status === 'queued' ? 2000 : false) });
  const cancel = useMutation({ mutationFn: () => discoveryApi.cancelRun(id), onSuccess: () => { toast.success('Run cancelled'); qc.invalidateQueries({ queryKey: discoveryKeys.all }); }, onError: (e) => toast.error(errorMessage(e)) });
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError || !q.data) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  const r = q.data;
  const s = r.stats ?? {};
  const live = r.status === 'running' || r.status === 'queued';
  const findingsNew = r.findings?.new ?? s.newCis ?? 0;
  const findingsChanged = r.findings?.changed ?? s.changed ?? 0;
  const findingsSame = r.findings?.unchanged ?? s.unchanged ?? 0;

  const sections: FormSection[] = [
    {
      key: 'run',
      title: 'Run',
      fields: [
        { label: 'Source', value: <Link to={`/cmdb/discovery/sources/${r.sourceId}`} className="hover:underline font-medium">{r.sourceName ?? 'Source'}</Link> },
        { label: 'Customer', value: r.customerName },
        { label: 'Trigger', value: r.triggeredByName ?? (r.triggeredBy ? titleCase(r.triggeredBy) : 'Schedule') },
        { label: 'Queued', value: fmtDateTime(r.createdAt) },
        { label: 'Started', value: r.startedAt ? fmtDateTime(r.startedAt) : null },
        { label: 'Finished', value: r.finishedAt ? fmtDateTime(r.finishedAt) : null },
        { label: 'Error', value: r.error ? <span className="text-red-700">{r.error}</span> : null, span: 2, hidden: !r.error },
      ],
    },
    {
      key: 'stats',
      title: 'Scan statistics',
      hidden: Object.keys(s).length === 0,
      fields: Object.entries(s).map(([k, v]) => ({ label: titleCase(k.replace(/([A-Z])/g, ' $1').trim()), value: fmtNumber(v) })),
    },
  ];

  return (
    <RecordLayout
      header={
        <RecordHeader
          crumbs={[{ label: 'Configuration', to: '/cmdb' }, { label: 'Discovery', to: '/cmdb/discovery' }, { label: 'Runs', to: '/cmdb/discovery/runs' }, { label: r.id.slice(0, 8) }]}
          number={r.id.slice(0, 8)}
          title={`${r.sourceName ?? 'Discovery run'}${r.customerName ? ` · ${r.customerName}` : ''}`}
          badges={<RunStatusBadge status={r.status} />}
          controls={live ? <span className="text-[12.5px] text-amber-700">Scanning… this page refreshes every 2 seconds</span> : <span className="text-[12.5px] text-muted">{findingsNew} new · {findingsChanged} changed · {findingsSame} unchanged</span>}
          primary={live ? <Button size="sm" variant="outline" icon={<Ban className="h-3.5 w-3.5" />} loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel run</Button> : <Button size="sm" icon={<ClipboardList className="h-3.5 w-3.5" />} onClick={() => navigate(`/cmdb/discovery/findings?runId=${r.id}`)}>Review findings</Button>}
          menu={[{ label: 'Open source', icon: <ExternalLink className="h-4 w-4" />, onClick: () => navigate(`/cmdb/discovery/sources/${r.sourceId}`) }]}
          createdAt={r.createdAt}
          updatedAt={r.finishedAt ?? r.startedAt ?? undefined}
        >
          <RecordRibbon columns={5} items={[{ label: 'Hosts scanned', value: fmtNumber(s.hostsScanned ?? 0) }, { label: 'Responsive', value: fmtNumber(s.responsive ?? 0) }, { label: 'SNMP answered', value: fmtNumber(s.snmp ?? 0) }, { label: 'Findings', value: `${fmtNumber(findingsNew)} new · ${fmtNumber(findingsChanged)} changed`, tone: findingsNew + findingsChanged ? 'warn' : undefined }, { label: 'Duration', value: runDurationText(r) }]} />
        </RecordHeader>
      }
      main={
        <>
          <RecordForm sections={sections} />
          <RelatedTabs
            tabs={[
              { key: 'findings', label: 'Findings', count: findingsNew + findingsChanged + findingsSame || undefined, content: <FindingsTable runId={r.id} defaultStatus="" /> },
              { key: 'log', label: 'Log', content: <div className="card p-3"><pre className="bg-surface-2 rounded-md p-3 text-[11.5px] font-mono whitespace-pre-wrap max-h-[480px] overflow-auto">{r.log || (live ? 'Waiting for output…' : 'No log output.')}</pre></div> },
            ]}
          />
        </>
      }
      aside={
        r.status === 'failed' ? (
          <div className="card px-4 py-3 border-red-200 bg-red-50/40 text-[12.5px]">
            <div className="font-medium text-red-700 mb-0.5">Run failed</div>
            <div className="text-red-700/80">{r.error ?? 'See the log for details.'}</div>
            <Badge color="red" className="mt-2">no findings were applied</Badge>
          </div>
        ) : undefined
      }
      asideWidth={300}
    />
  );
}
