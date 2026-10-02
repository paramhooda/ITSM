import { lazy, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Link2, Unlink, Plus, Trash2, ChevronDown, MessageSquare, Info, Server, Ticket, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { get, post, del } from '@/api/client';
import { Button, Card, Badge, LoadingBlock, ErrorBlock, Dialog, Field, Select, ConfirmDialog, EmptyState, Textarea } from '@/components/ui';
import { Menu, type MenuItem } from '@/components/Menu';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RecordAttention, RelatedTabs, ActivityStream, useAuditStream, RailTabs, RailCard, RailRows, type FormSection } from '@/components/record';
import { assetAttention } from '@/components/record/attention';
import { useAuthStore } from '@/stores/auth';
import { useLookups } from '@/hooks/useLookups';
import { fmtDate, fmtMoney, relativeTime } from '@/lib/format';
import { ASSET_LIFECYCLE } from '@itsm/shared';
import { AssetForm, type AssetRecord } from '@/components/assets/AssetForm';
import { CoverageBadge, LifecycleBadge, type Coverage } from '@/components/assets/CoverageBadge';
import { CiPicker, type CiMin } from '@/components/cmdb/CiPicker';
import { CiTypeBadge, CiStatusBadge } from '@/components/cmdb/CiTypeBadge';
import { LazyBlock } from '@/components/cmdb/LazyBlock';
import { errorMessage } from '@/components/cmdb/hooks';

const AttachmentList = lazy(() => import('@/components/attachments/AttachmentList').then((m) => ({ default: m.AttachmentList ?? m.default })));

interface AssetDetail extends AssetRecord {
  customerName?: string | null;
  customerCode?: string | null;
  siteName?: string | null;
  categoryLabel?: string | null;
  statusLabel?: string | null;
  statusColor?: string | null;
  /** Config-option key of the status (`in_use`, `in_stock`, `retired`, …). */
  statusKey?: string | null;
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
  const isCustomer = useAuthStore((s) => s.user?.userType === 'customer');
  const { lookups } = useLookups();
  const { data: a, isLoading, error, refetch } = useQuery({ queryKey: ['assets', id], queryFn: () => get<AssetDetail>(`/assets/${id}`) });
  const audit = useAuditStream('asset', id);
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
    qc.invalidateQueries({ queryKey: ['audit', 'entity', 'asset', id] });
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
  const mono = (v?: string | null) => (v ? <span className="font-mono text-[12.5px]">{v}</span> : null);
  // What needs attention (MSP staff only): coverage running out, lifecycle/status mismatch, no CI.
  const attention = isCustomer ? [] : assetAttention(a, { onLinkCi: canManage ? () => setLinkOpen(true) : undefined });

  // ---- header: state controls under the title, one primary action, the rest in the menu
  const controls = (
    <>
      {a.statusLabel && <Badge color={a.statusColor ?? undefined} dot>{a.statusLabel}</Badge>}
      {canManage && transitions.length > 0 ? (
        <Menu align="left" trigger={<button type="button" className="inline-flex items-center gap-1 rounded-md hover:bg-surface-2 pr-1" aria-label="Change lifecycle stage"><LifecycleBadge stage={a.lifecycleStage} /><ChevronDown className="h-3 w-3 text-subtle" /></button>} items={transitions.map((s) => ({ label: `Move to ${s.replace(/_/g, ' ')}`, onClick: () => setLifecycle({ stage: s, notes: '' }) }))} />
      ) : (
        <LifecycleBadge stage={a.lifecycleStage} />
      )}
    </>
  );
  const primary = canManage ? <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditOpen(true)}>Edit</Button> : undefined;
  const menu: MenuItem[] = canManage ? [{ label: 'Delete asset', icon: <Trash2 className="h-4 w-4" />, onClick: () => setDeleteOpen(true), danger: true }] : [];

  // ---- form
  const sections: FormSection[] = [
    {
      key: 'identity',
      title: 'Identity',
      fields: [
        { label: 'Customer', value: <Link to={`/customers/${a.customerId}`} className="hover:underline">{a.customerName ?? 'Customer'}</Link> },
        { label: 'Site', value: a.siteName },
        { label: 'Category', value: a.categoryLabel },
        { label: 'Manufacturer', value: a.manufacturer },
        { label: 'Model', value: a.model },
        { label: 'Serial number', value: a.serialNumber, kind: 'mono' },
        { label: 'Part number', value: a.partNumber, kind: 'mono' },
        { label: 'Location', value: a.location },
        { label: 'Rack / position', value: a.rackPosition },
        { label: 'Tags', value: a.tags?.length ? <span className="flex flex-wrap gap-1">{a.tags.map((t) => <Badge key={t} color="slate">{t}</Badge>)}</span> : null },
        { label: 'Description', value: a.description ?? '', kind: 'prose', span: 2 },
      ],
    },
    {
      key: 'commercial',
      title: 'Commercial',
      fields: [
        { label: 'Vendor', value: a.vendor },
        { label: 'Purchase date', value: a.purchaseDate ? fmtDate(a.purchaseDate) : null },
        { label: 'Purchase cost', value: a.purchaseCost != null && a.purchaseCost !== '' ? fmtMoney(a.purchaseCost, a.currency ?? 'INR') : null },
        { label: 'PO number', value: a.poNumber, kind: 'mono' },
        { label: 'Invoice number', value: a.invoiceNumber, kind: 'mono' },
      ],
    },
    {
      key: 'coverage',
      title: 'Coverage',
      fields: [
        { label: 'Warranty', value: <CoverageBadge coverage={a.warranty} /> },
        { label: 'Warranty start', value: a.warrantyStart ? fmtDate(a.warrantyStart) : null },
        { label: 'Warranty provider', value: a.warrantyProvider },
        { label: 'AMC contract', value: a.amcContract ? <Link to={`/contracts/${a.amcContract.id}`} className="hover:underline"><span className="font-mono text-[12.5px]">{a.amcContract.number}</span> · {a.amcContract.name}</Link> : null },
        { label: 'AMC period', value: a.amcStart || a.amcEnd || a.amcContract ? <span className="inline-flex items-center gap-1.5 flex-wrap">{fmtDate(a.amcStart ?? a.amcContract?.startDate)} → <CoverageBadge coverage={a.amc} /></span> : null },
        { label: 'End of life', value: a.eolDate ? <CoverageBadge coverage={a.eol} /> : null },
        { label: 'End of support', value: a.eosDate ? fmtDate(a.eosDate) : null },
      ],
    },
    {
      key: 'ownership',
      title: 'Ownership',
      fields: [
        { label: 'Owner', value: a.ownerContactName },
        { label: 'Assigned to', value: a.assignedContactName },
        { label: 'Notes', value: a.notes ?? '', kind: 'prose', span: 2, hidden: !a.notes },
      ],
    },
  ];

  // ---- related lists
  const tabs = [
    {
      key: 'tickets',
      label: 'Open tickets',
      count: a.openTickets.length,
      content: (
        <Card padded={false}>
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
          ) : <EmptyState icon={<Ticket className="h-5 w-5" />} title="No open tickets" />}
        </Card>
      ),
    },
    {
      key: 'parts',
      label: 'Parts used',
      count: a.visitParts.length,
      content: (
        <Card padded={false}>
          {a.visitParts.length ? (
            <table className="table">
              <thead><tr><th>Visit</th><th>Part</th><th>Part no.</th><th>Serial</th><th>Qty</th><th>Date</th></tr></thead>
              <tbody>
                {a.visitParts.map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => navigate(`/field/${p.visitId}`)}>
                    <td className="font-mono text-xs">{p.visitNumber}</td><td>{p.name}</td><td>{mono(p.partNumber) ?? '—'}</td><td>{mono(p.serialNumber) ?? '—'}</td><td className="tabular-nums">{p.quantity}</td><td className="text-muted">{fmtDate(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState icon={<Wrench className="h-5 w-5" />} title="No parts recorded" />}
        </Card>
      ),
    },
    {
      key: 'attachments',
      label: 'Attachments',
      content: (
        <Card>
          <LazyBlock fallback={<EmptyState title="Attachments are not available" />}>
            <AttachmentList entityType="asset" entityId={a.id} customerId={a.customerId} canUpload={canManage} canDelete={canManage} showVisibility />
          </LazyBlock>
        </Card>
      ),
    },
  ];

  // ---- rail: linked configuration item
  const ciCard = (
    <RailCard
      title={<><Server className="h-3.5 w-3.5 text-subtle" /> Configuration item</>}
      action={a.ci && canManage ? <Button variant="ghost" size="sm" icon={<Unlink className="h-3.5 w-3.5" />} onClick={() => unlinkCi.mutate()} loading={unlinkCi.isPending}>Unlink</Button> : undefined}
      padded={!!a.ci}
    >
      {a.ci ? (
        <>
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <CiTypeBadge typeKey={a.ci.typeKey} name={a.ci.typeName} color={a.ci.typeColor} />
            <CiStatusBadge status={a.ci.status} />
          </div>
          <RailRows
            rows={[
              { label: 'CI', value: <Link to={`/cmdb/cis/${a.ci.id}`} className="font-medium hover:underline">{a.ci.name}</Link> },
              { label: 'Hostname', value: mono(a.ci.hostname), hidden: !a.ci.hostname },
              { label: 'IP address', value: mono(a.ci.ipAddress), hidden: !a.ci.ipAddress },
              { label: 'Last seen', value: a.ci.lastSeenAt ? relativeTime(a.ci.lastSeenAt) : null, hidden: !a.ci.lastSeenAt },
            ]}
          />
        </>
      ) : (
        <EmptyState
          icon={<Server className="h-5 w-5" />}
          title="No linked CI"
          action={canManage ? (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => setLinkOpen(true)}>Link CI</Button>
              {can('cmdb:manage') && <Button variant="outline" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreateCiOpen(true)}>Create CI</Button>}
            </div>
          ) : undefined}
        />
      )}
    </RailCard>
  );

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'Assets', to: '/assets' }, { label: a.customerName ?? 'Customer', to: `/customers/${a.customerId}` }, { label: a.tag }]}
            number={a.tag}
            title={a.name}
            controls={controls}
            primary={primary}
            menu={menu}
            createdAt={a.createdAt}
            updatedAt={a.updatedAt}
          >
            <RecordRibbon items={glance(a)} columns={5} />
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
              { key: 'activity', label: 'Activity', icon: MessageSquare, badge: audit.entries.length, content: <ActivityStream entries={audit.entries} loading={audit.isLoading} maxHeight="calc(100vh - 220px)" /> },
              { key: 'details', label: 'Details', icon: Info, content: ciCard },
            ]}
          />
        }
      />

      <AssetForm open={editOpen} onClose={() => setEditOpen(false)} asset={a} />
      <Dialog open={linkOpen} onClose={() => setLinkOpen(false)} title="Link configuration item" footer={<><Button variant="ghost" onClick={() => setLinkOpen(false)}>Cancel</Button><Button disabled={!pickedCi} loading={linkCi.isPending} onClick={() => linkCi.mutate()}>Link</Button></>}>
        <Field label="CI" hint="Only CIs of the same customer are shown.">
          <CiPicker customerId={a.customerId} value={pickedCi} onChange={setPickedCi} autoFocus />
        </Field>
      </Dialog>
      <Dialog open={createCiOpen} onClose={() => setCreateCiOpen(false)} title="Create CI from asset" footer={<><Button variant="ghost" onClick={() => setCreateCiOpen(false)}>Cancel</Button><Button disabled={!ciTypeId} loading={createCi.isPending} onClick={() => createCi.mutate()}>Create</Button></>}>
        <Field label="CI type" required hint={`Creates "${a.name}" with this asset's serial, manufacturer and model, linked both ways.`}>
          <Select value={ciTypeId} onChange={(e) => setCiTypeId(e.target.value)} placeholder="Select type…" options={(lookups?.ciTypes ?? []).map((t) => ({ value: t.id, label: t.name }))} />
        </Field>
      </Dialog>
      <Dialog open={!!lifecycle} onClose={() => setLifecycle(null)} title={`Move to ${lifecycle?.stage.replace(/_/g, ' ')}`} footer={<><Button variant="ghost" onClick={() => setLifecycle(null)}>Cancel</Button><Button loading={changeLifecycle.isPending} onClick={() => changeLifecycle.mutate()}>Confirm</Button></>}>
        <Field label="Notes" hint="Recorded in the audit trail.">
          <Textarea value={lifecycle?.notes ?? ''} onChange={(e) => setLifecycle((l) => (l ? { ...l, notes: e.target.value } : l))} />
        </Field>
      </Dialog>
      <ConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger confirmLabel="Delete asset" title={`Delete ${a.tag}?`} description="Assets referenced by tickets cannot be deleted; retire them via the lifecycle instead. This cannot be undone." />
    </>
  );
}

// ---------------------------------------------------------------- at a glance

type Tone = 'good' | 'warn' | 'bad' | undefined;

/** Coverage as a ribbon value: days left, days since expiry, or nothing on file. */
function coverageGlance(c: Coverage): { value: string; tone: Tone } {
  if (c.status === 'none') return { value: '—', tone: undefined };
  if (c.status === 'expired') return { value: `${Math.abs(c.days ?? 0)}d ago`, tone: 'bad' };
  return { value: `${c.days ?? 0}d left`, tone: c.status === 'expiring' ? 'warn' : 'good' };
}

/** The numbers checked first: warranty and AMC clocks, open work, parts consumed, age. */
function glance(a: AssetDetail): { label: string; value: string; tone?: Tone; hint?: string }[] {
  const warranty = coverageGlance(a.warranty);
  const amc = coverageGlance(a.amc);
  const since = a.purchaseDate ?? a.createdAt;
  const days = Math.max(0, Math.round((Date.now() - new Date(since.length === 10 ? since + 'T00:00:00' : since).getTime()) / 86_400_000));
  const age = days < 30 ? `${days}d` : days < 365 ? `${Math.round(days / 30)}mo` : `${(days / 365).toFixed(1)}y`;
  const units = a.visitParts.reduce((n, p) => n + p.quantity, 0);
  return [
    { label: a.warranty.status === 'expired' ? 'Warranty expired' : 'Warranty', value: warranty.value, tone: warranty.tone, hint: a.warranty.end ? `Ends ${fmtDate(a.warranty.end)}` : 'No warranty on file' },
    { label: a.amc.status === 'expired' ? 'AMC expired' : 'AMC', value: amc.value, tone: amc.tone, hint: a.amc.end ? `Ends ${fmtDate(a.amc.end)}` : 'No AMC on file' },
    { label: 'Open tickets', value: String(a.openTickets.length), tone: a.openTickets.length > 0 ? 'warn' : undefined },
    { label: 'Parts used', value: String(a.visitParts.length), hint: a.visitParts.length ? `${units} unit${units === 1 ? '' : 's'} across field visits` : undefined },
    { label: a.purchaseDate ? 'Age' : 'In register', value: age, hint: a.purchaseDate ? `Purchased ${fmtDate(a.purchaseDate)}` : `Created ${fmtDate(a.createdAt)}` },
  ];
}
