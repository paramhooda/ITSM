import { useNavigate, useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X, Server, Info, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Badge, LoadingBlock, ErrorBlock, EmptyState } from '@/components/ui';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RelatedTabs, RailCard, RailRows, type FormSection } from '@/components/record';
import { useAuthStore } from '@/stores/auth';
import { fmtDateTime, relativeTime, fmtNumber, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CiTypeBadge, CiStatusBadge } from '@/components/cmdb/CiTypeBadge';
import { DiffBadge, FindingStatusBadge, RunStatusBadge } from '@/components/cmdb/DiscoveryBits';
import { errorMessage } from '@/components/cmdb/hooks';
import { discoveryApi, discoveryKeys } from '@/components/cmdb/api';

const text = (v: unknown) => (v === null || v === undefined || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
const FIELD_LABEL: Record<string, string> = { hostname: 'Hostname', ipAddress: 'IP address', ip: 'IP address', macAddress: 'MAC address', mac: 'MAC address', serialNumber: 'Serial number', serial: 'Serial number', model: 'Model', manufacturer: 'Manufacturer', osName: 'Operating system' };

/** One discovered device: what was seen, what the CMDB has, and the decision to apply or ignore. */
export default function FindingPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canApply = can('discovery:run', 'discovery:manage');
  const q = useQuery({ queryKey: discoveryKeys.finding(id), queryFn: () => discoveryApi.finding(id), enabled: !!id });
  const act = useMutation({ mutationFn: (action: 'apply' | 'ignore') => discoveryApi.act(id, action), onSuccess: (r, action) => { toast.success(action === 'apply' ? `${r.created ? 'Created' : 'Updated'} CI ${r.ciName ?? ''}` : 'Finding ignored'); qc.invalidateQueries({ queryKey: discoveryKeys.all }); qc.invalidateQueries({ queryKey: ['cmdb'] }); if (action === 'apply' && r.ciId) navigate(`/cmdb/cis/${r.ciId}`); }, onError: (e) => toast.error(errorMessage(e)) });

  if (q.isLoading) return <LoadingBlock />;
  if (q.isError || !q.data) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  const f = q.data;
  const pending = f.status === 'pending';
  const changed = f.changes.filter((c) => c.changed);
  const snmp = !!(f.raw as { snmp?: boolean })?.snmp;
  const ifaces = (f.interfaces ?? []) as Record<string, unknown>[];
  const neighbors = (f.neighbors ?? []) as Record<string, unknown>[];

  const sections: FormSection[] = [
    {
      key: 'device',
      title: 'Discovered device',
      fields: [
        { label: 'IP address', value: f.ipAddress, kind: 'mono' },
        { label: 'Hostname', value: f.hostname, kind: 'mono' },
        { label: 'FQDN', value: f.fqdn, kind: 'mono', hidden: !f.fqdn || f.fqdn === f.hostname },
        { label: 'MAC address', value: f.macAddress, kind: 'mono' },
        { label: 'Manufacturer', value: f.manufacturer },
        { label: 'Model', value: f.model },
        { label: 'Serial number', value: f.serialNumber, kind: 'mono' },
        { label: 'Suggested class', value: f.suggestedType ? <CiTypeBadge typeKey={f.suggestedType.key} name={f.suggestedType.name} color={f.suggestedType.color} icon={f.suggestedType.icon} /> : <CiTypeBadge typeKey={f.suggestedTypeKey ?? 'other'} /> },
        { label: 'sysDescr', value: f.sysDescr ?? '', kind: 'prose', span: 2, hidden: !f.sysDescr },
        { label: 'sysObjectID', value: text((f.raw as { sysObjectId?: string }).sysObjectId), kind: 'mono', hidden: !(f.raw as { sysObjectId?: string }).sysObjectId },
      ],
    },
    {
      key: 'compare',
      title: f.matchedCi ? `Compared with ${f.matchedCi.name}` : 'No matching configuration item',
      description: f.matchedCi ? `${changed.length} field${changed.length === 1 ? '' : 's'} differ` : 'Applying creates a new CI of the suggested class',
      fields: [],
      hidden: !f.matchedCi,
      children: f.matchedCi ? (
        <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
          <thead><tr><th>Field</th><th>CMDB has</th><th>Discovery found</th><th className="w-24"></th></tr></thead>
          <tbody>
            {f.changes.map((c) => (
              <tr key={c.field} className={cn(c.changed && 'bg-amber-50/50')}>
                <td className="font-medium">{FIELD_LABEL[c.field] ?? titleCase(c.field)}</td>
                <td className={cn('font-mono text-xs', c.changed && 'line-through text-subtle')}>{text(c.current) ?? <span className="text-subtle">—</span>}</td>
                <td className="font-mono text-xs">{text(c.discovered) ?? <span className="text-subtle">—</span>}</td>
                <td>{c.changed ? <Badge color="amber">changed</Badge> : <span className="text-subtle text-[11.5px]">same</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : undefined,
    },
  ];

  const ifaceKeys = ifaces.length ? Object.keys(ifaces[0]!).slice(0, 7) : [];
  const neighKeys = neighbors.length ? Object.keys(neighbors[0]!).slice(0, 6) : [];
  const Raw = ({ rows, keys, empty }: { rows: Record<string, unknown>[]; keys: string[]; empty: string }) => (
    <div className="card overflow-hidden">
      {rows.length ? (
        <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
          <thead><tr>{keys.map((k) => <th key={k}>{titleCase(k)}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{keys.map((k) => <td key={k} className="font-mono text-xs">{text(r[k]) ?? '—'}</td>)}</tr>)}</tbody>
        </table>
      ) : (
        <EmptyState title={empty} />
      )}
    </div>
  );

  return (
    <RecordLayout
      header={
        <RecordHeader
          crumbs={[{ label: 'Configuration', to: '/cmdb' }, { label: 'Discovery', to: '/cmdb/discovery' }, { label: 'Findings', to: '/cmdb/discovery/findings' }, { label: f.ipAddress }]}
          number={f.ipAddress}
          title={f.hostname ?? f.fqdn ?? f.ipAddress}
          badges={<><DiffBadge diff={f.diffStatus} /><FindingStatusBadge status={f.status} />{snmp && <Badge color="indigo">SNMP</Badge>}</>}
          controls={f.matchedCi ? <span className="text-[12.5px] text-muted inline-flex items-center gap-1.5">Matched to <Link to={`/cmdb/cis/${f.matchedCi.id}`} className="font-medium text-default hover:underline">{f.matchedCi.name}</Link> <CiStatusBadge status={f.matchedCi.status} /></span> : <span className="text-[12.5px] text-muted">No CI matches this device yet</span>}
          primary={pending && canApply ? <><Button size="sm" icon={<Check className="h-3.5 w-3.5" />} loading={act.isPending && act.variables === 'apply'} onClick={() => act.mutate('apply')}>{f.matchedCi ? 'Update CI' : 'Create CI'}</Button><Button size="sm" variant="outline" icon={<X className="h-3.5 w-3.5" />} loading={act.isPending && act.variables === 'ignore'} onClick={() => act.mutate('ignore')}>Ignore</Button></> : undefined}
          menu={[...(f.matchedCi ? [{ label: 'Open configuration item', icon: <Server className="h-4 w-4" />, onClick: () => navigate(`/cmdb/cis/${f.matchedCi!.id}`) }] : []), ...(f.run ? [{ label: 'Open run', icon: <ExternalLink className="h-4 w-4" />, onClick: () => navigate(`/cmdb/discovery/runs/${f.run!.id}`) }] : []), ...(f.source ? [{ label: 'Open source', icon: <ExternalLink className="h-4 w-4" />, onClick: () => navigate(`/cmdb/discovery/sources/${f.source!.id}`) }] : [])]}
          createdAt={f.createdAt}
          updatedAt={f.appliedAt ?? undefined}
        >
          <RecordRibbon columns={5} items={[{ label: 'Open ports', value: fmtNumber(f.openPorts.length) }, { label: 'Interfaces', value: fmtNumber(ifaces.length) }, { label: 'Neighbours', value: fmtNumber(neighbors.length) }, { label: 'Fields changed', value: f.matchedCi ? fmtNumber(changed.length) : 'new', tone: changed.length ? 'warn' : undefined }, { label: 'Discovered', value: relativeTime(f.createdAt), hint: fmtDateTime(f.createdAt) }]} />
        </RecordHeader>
      }
      main={
        <>
          <RecordForm sections={sections} />
          <RelatedTabs
            tabs={[
              { key: 'ports', label: 'Open ports', count: f.openPorts.length, content: <div className="card p-4">{f.openPorts.length ? <div className="flex flex-wrap gap-1.5">{f.openPorts.map((p) => <Badge key={p} color="slate" className="font-mono">{p}</Badge>)}</div> : <EmptyState title="No open TCP ports seen" />}</div> },
              { key: 'interfaces', label: 'Interfaces', count: ifaces.length, content: <Raw rows={ifaces} keys={ifaceKeys} empty="No interface table (SNMP did not answer)" /> },
              { key: 'neighbors', label: 'Neighbours', count: neighbors.length, content: <Raw rows={neighbors} keys={neighKeys} empty="No LLDP/CDP neighbours reported" /> },
            ]}
          />
        </>
      }
      aside={
        <>
          <RailCard title={<><Info className="h-3.5 w-3.5 text-subtle" /> Origin</>}>
            <RailRows rows={[{ label: 'Source', value: f.source ? <Link to={`/cmdb/discovery/sources/${f.source.id}`} className="hover:underline font-medium">{f.source.name}</Link> : null }, { label: 'Run', value: f.run ? <span className="inline-flex items-center gap-1.5"><Link to={`/cmdb/discovery/runs/${f.run.id}`} className="font-mono text-xs hover:underline">{f.run.id.slice(0, 8)}</Link><RunStatusBadge status={f.run.status} /></span> : null }, { label: 'Discovered', value: fmtDateTime(f.createdAt) }, { label: 'Applied', value: f.appliedAt ? fmtDateTime(f.appliedAt) : null, hidden: !f.appliedAt }]} />
          </RailCard>
          {f.matchedCi && (
            <RailCard title={<><Server className="h-3.5 w-3.5 text-subtle" /> Configuration item</>} action={<Link to={`/cmdb/cis/${f.matchedCi.id}`} className="text-[12px] text-brand-700 hover:underline">Open</Link>}>
              <RailRows rows={[{ label: 'Name', value: f.matchedCi.name }, { label: 'Class', value: <CiTypeBadge typeKey={f.matchedCi.typeKey} name={f.matchedCi.typeName} /> }, { label: 'Status', value: <CiStatusBadge status={f.matchedCi.status} /> }, { label: 'Last seen', value: f.matchedCi.lastSeenAt ? relativeTime(f.matchedCi.lastSeenAt) : null }]} />
            </RailCard>
          )}
        </>
      }
    />
  );
}
