import { lazy, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2, Link2, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { get, post, put, patch, del } from '@/api/client';
import { PageHeader, Button, Card, KeyValue, Badge, LoadingBlock, ErrorBlock, Tabs, Dialog, Field, ConfirmDialog, EmptyState, Checkbox, DataTable, type Column } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useLookups } from '@/hooks/useLookups';
import { useListState } from '@/hooks/useListState';
import { fmtDate, fmtDateTime, relativeTime } from '@/lib/format';
import { CiForm, type CiRecord } from '@/components/cmdb/CiForm';
import { CiTypeBadge, CiStatusBadge, CriticalityBadge } from '@/components/cmdb/CiTypeBadge';
import { RelationshipList, type Relationship } from '@/components/cmdb/RelationshipList';
import { CiGraph } from '@/components/cmdb/CiGraph';
import { attributeItems } from '@/components/cmdb/AttributeFields';
import { CoverageBadge } from '@/components/assets/CoverageBadge';
import { LazyBlock } from '@/components/cmdb/LazyBlock';
import { errorMessage } from '@/components/cmdb/hooks';

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
  createdAt: string;
  updatedAt: string;
}
interface TicketRow { id: string; number: string; title: string; type: string; status: string; statusColor?: string | null; createdAt: string }
interface Impact { root: { name: string }; dependents: { id: string; name: string; typeKey: string; typeName: string; color: string | null; status: string; criticality: string; depth: number; via: string; path: string[] }[]; businessServices: { id: string; name: string; criticality: string }[]; openTickets: (TicketRow & { ciId?: string | null })[]; truncated: boolean }
interface HistoryRow { id: string; occurredAt: string; userName?: string | null; entityType: string; entityLabel?: string | null; action: string; changes: Record<string, { old: unknown; new: unknown }>; source: string; metadata: Record<string, unknown> }
type Tab = 'overview' | 'relationships' | 'impact' | 'interfaces' | 'tickets' | 'history';

const fmtVal = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export default function CiDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const { lookups } = useLookups();
  const { state, set } = useListState({ tab: 'overview' });
  const tab = (state.tab as Tab) ?? 'overview';
  const { data: ci, isLoading, error, refetch } = useQuery({ queryKey: ['cmdb', id], queryFn: () => get<CiDetail>(`/cmdb/cis/${id}`) });
  const impact = useQuery({ queryKey: ['cmdb', id, 'impact'], queryFn: () => get<Impact>(`/cmdb/cis/${id}/impact`), enabled: tab === 'impact' });
  const history = useQuery({ queryKey: ['cmdb', id, 'history'], queryFn: () => get<{ items: HistoryRow[] }>(`/cmdb/cis/${id}/history`), enabled: tab === 'history' });
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
  const saveServices = useMutation({ mutationFn: () => put(`/cmdb/cis/${id}/services`, { serviceIds }), onSuccess: () => { toast.success('Services updated'); invalidate(); setServicesOpen(false); }, onError: (e) => toast.error(errorMessage(e)) });
  const linkAsset = useMutation({ mutationFn: () => patch(`/cmdb/cis/${id}`, { assetId }), onSuccess: () => { toast.success('Asset linked'); invalidate(); qc.invalidateQueries({ queryKey: ['assets'] }); setAssetOpen(false); }, onError: (e) => toast.error(errorMessage(e)) });
  const unlinkAsset = useMutation({ mutationFn: () => post(`/assets/${ci!.asset!.id}/unlink-ci`), onSuccess: () => { toast.success('Asset unlinked'); invalidate(); qc.invalidateQueries({ queryKey: ['assets'] }); }, onError: (e) => toast.error(errorMessage(e)) });
  const remove = useMutation({ mutationFn: () => del(`/cmdb/cis/${id}`), onSuccess: () => { toast.success('CI deleted'); invalidate(); navigate('/cmdb'); }, onError: (e) => toast.error(errorMessage(e)) });

  const attrs = useMemo(() => (ci ? attributeItems(ci.attributeSchema as never, ci.attributes ?? {}) : []), [ci]);
  const snmp = (ci?.attributes?.snmp ?? null) as { sysDescr?: string; sysObjectId?: string; sysLocation?: string; sysContact?: string } | null;

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
  const TicketTable = ({ rows, empty }: { rows: TicketRow[]; empty: string }) => rows.length ? (
    <table className="table">
      <thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Status</th><th>Created</th></tr></thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id} className="clickable" onClick={() => navigate(`/tickets/${t.id}`)}>
            <td className="font-mono text-xs">{t.number}</td><td>{t.title}</td><td className="capitalize">{t.type}</td><td><Badge color={t.statusColor ?? undefined} dot>{t.status}</Badge></td><td className="text-muted">{relativeTime(t.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  ) : <EmptyState title={empty} />;

  return (
    <div>
      <PageHeader
        breadcrumb={<Link to="/cmdb" className="hover:underline">CMDB</Link>}
        title={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <span>{ci.name}</span>
            <CiTypeBadge typeKey={ci.type.key} name={ci.type.name} color={ci.type.color} icon={ci.type.icon} />
            <CiStatusBadge status={ci.status} />
            <CriticalityBadge value={ci.criticality} />
            <Badge color="slate" className="capitalize">{ci.environment}</Badge>
          </span>
        }
        subtitle={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <Link to={`/customers/${ci.customerId}`} className="hover:underline">{ci.customerName ?? 'Customer'}</Link>
            {ci.siteName && <span>· {ci.siteName}</span>}
            {ci.hostname && <span className="font-mono">· {ci.hostname}</span>}
            {ci.ipAddress && <span className="font-mono">· {ci.ipAddress}</span>}
            {ci.lastSeenAt && <span className="text-subtle">· seen {relativeTime(ci.lastSeenAt)}</span>}
          </span>
        }
        actions={canManage ? (
          <>
            <Button variant="outline" size="sm" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditOpen(true)}>Edit</Button>
            <Button variant="ghost" size="sm" icon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleteOpen(true)}>Delete</Button>
          </>
        ) : undefined}
      />
      <Tabs<Tab>
        className="mb-4"
        value={tab}
        onChange={(t) => set({ tab: t }, false)}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'relationships', label: 'Relationships', count: ci.relationshipCount },
          { key: 'impact', label: 'Impact' },
          { key: 'interfaces', label: 'Interfaces', count: ci.interfaces.length },
          { key: 'tickets', label: 'Tickets & Changes', count: ci.openTickets.length },
          { key: 'history', label: 'History' },
        ]}
      />

      {tab === 'overview' && (
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-4">
          <div className="flex flex-col gap-4 min-w-0">
            <Card title="Identity & network">
              <KeyValue columns={3} items={[
                { label: 'Hostname', value: <span className="font-mono">{fmtVal(ci.hostname)}</span> },
                { label: 'FQDN', value: <span className="font-mono">{fmtVal(ci.fqdn)}</span> },
                { label: 'IP address', value: <span className="font-mono">{fmtVal(ci.ipAddress)}</span> },
                { label: 'MAC address', value: <span className="font-mono">{fmtVal(ci.macAddress)}</span> },
                { label: 'Serial number', value: <span className="font-mono">{fmtVal(ci.serialNumber)}</span> },
                { label: 'Owner team', value: fmtVal(ci.ownerTeamName) },
                { label: 'Monitoring ref', value: fmtVal(ci.monitoringRef) },
                { label: 'SIEM ref', value: fmtVal(ci.siemRef) },
                { label: 'Tags', value: ci.tags?.length ? <span className="flex flex-wrap gap-1">{ci.tags.map((t) => <Badge key={t} color="slate">{t}</Badge>)}</span> : '—' },
                { label: 'Description', value: fmtVal(ci.description), span: 3 },
              ]} />
            </Card>
            <Card title="Platform">
              <KeyValue columns={3} items={[
                { label: 'Manufacturer', value: fmtVal(ci.manufacturer) },
                { label: 'Model', value: fmtVal(ci.model) },
                { label: 'OS', value: [ci.osName, ci.osVersion].filter(Boolean).join(' ') || '—' },
                { label: 'Firmware', value: fmtVal(ci.firmwareVersion) },
                { label: 'Discovery', value: ci.discoverySource ? <span>{ci.discoverySource} · first seen {fmtDate(ci.discoveredAt)}</span> : 'Manual' },
                { label: 'Last seen', value: ci.lastSeenAt ? fmtDateTime(ci.lastSeenAt) : '—' },
              ]} />
            </Card>
            <Card title={`${ci.type.name} attributes`}>
              {attrs.length ? <KeyValue columns={3} items={attrs} /> : <div className="text-[13px] text-subtle">No attributes defined for this type.</div>}
              {snmp && (snmp.sysDescr || snmp.sysObjectId) && (
                <div className="mt-4 pt-3 border-t border-default">
                  <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium mb-1">SNMP system</div>
                  <KeyValue columns={2} items={[{ label: 'sysDescr', value: <span className="text-xs break-all">{snmp.sysDescr ?? '—'}</span>, span: 2 }, { label: 'sysObjectID', value: <span className="font-mono text-xs">{snmp.sysObjectId ?? '—'}</span> }, { label: 'Location / contact', value: [snmp.sysLocation, snmp.sysContact].filter(Boolean).join(' · ') || '—' }]} />
                </div>
              )}
            </Card>
            <Card title="Attachments">
              <LazyBlock fallback={<div className="text-[13px] text-muted">Attachments are not available.</div>}>
                <AttachmentList entityType="ci" entityId={ci.id} customerId={ci.customerId} canUpload={canManage} canDelete={canManage} showVisibility />
              </LazyBlock>
            </Card>
          </div>
          <div className="flex flex-col gap-4">
            <Card title="Asset">
              {ci.asset ? (
                <div className="flex flex-col gap-1.5">
                  <Link to={`/assets/${ci.asset.id}`} className="font-medium text-brand-600 hover:underline"><span className="font-mono">{ci.asset.tag}</span> · {ci.asset.name}</Link>
                  <div className="text-xs text-muted">Lifecycle: {ci.asset.lifecycleStage.replace(/_/g, ' ')}</div>
                  <div className="text-xs text-muted flex items-center gap-1">Warranty: <CoverageBadge end={ci.asset.warrantyEnd} /></div>
                  <div className="text-xs text-muted flex items-center gap-1">AMC: <CoverageBadge end={ci.asset.amcEnd} /></div>
                  {canManage && can('assets:manage') && <Button variant="ghost" size="sm" className="self-start" icon={<Unlink className="h-4 w-4" />} loading={unlinkAsset.isPending} onClick={() => unlinkAsset.mutate()}>Unlink</Button>}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="text-[13px] text-muted">No asset linked. Link the financial record to see warranty and AMC coverage.</div>
                  {canManage && <Button variant="outline" size="sm" className="self-start" icon={<Link2 className="h-4 w-4" />} onClick={() => setAssetOpen(true)}>Link asset</Button>}
                </div>
              )}
            </Card>
            <Card title="Services" actions={canManage ? <Button variant="ghost" size="sm" onClick={() => { setServiceIds(ci.services.map((s) => s.id)); setServicesOpen(true); }}>Edit</Button> : undefined}>
              {ci.services.length ? <div className="flex flex-wrap gap-1.5">{ci.services.map((s) => <Badge key={s.id} color="indigo">{s.name}</Badge>)}</div> : <div className="text-[13px] text-subtle">Not mapped to any service.</div>}
            </Card>
            <Card title="Record">
              <KeyValue columns={1} items={[{ label: 'Created', value: fmtDateTime(ci.createdAt) }, { label: 'Updated', value: fmtDateTime(ci.updatedAt) }, { label: 'ID', value: <span className="font-mono text-xs">{ci.id}</span> }]} />
            </Card>
          </div>
        </div>
      )}

      {tab === 'relationships' && (
        <div className="flex flex-col gap-4">
          <RelationshipList ciId={ci.id} customerId={ci.customerId} outbound={ci.relationships.outbound} inbound={ci.relationships.inbound} />
          <Card title="Dependency graph" padded={false}>
            <div className="p-3">
              <CiGraph ciId={ci.id} onNavigate={(nid) => nid !== ci.id && navigate(`/cmdb/${nid}?tab=relationships`)} />
            </div>
          </Card>
        </div>
      )}

      {tab === 'impact' && (
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-4">
          <Card title="Downstream dependents" padded={false}>
            {impact.isLoading && <LoadingBlock />}
            {impact.data && (impact.data.dependents.length ? (
              <table className="table">
                <thead><tr><th>Depth</th><th>CI</th><th>Type</th><th>Via</th><th>Status</th><th>Criticality</th><th>Path</th></tr></thead>
                <tbody>
                  {impact.data.dependents.map((d) => (
                    <tr key={d.id} className="clickable" onClick={() => navigate(`/cmdb/${d.id}?tab=impact`)}>
                      <td className="text-muted">{d.depth}</td>
                      <td className="font-medium" style={{ paddingLeft: `${12 + (d.depth - 1) * 14}px` }}>{d.name}</td>
                      <td><CiTypeBadge typeKey={d.typeKey} name={d.typeName} color={d.color} /></td>
                      <td className="text-muted">{d.via.replace(/_/g, ' ')}</td>
                      <td><CiStatusBadge status={d.status} /></td>
                      <td><CriticalityBadge value={d.criticality} /></td>
                      <td className="text-xs text-subtle">{d.path.join(' → ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <EmptyState title="Nothing depends on this CI" description="Add depends_on / runs_on / hosted_on relationships from dependent CIs to model impact." />)}
            {impact.data?.truncated && <div className="px-4 py-2 text-xs text-amber-600">Result truncated to 300 CIs.</div>}
          </Card>
          <div className="flex flex-col gap-4">
            <Card title="Business services affected">
              {impact.data?.businessServices.length ? (
                <div className="flex flex-col gap-1.5">
                  {impact.data.businessServices.map((s) => (
                    <Link key={s.id} to={`/cmdb/${s.id}`} className="flex items-center justify-between gap-2 hover:underline">
                      <span className="font-medium">{s.name}</span>
                      <CriticalityBadge value={s.criticality} />
                    </Link>
                  ))}
                </div>
              ) : <div className="text-[13px] text-subtle">No business services in the impact chain.</div>}
            </Card>
            <Card title="Open tickets on affected CIs" padded={false}>
              <TicketTable rows={impact.data?.openTickets ?? []} empty="No open tickets" />
            </Card>
          </div>
        </div>
      )}

      {tab === 'interfaces' && (
        <Card padded={false}>
          <DataTable columns={ifaceCols} rows={ci.interfaces} dense empty={<EmptyState title="No interfaces" description="Interfaces are populated by network discovery (SNMP ifTable) or via the API." />} />
        </Card>
      )}

      {tab === 'tickets' && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Card title="Open tickets" padded={false}><TicketTable rows={ci.openTickets} empty="No open tickets" /></Card>
          <Card title="Recent changes" padded={false}><TicketTable rows={ci.recentChanges} empty="No change records" /></Card>
        </div>
      )}

      {tab === 'history' && (
        <Card padded={false}>
          {history.isLoading && <LoadingBlock />}
          {history.data && (history.data.items.length ? (
            <table className="table">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Changes</th></tr></thead>
              <tbody>
                {history.data.items.map((h) => (
                  <tr key={h.id}>
                    <td className="whitespace-nowrap text-muted">{fmtDateTime(h.occurredAt)}</td>
                    <td>{h.userName ?? <span className="text-subtle">{h.source}</span>}</td>
                    <td><Badge color={h.action.includes('delete') ? 'red' : h.action.includes('create') ? 'green' : 'blue'}>{h.action.replace(/[._]/g, ' ')}</Badge></td>
                    <td className="text-xs">{h.entityType.replace(/_/g, ' ')}{h.entityLabel && h.entityType !== 'ci' ? ` · ${h.entityLabel}` : ''}</td>
                    <td className="text-xs">
                      {Object.keys(h.changes ?? {}).length ? (
                        <ul className="flex flex-col gap-0.5">
                          {Object.entries(h.changes).map(([k, v]) => (
                            <li key={k}><span className="text-muted">{k}:</span> <span className="line-through text-subtle">{fmtVal(v.old)}</span> → <span>{fmtVal(v.new)}</span></li>
                          ))}
                        </ul>
                      ) : h.metadata && Object.keys(h.metadata).length ? <span className="text-subtle">{Object.entries(h.metadata).filter(([, v]) => v !== null && typeof v !== 'object').map(([k, v]) => `${k}=${String(v)}`).join(' ')}</span> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState title="No history yet" />)}
        </Card>
      )}

      <CiForm open={editOpen} onClose={() => setEditOpen(false)} ci={ci} />
      <Dialog open={servicesOpen} onClose={() => setServicesOpen(false)} title="Services supported by this CI" footer={<><Button variant="ghost" onClick={() => setServicesOpen(false)}>Cancel</Button><Button loading={saveServices.isPending} onClick={() => saveServices.mutate()}>Save</Button></>}>
        <div className="flex flex-col gap-1.5 max-h-80 overflow-y-auto">
          {(lookups?.services ?? []).map((s) => (
            <Checkbox key={s.id} label={<span>{s.name} <span className="text-subtle text-xs">({s.domain})</span></span>} checked={serviceIds.includes(s.id)} onChange={(e) => setServiceIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))} />
          ))}
          {!lookups?.services.length && <div className="text-[13px] text-subtle">No services in the catalog.</div>}
        </div>
      </Dialog>
      <Dialog open={assetOpen} onClose={() => setAssetOpen(false)} title="Link asset" footer={<><Button variant="ghost" onClick={() => setAssetOpen(false)}>Cancel</Button><Button disabled={!assetId} loading={linkAsset.isPending} onClick={() => linkAsset.mutate()}>Link</Button></>}>
        <Field label="Search unlinked assets of this customer">
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
      <ConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger confirmLabel="Delete CI" title={`Delete ${ci.name}?`} description="CIs referenced by tickets cannot be deleted; set their status to retired instead. Relationships and interfaces are removed with the CI." />
    </div>
  );
}
