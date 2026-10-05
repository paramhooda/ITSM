import { lazy, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2, Link2, Unlink, Ticket, Workflow, ChevronDown, MessageSquare, Info, Radar, Boxes } from 'lucide-react';
import { toast } from 'sonner';
import { get, post, put, patch, del } from '@/api/client';
import { Button, Badge, LoadingBlock, ErrorBlock, Dialog, Field, ConfirmDialog, EmptyState, Checkbox, DataTable, type Column } from '@/components/ui';
import { Menu, type MenuItem } from '@/components/Menu';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RecordAttention, RelatedTabs, ActivityStream, RailTabs, RailCard, RailRows, fromAudit, type FormSection } from '@/components/record';
import { ciAttention } from '@/components/record/attention';
import { Panel } from '@/components/dashboards/Panel';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useLookups } from '@/hooks/useLookups';
import { fmtDate, fmtDateTime, relativeTime, fmtNumber, titleCase } from '@/lib/format';
import { CI_STATUS_COLORS } from '@/lib/statusColors';
import { CiForm, type CiRecord } from '@/components/cmdb/CiForm';
import { CiTypeBadge, CiStatusBadge, CriticalityBadge, CI_STATUSES } from '@/components/cmdb/CiTypeBadge';
import { RelationshipList, type Relationship } from '@/components/cmdb/RelationshipList';
import { CiGraph } from '@/components/cmdb/CiGraph';
import { attributeItems } from '@/components/cmdb/AttributeFields';
import { CoverageBadge } from '@/components/assets/CoverageBadge';
import { LazyBlock } from '@/components/cmdb/LazyBlock';
import { errorMessage } from '@/components/cmdb/hooks';
import { discoveryApi, discoveryKeys, DIFF_COLORS, FINDING_STATUS_COLORS } from '@/components/cmdb/api';
import type { AuditEntry } from '@/components/audit/AuditTrail';
import { SoftwareTable, type HostSoftware } from '@/components/software/SoftwareTable';

const AttachmentList = lazy(() => import('@/components/attachments/AttachmentList').then((m) => ({ default: m.AttachmentList ?? m.default })));

interface CiDetail extends CiRecord {
  customerName?: string | null;
  siteName?: string | null;
  ownerTeamName?: string | null;
  assetId?: string | null;
  discoverySource?: string | null;
  discoveredAt?: string | null;
  lastSeenAt?: string | null;
  type: { id: string; key: string; name: string; icon?: string | null; color?: string | null };
  attributeSchema: Record<string, unknown>[];
  asset: { id: string; tag: string; name: string; serialNumber?: string | null; warrantyEnd?: string | null; amcEnd?: string | null; lifecycleStage: string } | null;
  services: { id: string; key: string; name: string; domain: string }[];
  interfaces: { id: string; name: string; ifIndex?: number | null; description?: string | null; macAddress?: string | null; ipAddress?: string | null; speedMbps?: number | null; adminStatus?: string | null; operStatus?: string | null; vlan?: string | null; updatedAt: string }[];
  relationships: { outbound: Relationship[]; inbound: Relationship[] };
  relationshipCount: number;
  openTickets: TicketRow[];
  recentChanges: TicketRow[];
  /** Software installations recorded on this item (software:read holders; empty otherwise). */
  software?: HostSoftware[];
  createdAt: string;
  updatedAt: string;
}
interface TicketRow { id: string; number: string; title: string; type: string; status: string; statusColor?: string | null; createdAt: string }
interface Impact { root: { name: string }; dependents: { id: string; name: string; typeKey: string; typeName: string; color: string | null; status: string; criticality: string; depth: number; via: string; path: string[] }[]; businessServices: { id: string; name: string; criticality: string }[]; openTickets: (TicketRow & { ciId?: string | null })[]; truncated: boolean }

const fmtVal = (v: unknown) => (v === null || v === undefined || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

export default function CiDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const isCustomer = useAuthStore((s) => s.user?.userType === 'customer');
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const { lookups } = useLookups();
  const { data: ci, isLoading, error, refetch } = useQuery({ queryKey: ['cmdb', id], queryFn: () => get<CiDetail>(`/cmdb/cis/${id}`) });
  const impact = useQuery({ queryKey: ['cmdb', id, 'impact'], queryFn: () => get<Impact>(`/cmdb/cis/${id}/impact`), enabled: !!id, staleTime: 60_000 });
  const history = useQuery({ queryKey: ['cmdb', id, 'history'], queryFn: () => get<{ items: AuditEntry[] }>(`/cmdb/cis/${id}/history`), enabled: !!id, staleTime: 30_000 });
  const findings = useQuery({ queryKey: discoveryKeys.findings({ ci: id }), queryFn: () => discoveryApi.findings({ customerId: ci?.customerId, q: ci?.ipAddress || ci?.hostname || undefined, pageSize: 50 }), enabled: !!ci && !!(ci.ipAddress || ci.hostname) && can('discovery:run', 'discovery:manage'), staleTime: 60_000, retry: false });
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [assetOpen, setAssetOpen] = useState(false);
  const [assetQuery, setAssetQuery] = useState('');
  const [assetId, setAssetId] = useState('');
  const canManage = !!ci && can('cmdb:manage');

  useEffect(() => {
    if (ci) setAssistantContext({ label: ci.name, entityType: 'ci', entityId: ci.id, customerId: ci.customerId });
    return () => setAssistantContext(null);
  }, [ci, setAssistantContext]);

  const assetSearch = useQuery({ queryKey: ['assets', 'picker', ci?.customerId, assetQuery], queryFn: () => get<{ items: { id: string; tag: string; name: string; serialNumber?: string | null }[] }>('/assets', { fields: 'min', customerId: ci?.customerId, q: assetQuery || undefined, hasCi: 'false', pageSize: 20 }), enabled: assetOpen && !!ci });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['cmdb'] });
  const setStatus = useMutation({ mutationFn: (status: string) => patch(`/cmdb/cis/${id}`, { status }), onSuccess: () => { toast.success('Status updated'); invalidate(); }, onError: (e) => toast.error(errorMessage(e)) });
  const saveServices = useMutation({ mutationFn: () => put(`/cmdb/cis/${id}/services`, { serviceIds }), onSuccess: () => { toast.success('Services updated'); invalidate(); setServicesOpen(false); }, onError: (e) => toast.error(errorMessage(e)) });
  const linkAsset = useMutation({ mutationFn: () => patch(`/cmdb/cis/${id}`, { assetId }), onSuccess: () => { toast.success('Asset linked'); invalidate(); qc.invalidateQueries({ queryKey: ['assets'] }); setAssetOpen(false); }, onError: (e) => toast.error(errorMessage(e)) });
  const unlinkAsset = useMutation({ mutationFn: () => post(`/assets/${ci!.asset!.id}/unlink-ci`), onSuccess: () => { toast.success('Asset unlinked'); invalidate(); qc.invalidateQueries({ queryKey: ['assets'] }); }, onError: (e) => toast.error(errorMessage(e)) });
  const remove = useMutation({ mutationFn: () => del(`/cmdb/cis/${id}`), onSuccess: () => { toast.success('CI deleted'); invalidate(); navigate('/cmdb/cis'); }, onError: (e) => toast.error(errorMessage(e)) });

  const attrs = useMemo(() => (ci ? attributeItems(ci.attributeSchema as never, ci.attributes ?? {}) : []), [ci]);
  const snmp = (ci?.attributes?.snmp ?? null) as { sysDescr?: string; sysObjectId?: string; sysLocation?: string; sysContact?: string } | null;
  const entries = useMemo(() => (history.data?.items ?? []).map(fromAudit), [history.data]);
  const myFindings = useMemo(() => (findings.data?.items ?? []).filter((f) => f.matchedCiId === id), [findings.data, id]);

  if (isLoading) return <LoadingBlock />;
  if (error || !ci) return <ErrorBlock error={error} retry={() => refetch()} />;

  const ifaceCols: Column<CiDetail['interfaces'][number]>[] = [
    { key: 'ifIndex', header: '#', width: '50px', render: (i) => <span className="text-muted">{i.ifIndex ?? '—'}</span> },
    { key: 'name', header: 'Interface', render: (i) => <span className="font-mono text-xs">{i.name}</span> },
    { key: 'description', header: 'Description' },
    { key: 'macAddress', header: 'MAC', render: (i) => <span className="font-mono text-xs">{i.macAddress ?? '—'}</span> },
    { key: 'ipAddress', header: 'IP', render: (i) => <span className="font-mono text-xs">{i.ipAddress ?? '—'}</span> },
    { key: 'speedMbps', header: 'Speed', render: (i) => (i.speedMbps ? `${i.speedMbps >= 1000 ? `${i.speedMbps / 1000} Gbps` : `${i.speedMbps} Mbps`}` : '—') },
    { key: 'operStatus', header: 'Status', render: (i) => <span className="inline-flex gap-1">{i.operStatus && <Badge color={i.operStatus === 'up' ? 'green' : i.operStatus === 'down' ? 'red' : 'slate'} dot>{i.operStatus}</Badge>}{i.adminStatus && i.adminStatus !== i.operStatus && <Badge color="slate">admin {i.adminStatus}</Badge>}</span> },
    { key: 'vlan', header: 'VLAN' },
  ];
  const ticketCols: Column<TicketRow>[] = [
    { key: 'number', header: 'Number', width: '120px', render: (t) => <span className="font-mono text-xs">{t.number}</span> },
    { key: 'title', header: 'Title', render: (t) => <span className="font-medium">{t.title}</span> },
    { key: 'type', header: 'Type', width: '100px', render: (t) => <span className="text-muted">{titleCase(t.type)}</span> },
    { key: 'status', header: 'Status', width: '130px', render: (t) => <Badge color={t.statusColor ?? undefined} dot>{t.status}</Badge> },
    { key: 'createdAt', header: 'Opened', width: '110px', render: (t) => <span className="text-muted">{relativeTime(t.createdAt)}</span> },
  ];
  const TicketTable = ({ rows, empty }: { rows: TicketRow[]; empty: string }) => <DataTable columns={ticketCols} rows={rows} dense onRowClick={(t) => navigate(`/tickets/${t.id}`)} empty={<EmptyState title={empty} />} />;

  const statusMenu: MenuItem[] = CI_STATUSES.filter((s) => s !== ci.status).map((s) => ({ label: `Mark ${s}`, onClick: () => setStatus.mutate(s), danger: s === 'retired' }));
  const menu: MenuItem[] = [
    { label: 'Open in service map', icon: <Workflow className="h-4 w-4" />, onClick: () => navigate(`/cmdb/map?ci=${ci.id}`) },
    ...(can('tickets:create') ? [{ label: 'New change for this CI', icon: <Ticket className="h-4 w-4" />, onClick: () => navigate(`/tickets/new?type=change&customerId=${ci.customerId}&primaryCiId=${ci.id}`) }] : []),
    ...(canManage ? [{ label: ci.asset ? 'Unlink asset' : 'Link asset…', icon: ci.asset ? <Unlink className="h-4 w-4" /> : <Link2 className="h-4 w-4" />, onClick: () => (ci.asset ? unlinkAsset.mutate() : setAssetOpen(true)) }, { label: 'Edit services…', icon: <Boxes className="h-4 w-4" />, onClick: () => { setServiceIds(ci.services.map((s) => s.id)); setServicesOpen(true); } }] : []),
    ...(canManage ? [{ label: 'Delete', icon: <Trash2 className="h-4 w-4" />, onClick: () => setDeleteOpen(true), danger: true }] : []),
  ];

  const sections: FormSection[] = [
    {
      key: 'identity',
      title: 'Identity & network',
      fields: [
        { label: 'Customer', value: <Link to={`/customers/${ci.customerId}`} className="hover:underline">{ci.customerName ?? 'Customer'}</Link> },
        { label: 'Site', value: ci.siteName },
        { label: 'Hostname', value: ci.hostname, kind: 'mono' },
        { label: 'FQDN', value: ci.fqdn, kind: 'mono' },
        { label: 'IP address', value: ci.ipAddress, kind: 'mono' },
        { label: 'MAC address', value: ci.macAddress, kind: 'mono' },
        { label: 'Serial number', value: ci.serialNumber, kind: 'mono' },
        { label: 'Owner team', value: ci.ownerTeamName },
        { label: 'Environment', value: titleCase(ci.environment) },
        { label: 'Monitoring ref', value: ci.monitoringRef, kind: 'mono', hidden: !ci.monitoringRef },
        { label: 'SIEM ref', value: ci.siemRef, kind: 'mono', hidden: !ci.siemRef },
        { label: 'Tags', value: ci.tags?.length ? <span className="flex flex-wrap gap-1">{ci.tags.map((t) => <Badge key={t} color="slate">{t}</Badge>)}</span> : null },
        { label: 'Description', value: ci.description ?? '', kind: 'prose', span: 2, hidden: !ci.description },
      ],
    },
    {
      key: 'platform',
      title: 'Platform',
      fields: [
        { label: 'Manufacturer', value: ci.manufacturer },
        { label: 'Model', value: ci.model },
        { label: 'Operating system', value: [ci.osName, ci.osVersion].filter(Boolean).join(' ') || null },
        { label: 'Firmware', value: ci.firmwareVersion },
        { label: 'Discovery', value: ci.discoverySource ? <span>{titleCase(ci.discoverySource.replace(/_/g, ' '))} · first seen {fmtDate(ci.discoveredAt)}</span> : 'Manual' },
        { label: 'Last seen', value: ci.lastSeenAt ? fmtDateTime(ci.lastSeenAt) : null },
      ],
    },
    {
      key: 'attributes',
      title: `${ci.type.name} attributes`,
      hidden: attrs.length === 0 && !snmp,
      fields: [
        ...attrs.map((a) => ({ label: a.label, value: a.value })),
        { label: 'sysDescr', value: snmp?.sysDescr ?? '', kind: 'prose' as const, span: 2 as const, hidden: !snmp?.sysDescr },
        { label: 'sysObjectID', value: snmp?.sysObjectId, kind: 'mono' as const, hidden: !snmp?.sysObjectId },
        { label: 'SNMP location', value: snmp?.sysLocation, hidden: !snmp?.sysLocation },
        { label: 'SNMP contact', value: snmp?.sysContact, hidden: !snmp?.sysContact },
      ],
    },
  ];

  const tabs = [
    {
      key: 'relationships',
      label: 'Relationships',
      count: ci.relationshipCount,
      content: (
        <div className="flex flex-col gap-3">
          <RelationshipList ciId={ci.id} customerId={ci.customerId} outbound={ci.relationships.outbound} inbound={ci.relationships.inbound} />
          <Panel title="Dependency graph" subtitle="Neighbourhood of this item · drag to pan, wheel to zoom" padded={false}>
            <div className="p-3"><CiGraph ciId={ci.id} onNavigate={(nid) => nid !== ci.id && navigate(`/cmdb/cis/${nid}?tab=relationships`)} /></div>
          </Panel>
        </div>
      ),
    },
    {
      key: 'impact',
      label: 'Impact',
      count: impact.data?.dependents.length,
      content: (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-3">
          <Panel title="Downstream dependents" subtitle="What stops working if this item fails" padded={false}>
            {impact.isLoading && <LoadingBlock />}
            {impact.data && (impact.data.dependents.length ? (
              <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
                <thead><tr><th>Depth</th><th>CI</th><th>Class</th><th>Via</th><th>Status</th><th>Criticality</th></tr></thead>
                <tbody>
                  {impact.data.dependents.map((d) => (
                    <tr key={d.id} className="clickable" onClick={() => navigate(`/cmdb/cis/${d.id}?tab=impact`)}>
                      <td className="text-muted">{d.depth}</td>
                      <td className="font-medium" style={{ paddingLeft: `${12 + (d.depth - 1) * 14}px` }}>{d.name}</td>
                      <td><CiTypeBadge typeKey={d.typeKey} name={d.typeName} color={d.color} /></td>
                      <td className="text-muted">{d.via.replace(/_/g, ' ')}</td>
                      <td><CiStatusBadge status={d.status} /></td>
                      <td><CriticalityBadge value={d.criticality} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <EmptyState title="Nothing depends on this item" description="Add depends_on, runs_on or hosted_on relationships from the items that need it." />)}
            {impact.data?.truncated && <div className="px-4 py-2 text-xs text-amber-600">Truncated to 300 items.</div>}
          </Panel>
          <div className="flex flex-col gap-3">
            <Panel title="Business services affected">
              {impact.data?.businessServices.length ? (
                <ul className="flex flex-col gap-1.5">{impact.data.businessServices.map((s) => <li key={s.id} className="flex items-center justify-between gap-2"><Link to={`/cmdb/services/${s.id}`} className="font-medium hover:underline truncate">{s.name}</Link><CriticalityBadge value={s.criticality} /></li>)}</ul>
              ) : <div className="text-[12.5px] text-subtle">None in the impact chain.</div>}
            </Panel>
            <Panel title="Open tickets on affected items" padded={false}><TicketTable rows={impact.data?.openTickets ?? []} empty="No open tickets" /></Panel>
          </div>
        </div>
      ),
    },
    { key: 'interfaces', label: 'Interfaces', count: ci.interfaces.length, content: <div className="card overflow-hidden"><DataTable columns={ifaceCols} rows={ci.interfaces} dense empty={<EmptyState title="No interfaces" description="Populated by network discovery (SNMP ifTable) or through the API." />} /></div> },
    { key: 'tickets', label: 'Tickets & changes', count: ci.openTickets.length, content: <div className="grid grid-cols-1 xl:grid-cols-2 gap-3"><Panel title="Open tickets" padded={false}><TicketTable rows={ci.openTickets} empty="No open tickets" /></Panel><Panel title="Recent changes" padded={false}><TicketTable rows={ci.recentChanges} empty="No change records" /></Panel></div> },
    {
      key: 'discovery',
      label: 'Discovery',
      count: myFindings.length || undefined,
      hidden: !can('discovery:run', 'discovery:manage'),
      content: (
        <div className="card overflow-hidden">
          {findings.isLoading && <LoadingBlock />}
          {!findings.isLoading && (myFindings.length ? (
            <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
              <thead><tr><th>Discovered</th><th>IP</th><th>Hostname</th><th>Diff</th><th>Status</th><th>Run</th></tr></thead>
              <tbody>
                {myFindings.map((f) => (
                  <tr key={f.id} className="clickable" onClick={() => navigate(`/cmdb/discovery/findings/${f.id}`)}>
                    <td className="text-muted whitespace-nowrap">{fmtDateTime(f.createdAt)}</td>
                    <td className="font-mono text-xs">{f.ipAddress}</td>
                    <td>{f.hostname ?? '—'}</td>
                    <td><Badge color={DIFF_COLORS[f.diffStatus]}>{f.diffStatus}</Badge></td>
                    <td><Badge color={FINDING_STATUS_COLORS[f.status]} dot>{f.status}</Badge></td>
                    <td><Link to={`/cmdb/discovery/runs/${f.runId}`} onClick={(e) => e.stopPropagation()} className="font-mono text-xs text-brand-700 hover:underline">{f.runId.slice(0, 8)}</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState icon={<Radar className="h-5 w-5" />} title="No discovery findings" description={ci.discoverySource ? 'This item was discovered, but no findings reference it yet.' : 'This item was created manually.'} />)}
        </div>
      ),
    },
    { key: 'software', label: 'Software', count: ci.software?.length ?? 0, hidden: !can('software:read'), content: <div className="card overflow-hidden"><SoftwareTable rows={ci.software ?? []} customerId={ci.customerId} />{(ci.software?.length ?? 0) > 0 && <div className="px-4 py-2 text-[12px] text-muted border-t border-default"><Link to={`/assets/software/installations?ciId=${ci.id}&customerId=${ci.customerId}`} className="text-brand-700 hover:underline">Open in Software</Link></div>}</div> },
    { key: 'attachments', label: 'Attachments', content: <div className="card p-4"><LazyBlock fallback={<div className="text-[13px] text-muted">Attachments are not available.</div>}><AttachmentList entityType="ci" entityId={ci.id} customerId={ci.customerId} canUpload={canManage} canDelete={canManage} showVisibility /></LazyBlock></div> },
  ];

  const stale = !!ci.discoverySource && (!ci.lastSeenAt || Date.now() - new Date(ci.lastSeenAt).getTime() > 30 * 86_400_000);
  // What needs attention (MSP staff only): parked item with open work, no owner, stale discovery, unmapped.
  const attention = isCustomer ? [] : ciAttention(ci, Date.now(), { onEdit: canManage ? () => setEditOpen(true) : undefined });

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'Configuration', to: '/cmdb' }, { label: 'Configuration items', to: '/cmdb/cis' }, { label: ci.type.name, to: `/cmdb/cis?typeKey=${ci.type.key}` }, { label: ci.name }]}
            number={ci.hostname ?? ci.ipAddress ?? undefined}
            title={ci.name}
            badges={<CiTypeBadge typeKey={ci.type.key} name={ci.type.name} color={ci.type.color} icon={ci.type.icon} />}
            controls={
              <>
                {canManage && statusMenu.length ? <Menu align="left" trigger={<button className="inline-flex items-center gap-1 rounded-md hover:bg-surface-2 pr-1"><CiStatusBadge status={ci.status} /><ChevronDown className="h-3 w-3 text-subtle" /></button>} items={statusMenu} /> : <CiStatusBadge status={ci.status} />}
                <CriticalityBadge value={ci.criticality} />
                <Badge color="slate">{titleCase(ci.environment)}</Badge>
                {stale && <Badge color="amber">Stale · not seen for 30 days</Badge>}
              </>
            }
            primary={
              <>
                {can('tickets:create') && <Button size="sm" variant="outline" icon={<Ticket className="h-3.5 w-3.5" />} onClick={() => navigate(`/tickets/new?type=incident&customerId=${ci.customerId}&primaryCiId=${ci.id}`)}>New incident</Button>}
                {canManage && <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditOpen(true)}>Edit</Button>}
              </>
            }
            menu={menu}
            createdAt={ci.createdAt}
            updatedAt={ci.updatedAt}
          >
            <RecordRibbon
              columns={5}
              items={[
                { label: 'Open tickets', value: fmtNumber(ci.openTickets.length), tone: ci.openTickets.length ? 'warn' : 'good' },
                { label: 'Relationships', value: fmtNumber(ci.relationshipCount), tone: ci.relationshipCount === 0 && ci.status === 'active' ? 'warn' : undefined },
                { label: 'Depends on this', value: impact.data ? fmtNumber(impact.data.dependents.length) : '…', tone: impact.data?.businessServices.length ? 'warn' : undefined, hint: impact.data?.businessServices.length ? `${impact.data.businessServices.length} business service(s) affected` : undefined },
                { label: 'Interfaces', value: fmtNumber(ci.interfaces.length) },
                { label: 'Last seen', value: ci.lastSeenAt ? relativeTime(ci.lastSeenAt) : ci.discoverySource ? 'never' : 'manual', tone: stale ? 'bad' : ci.lastSeenAt ? 'good' : undefined },
              ]}
            />
          </RecordHeader>
        }
        main={
          <>
            {!isCustomer && <RecordAttention items={attention} />}
            <RecordForm sections={sections} />
            <RelatedTabs tabs={tabs} />
          </>
        }
        aside={
          <RailTabs
            tabs={[
              { key: 'activity', label: 'Activity', icon: MessageSquare, badge: entries.length, content: <ActivityStream entries={entries} loading={history.isLoading} title="History" emptyText="No changes recorded yet." maxHeight="calc(100vh - 220px)" /> },
              {
                key: 'details',
                label: 'Details',
                icon: Info,
                content: (
                  <>
                    <RailCard title={<><Boxes className="h-3.5 w-3.5 text-subtle" /> Asset</>} action={canManage ? (ci.asset ? <Button variant="ghost" size="sm" icon={<Unlink className="h-3.5 w-3.5" />} loading={unlinkAsset.isPending} onClick={() => unlinkAsset.mutate()}>Unlink</Button> : <Button variant="ghost" size="sm" icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => setAssetOpen(true)}>Link</Button>) : undefined}>
                      {ci.asset ? (
                        <RailRows rows={[{ label: 'Asset', value: <Link to={`/assets/${ci.asset.id}`} className="font-medium text-brand-700 hover:underline"><span className="font-mono">{ci.asset.tag}</span></Link> }, { label: 'Name', value: ci.asset.name }, { label: 'Lifecycle', value: titleCase(ci.asset.lifecycleStage) }, { label: 'Warranty', value: <CoverageBadge end={ci.asset.warrantyEnd} /> }, { label: 'AMC', value: <CoverageBadge end={ci.asset.amcEnd} /> }]} />
                      ) : (
                        <div className="text-[12.5px] text-subtle">No financial record linked.</div>
                      )}
                    </RailCard>
                    <RailCard title="Services supported" action={canManage ? <Button variant="ghost" size="sm" onClick={() => { setServiceIds(ci.services.map((s) => s.id)); setServicesOpen(true); }}>Edit</Button> : undefined}>
                      {ci.services.length ? <div className="flex flex-wrap gap-1.5">{ci.services.map((s) => <Badge key={s.id} color="indigo">{s.name}</Badge>)}</div> : <div className="text-[12.5px] text-subtle">Not mapped to a catalog service.</div>}
                    </RailCard>
                    <RailCard title="Record">
                      <RailRows rows={[{ label: 'Status', value: <Badge color={CI_STATUS_COLORS[ci.status] ?? 'slate'} dot>{titleCase(ci.status)}</Badge> }, { label: 'Created', value: fmtDateTime(ci.createdAt) }, { label: 'Updated', value: fmtDateTime(ci.updatedAt) }, { label: 'ID', value: <span className="font-mono text-[11px]">{ci.id.slice(0, 8)}…</span> }]} />
                    </RailCard>
                  </>
                ),
              },
            ]}
          />
        }
      />

      <CiForm open={editOpen} onClose={() => setEditOpen(false)} ci={ci} />
      <Dialog open={servicesOpen} onClose={() => setServicesOpen(false)} title="Services supported by this item" footer={<><Button variant="ghost" onClick={() => setServicesOpen(false)}>Cancel</Button><Button loading={saveServices.isPending} onClick={() => saveServices.mutate()}>Save</Button></>}>
        <div className="flex flex-col gap-1.5 max-h-80 overflow-y-auto">
          {(lookups?.services ?? []).map((s) => (
            <Checkbox key={s.id} label={<span>{s.name} <span className="text-subtle text-xs">({s.domain})</span></span>} checked={serviceIds.includes(s.id)} onChange={(e) => setServiceIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))} />
          ))}
          {!lookups?.services.length && <div className="text-[13px] text-subtle">No services in the catalog.</div>}
        </div>
      </Dialog>
      <Dialog open={assetOpen} onClose={() => setAssetOpen(false)} title="Link asset" footer={<><Button variant="ghost" onClick={() => setAssetOpen(false)}>Cancel</Button><Button disabled={!assetId} loading={linkAsset.isPending} onClick={() => linkAsset.mutate()}>Link</Button></>}>
        <Field label="Unlinked assets of this customer">
          <input className="input" autoFocus placeholder="Tag, name or serial…" value={assetQuery} onChange={(e) => setAssetQuery(e.target.value)} />
        </Field>
        <div className="mt-2 max-h-64 overflow-y-auto flex flex-col">
          {(assetSearch.data?.items ?? []).map((a) => (
            <button key={a.id} onClick={() => setAssetId(a.id)} className={`text-left px-2 py-1.5 rounded-md text-[13px] hover:bg-surface-2 ${assetId === a.id ? 'bg-brand-600/10' : ''}`}>
              <span className="font-mono text-xs mr-2">{a.tag}</span>{a.name}{a.serialNumber && <span className="text-subtle text-xs ml-2">{a.serialNumber}</span>}
            </button>
          ))}
          {assetSearch.data && !assetSearch.data.items.length && <div className="text-[13px] text-subtle px-2 py-2">No unlinked assets found.</div>}
        </div>
      </Dialog>
      <ConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger confirmLabel="Delete CI" title={`Delete ${ci.name}?`} description="Items referenced by tickets cannot be deleted; mark them retired instead. Relationships and interfaces are removed with the item." />
    </>
  );
}
