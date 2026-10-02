import { lazy, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Link2, Unlink, Plus, Trash2, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { get, post, del } from '@/api/client';
import { PageHeader, Button, Card, KeyValue, Badge, LoadingBlock, ErrorBlock, Dialog, Field, Select, ConfirmDialog, EmptyState, Textarea } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { useAuthStore } from '@/stores/auth';
import { useLookups } from '@/hooks/useLookups';
import { fmtDate, fmtDateTime, fmtMoney, relativeTime } from '@/lib/format';
import { ASSET_LIFECYCLE } from '@itsm/shared';
import { AssetForm, type AssetRecord } from '@/components/assets/AssetForm';
import { CoverageBadge, LifecycleBadge, type Coverage } from '@/components/assets/CoverageBadge';
import { CiPicker, type CiMin } from '@/components/cmdb/CiPicker';
import { CiTypeBadge, CiStatusBadge } from '@/components/cmdb/CiTypeBadge';
import { LazyBlock } from '@/components/cmdb/LazyBlock';
import { errorMessage } from '@/components/cmdb/hooks';

const AttachmentList = lazy(() => import('@/components/attachments/AttachmentList').then((m) => ({ default: m.AttachmentList ?? m.default })));
const AuditTrail = lazy(() => import('@/components/audit/AuditTrail').then((m) => ({ default: m.AuditTrail ?? m.default })));

interface AssetDetail extends AssetRecord {
  customerName?: string | null;
  customerCode?: string | null;
  siteName?: string | null;
  categoryLabel?: string | null;
  statusLabel?: string | null;
  statusColor?: string | null;
  ownerContactName?: string | null;
  assignedContactName?: string | null;
  ciId?: string | null;
  warranty: Coverage;
  amc: Coverage;
  eol: Coverage;
  ci: { id: string; name: string; hostname?: string | null; ipAddress?: string | null; status: string; typeKey: string; typeName: string; typeColor?: string | null; lastSeenAt?: string | null } | null;
  amcContract: { id: string; number: string; name: string; status: string; startDate: string; endDate: string } | null;
  openTickets: { id: string; number: string; title: string; type: string; status: string; statusColor?: string | null; createdAt: string }[];
  visitParts: { id: string; visitId: string; visitNumber: string; visitTitle: string; visitStatus: string; name: string; partNumber?: string | null; serialNumber?: string | null; quantity: number; createdAt: string }[];
  createdAt: string;
  updatedAt: string;
}

/** Mirrors the API's allowed lifecycle transitions. */
const TRANSITIONS: Record<string, string[]> = { ordered: ['in_stock', 'deployed', 'retired'], in_stock: ['deployed', 'in_repair', 'retired'], deployed: ['in_repair', 'in_stock', 'retired'], in_repair: ['deployed', 'in_stock', 'retired'], retired: ['disposed', 'in_stock'], disposed: [] };

export default function AssetDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const { lookups } = useLookups();
  const { data: a, isLoading, error, refetch } = useQuery({ queryKey: ['assets', id], queryFn: () => get<AssetDetail>(`/assets/${id}`) });
  const [editOpen, setEditOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [createCiOpen, setCreateCiOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<{ stage: string; notes: string } | null>(null);
  const [pickedCi, setPickedCi] = useState<CiMin | null>(null);
  const [ciTypeId, setCiTypeId] = useState('');
  const canManage = !!a && can('assets:manage');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['assets'] });
    qc.invalidateQueries({ queryKey: ['cmdb'] });
  };
  const act = (fn: () => Promise<unknown>, ok: string, after?: () => void) =>
    useMutation({ mutationFn: fn, onSuccess: () => { toast.success(ok); invalidate(); after?.(); }, onError: (e) => toast.error(errorMessage(e)) });
  const linkCi = act(() => post(`/assets/${id}/link-ci`, { ciId: pickedCi!.id }), 'CI linked', () => { setLinkOpen(false); setPickedCi(null); });
  const unlinkCi = act(() => post(`/assets/${id}/unlink-ci`), 'CI unlinked');
  const createCi = act(() => post(`/assets/${id}/create-ci`, { typeId: ciTypeId }), 'CI created from asset', () => setCreateCiOpen(false));
  const changeLifecycle = act(() => post(`/assets/${id}/lifecycle`, { stage: lifecycle!.stage, notes: lifecycle!.notes || undefined }), 'Lifecycle updated', () => setLifecycle(null));
  const remove = useMutation({ mutationFn: () => del(`/assets/${id}`), onSuccess: () => { toast.success('Asset deleted'); invalidate(); navigate('/assets'); }, onError: (e) => toast.error(errorMessage(e)) });

  if (isLoading) return <LoadingBlock />;
  if (error || !a) return <ErrorBlock error={error} retry={() => refetch()} />;

  const transitions = TRANSITIONS[a.lifecycleStage] ?? [...ASSET_LIFECYCLE];
  const dash = (v?: string | number | null) => (v === null || v === undefined || v === '' ? '—' : v);

  return (
    <div>
      <PageHeader
        breadcrumb={<Link to="/assets" className="hover:underline">Assets</Link>}
        title={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <span className="font-mono text-base text-muted">{a.tag}</span>
            <span>{a.name}</span>
            {a.statusLabel && <Badge color={a.statusColor ?? undefined} dot>{a.statusLabel}</Badge>}
            <LifecycleBadge stage={a.lifecycleStage} />
          </span>
        }
        subtitle={
          <span className="inline-flex items-center gap-2">
            <Link to={`/customers/${a.customerId}`} className="hover:underline">{a.customerName ?? 'Customer'}</Link>
            {a.siteName && <span>· {a.siteName}</span>}
            {a.categoryLabel && <span>· {a.categoryLabel}</span>}
            <span className="text-subtle">· updated {relativeTime(a.updatedAt)}</span>
          </span>
        }
        actions={
          canManage ? (
            <>
              <Menu
                trigger={<Button variant="outline" size="sm" icon={<ChevronDown className="h-4 w-4" />}>Lifecycle</Button>}
                items={transitions.length ? transitions.map((s) => ({ label: `Move to ${s.replace(/_/g, ' ')}`, onClick: () => setLifecycle({ stage: s, notes: '' }) })) : [{ label: 'No further transitions', onClick: () => undefined, disabled: true }]}
              />
              <Button variant="outline" size="sm" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditOpen(true)}>Edit</Button>
              <Button variant="ghost" size="sm" icon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleteOpen(true)}>Delete</Button>
            </>
          ) : undefined
        }
      />
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4">
        <div className="flex flex-col gap-4 min-w-0">
          <Card title="Identity">
            <KeyValue columns={3} items={[
              { label: 'Category', value: dash(a.categoryLabel) },
              { label: 'Manufacturer', value: dash(a.manufacturer) },
              { label: 'Model', value: dash(a.model) },
              { label: 'Serial number', value: <span className="font-mono">{dash(a.serialNumber)}</span> },
              { label: 'Part number', value: dash(a.partNumber) },
              { label: 'Location', value: dash(a.location) },
              { label: 'Rack / position', value: dash(a.rackPosition) },
              { label: 'Tags', value: a.tags?.length ? <span className="flex flex-wrap gap-1">{a.tags.map((t) => <Badge key={t} color="slate">{t}</Badge>)}</span> : '—' },
              { label: 'Description', value: dash(a.description), span: 3 },
            ]} />
          </Card>
          <Card title="Commercial">
            <KeyValue columns={3} items={[
              { label: 'Vendor', value: dash(a.vendor) },
              { label: 'Purchase date', value: fmtDate(a.purchaseDate) },
              { label: 'Purchase cost', value: fmtMoney(a.purchaseCost as number, a.currency ?? 'INR') },
              { label: 'PO number', value: dash(a.poNumber) },
              { label: 'Invoice number', value: dash(a.invoiceNumber) },
            ]} />
          </Card>
          <Card title="Coverage">
            <KeyValue columns={3} items={[
              { label: 'Warranty', value: <CoverageBadge coverage={a.warranty} /> },
              { label: 'Warranty start', value: fmtDate(a.warrantyStart) },
              { label: 'Warranty provider', value: dash(a.warrantyProvider) },
              { label: 'AMC contract', value: a.amcContract ? <Link to={`/contracts/${a.amcContract.id}`} className="text-brand-600 hover:underline">{a.amcContract.number} · {a.amcContract.name}</Link> : '—' },
              { label: 'AMC period', value: a.amcStart || a.amcEnd || a.amcContract ? <span>{fmtDate(a.amcStart ?? a.amcContract?.startDate)} → <CoverageBadge coverage={a.amc} /></span> : '—' },
              { label: 'End of life / support', value: <span>{fmtDate(a.eolDate)} / {fmtDate(a.eosDate)}</span> },
            ]} />
          </Card>
          <Card title="Ownership">
            <KeyValue columns={3} items={[
              { label: 'Owner', value: dash(a.ownerContactName) },
              { label: 'Assigned to', value: dash(a.assignedContactName) },
              { label: 'Created', value: fmtDateTime(a.createdAt) },
            ]} />
          </Card>
          <Card title="Open tickets" padded={false}>
            {a.openTickets.length ? (
              <table className="table">
                <thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Status</th><th>Created</th></tr></thead>
                <tbody>
                  {a.openTickets.map((t) => (
                    <tr key={t.id} className="clickable" onClick={() => navigate(`/tickets/${t.id}`)}>
                      <td className="font-mono text-xs">{t.number}</td><td>{t.title}</td><td className="capitalize">{t.type}</td><td><Badge color={t.statusColor ?? undefined} dot>{t.status}</Badge></td><td className="text-muted">{relativeTime(t.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <EmptyState title="No open tickets" description="Tickets that reference this asset will appear here." />}
          </Card>
          <Card title="Parts used in field visits" padded={false}>
            {a.visitParts.length ? (
              <table className="table">
                <thead><tr><th>Visit</th><th>Part</th><th>Part no.</th><th>Serial</th><th>Qty</th><th>Date</th></tr></thead>
                <tbody>
                  {a.visitParts.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => navigate(`/field/${p.visitId}`)}>
                      <td className="font-mono text-xs">{p.visitNumber}</td><td>{p.name}</td><td>{dash(p.partNumber)}</td><td className="font-mono text-xs">{dash(p.serialNumber)}</td><td>{p.quantity}</td><td className="text-muted">{fmtDate(p.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <EmptyState title="No parts recorded" />}
          </Card>
          <Card title="Attachments">
            <LazyBlock fallback={<div className="text-[13px] text-muted">Attachments are not available.</div>}>
              <AttachmentList entityType="asset" entityId={a.id} customerId={a.customerId} canUpload={canManage} canDelete={canManage} showVisibility />
            </LazyBlock>
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card title="Configuration item">
            {a.ci ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <CiTypeBadge typeKey={a.ci.typeKey} name={a.ci.typeName} color={a.ci.typeColor} />
                  <CiStatusBadge status={a.ci.status} />
                </div>
                <Link to={`/cmdb/${a.ci.id}`} className="font-medium text-brand-600 hover:underline">{a.ci.name}</Link>
                <div className="text-xs text-muted font-mono">{[a.ci.hostname, a.ci.ipAddress].filter(Boolean).join(' · ') || 'No network identity'}</div>
                {a.ci.lastSeenAt && <div className="text-xs text-subtle">Last seen {relativeTime(a.ci.lastSeenAt)}</div>}
                {canManage && <Button variant="ghost" size="sm" icon={<Unlink className="h-4 w-4" />} onClick={() => unlinkCi.mutate()} loading={unlinkCi.isPending} className="self-start">Unlink</Button>}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="text-[13px] text-muted">Not linked to a CI. Link the operational record to see relationships, tickets and monitoring.</div>
                {canManage && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" icon={<Link2 className="h-4 w-4" />} onClick={() => setLinkOpen(true)}>Link CI</Button>
                    {can('cmdb:manage') && <Button variant="outline" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreateCiOpen(true)}>Create CI</Button>}
                  </div>
                )}
              </div>
            )}
          </Card>
          <Card title="History">
            <LazyBlock fallback={<div className="text-[13px] text-muted">History is not available.</div>}>
              <AuditTrail entityType="asset" entityId={a.id} compact />
            </LazyBlock>
          </Card>
        </div>
      </div>

      <AssetForm open={editOpen} onClose={() => setEditOpen(false)} asset={a} />
      <Dialog open={linkOpen} onClose={() => setLinkOpen(false)} title="Link configuration item" footer={<><Button variant="ghost" onClick={() => setLinkOpen(false)}>Cancel</Button><Button disabled={!pickedCi} loading={linkCi.isPending} onClick={() => linkCi.mutate()}>Link</Button></>}>
        <Field label="CI" hint="Only CIs of the same customer are shown.">
          <CiPicker customerId={a.customerId} value={pickedCi} onChange={setPickedCi} autoFocus />
        </Field>
      </Dialog>
      <Dialog open={createCiOpen} onClose={() => setCreateCiOpen(false)} title="Create CI from asset" footer={<><Button variant="ghost" onClick={() => setCreateCiOpen(false)}>Cancel</Button><Button disabled={!ciTypeId} loading={createCi.isPending} onClick={() => createCi.mutate()}>Create</Button></>}>
        <div className="text-[13px] text-muted mb-3">A configuration item named <b>{a.name}</b> will be created with this asset's serial, manufacturer and model, and linked both ways.</div>
        <Field label="CI type" required>
          <Select value={ciTypeId} onChange={(e) => setCiTypeId(e.target.value)} placeholder="Select type…" options={(lookups?.ciTypes ?? []).map((t) => ({ value: t.id, label: t.name }))} />
        </Field>
      </Dialog>
      <Dialog open={!!lifecycle} onClose={() => setLifecycle(null)} title={`Move to ${lifecycle?.stage.replace(/_/g, ' ')}`} footer={<><Button variant="ghost" onClick={() => setLifecycle(null)}>Cancel</Button><Button loading={changeLifecycle.isPending} onClick={() => changeLifecycle.mutate()}>Confirm</Button></>}>
        <Field label="Notes" hint="Recorded in the audit trail.">
          <Textarea value={lifecycle?.notes ?? ''} onChange={(e) => setLifecycle((l) => (l ? { ...l, notes: e.target.value } : l))} />
        </Field>
      </Dialog>
      <ConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger confirmLabel="Delete asset" title={`Delete ${a.tag}?`} description="Assets referenced by tickets cannot be deleted; retire them via the lifecycle instead. This cannot be undone." />
    </div>
  );
}
