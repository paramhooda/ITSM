import { lazy, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2, RefreshCw, MessageSquare, Info, Eye, EyeOff, HardDrive, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { get } from '@/api/client';
import { Button, Badge, Card, LoadingBlock, ErrorBlock, ConfirmDialog, EmptyState, DataTable, type Column } from '@/components/ui';
import type { MenuItem } from '@/components/Menu';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RecordAttention, RelatedTabs, ActivityStream, useAuditStream, RailTabs, RailCard, RailRows, type FormSection } from '@/components/record';
import { licenceAttention } from '@/components/record/attention';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, relativeTime } from '@/lib/format';
import { LazyBlock } from '@/components/cmdb/LazyBlock';
import { errorMessage } from '@/components/cmdb/hooks';
import { LicenceForm } from '@/components/software/LicenceForm';
import { PositionBadge, LicenceStatusBadge, SourceBadge, TermCell, metricLabel, seats } from '@/components/software/SoftwareBits';
import { softwareApi, softwareKeys, LICENCE_TERM_LABELS, LICENCE_MODEL_LABELS, daysLeftText, daysLeftClass, hostOf, titleOf, type SoftwareInstallation } from '@/components/software/api';

const AttachmentList = lazy(() => import('@/components/attachments/AttachmentList').then((m) => ({ default: m.AttachmentList ?? m.default })));
const DOC_TYPES = [{ value: 'invoice', label: 'Invoice' }, { value: 'agreement', label: 'Licence agreement' }, { value: 'certificate', label: 'Licence certificate' }, { value: 'other', label: 'Other' }];

/** One licence: the term and seats against installations, the contract, the proof of purchase and the renewal lineage. */
export default function LicencePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const q = useQuery({ queryKey: softwareKeys.licence(id), queryFn: () => softwareApi.licence(id), enabled: !!id });
  const audit = useAuditStream('software_licence', id);
  const attachments = useQuery({ queryKey: ['attachments', 'software_licence', id], queryFn: () => get<{ items: { id: string }[] }>('/attachments', { entityType: 'software_licence', entityId: id }), enabled: !!id, staleTime: 30_000 });
  const [editOpen, setEditOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const l = q.data;
  const canManage = !!l && can('software:manage');

  useEffect(() => {
    if (l) setAssistantContext({ label: l.name, entityType: 'software_licence', entityId: l.id, customerId: l.customerId });
    return () => setAssistantContext(null);
  }, [l, setAssistantContext]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: softwareKeys.all });
    qc.invalidateQueries({ queryKey: ['overview', 'software'] });
    qc.invalidateQueries({ queryKey: ['audit', 'entity', 'software_licence', id] });
  };
  const remove = useMutation({ mutationFn: () => softwareApi.deleteLicence(id), onSuccess: () => { toast.success('Licence deleted'); invalidate(); navigate('/assets/software/licences'); }, onError: (e) => toast.error(errorMessage(e)) });

  if (q.isLoading) return <LoadingBlock />;
  if (q.isError || !l) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;

  const title = titleOf(l);
  const complianceTo = `/assets/software/compliance?customerId=${l.customerId}&productId=${l.productId}`;
  const canRenew = canManage && !l.successorId && l.isActive;
  const attention = licenceAttention(l, Date.now(), { onRenew: canRenew ? () => setRenewOpen(true) : undefined, attachments: attachments.data ? attachments.data.items.length : undefined, complianceTo });
  const entitled = l.compliance?.entitled ?? (l.metric === 'site' ? null : l.quantity);
  const menu: MenuItem[] = canManage ? [{ label: 'Delete licence', icon: <Trash2 className="h-4 w-4" />, onClick: () => setDeleteOpen(true), danger: true }] : [];
  const lineage = (x: { id: string; name: string; startDate: string | null; endDate: string | null }) => (
    <span className="inline-flex flex-col items-end text-right">
      <Link to={`/assets/software/licences/${x.id}`} className="font-medium text-[12.5px] text-brand-700 hover:underline">{x.name}</Link>
      <span className="text-[11.5px] text-subtle">{x.startDate ? fmtDate(x.startDate) : '…'} – {x.endDate ? fmtDate(x.endDate) : 'no end'}</span>
    </span>
  );

  const sections: FormSection[] = [
    {
      key: 'licence',
      title: 'Licence',
      fields: [
        { label: 'Customer', value: <Link to={`/customers/${l.customerId}`} className="hover:underline">{l.customerName ?? 'Customer'}</Link> },
        { label: 'Title', value: <Link to={`/assets/software/titles/${l.productId}?customerId=${l.customerId}`} className="hover:underline">{title}</Link> },
        { label: 'Name', value: l.name },
        { label: 'Metric', value: metricLabel(l.metric) },
        { label: 'Seats', value: seats(l.metric === 'site' ? null : l.quantity, l.metric) },
        { label: 'Term type', value: LICENCE_TERM_LABELS[l.term] ?? l.term },
        { label: 'Licence model', value: LICENCE_MODEL_LABELS[l.licenceModel] ?? l.licenceModel },
        { label: 'Owner', value: l.ownerName },
        { label: 'Active', value: l.isActive ? 'Yes' : 'No' },
      ],
    },
    {
      key: 'term',
      title: 'Term and renewal',
      fields: [
        { label: 'Starts', value: l.startDate ? fmtDate(l.startDate) : null },
        { label: 'Ends', value: l.endDate ? <span className="inline-flex items-center gap-2">{fmtDate(l.endDate)}<Badge color={l.status === 'renewed' ? 'blue' : l.daysLeft !== null && l.daysLeft < 0 ? 'red' : l.daysLeft !== null && l.daysLeft <= 30 ? 'amber' : 'green'} dot>{l.status === 'renewed' ? 'renewed' : daysLeftText(l.daysLeft, l.endDate)}</Badge></span> : <span className="text-subtle">No end date (perpetual)</span> },
        { label: 'Renewal date', value: l.renewalDate ? fmtDate(l.renewalDate) : null },
        { label: 'Auto-renew', value: l.autoRenew ? 'Yes' : 'No' },
        { label: 'Contract', value: l.contract ? <Link to={`/contracts/${l.contract.id}`} className="hover:underline"><span className="font-mono text-[12.5px]">{l.contract.number}</span> · {l.contract.name}</Link> : null },
        { label: 'Continues', value: l.predecessor ? lineage(l.predecessor) : null, hidden: !l.predecessor },
        { label: 'Renewed as', value: l.successor ? lineage(l.successor) : null, hidden: !l.successor },
        { label: 'Renewal recorded', value: l.renewedAt ? fmtDateTime(l.renewedAt) : null, hidden: !l.renewedAt },
      ],
    },
    {
      key: 'commercial',
      title: 'Commercial',
      fields: [
        { label: 'Cost', value: l.cost !== null ? fmtMoney(l.cost, l.currency ?? 'INR') : null },
        { label: 'Currency', value: l.currency },
        { label: 'Vendor', value: l.vendor },
        { label: 'PO number', value: l.poNumber, kind: 'mono' },
        { label: 'Invoice number', value: l.invoiceNumber, kind: 'mono' },
        { label: 'Licence key', value: l.licenceKey ? <span className="inline-flex items-center gap-2"><span className="font-mono text-[12.5px]">{showKey ? l.licenceKey : '•'.repeat(Math.min(24, l.licenceKey.length))}</span><button type="button" className="text-subtle hover:text-default" aria-label={showKey ? 'Hide licence key' : 'Reveal licence key'} onClick={() => setShowKey((s) => !s)}>{showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button></span> : null },
        { label: 'Notes', value: l.notes ?? '', kind: 'prose', span: 2, hidden: !l.notes },
      ],
    },
  ];

  const installCols: Column<SoftwareInstallation>[] = [
    { key: 'host', header: 'Host', render: (i) => <div className="leading-tight"><div className="font-medium">{hostOf(i)}</div>{i.assignedUser && i.ciName && <div className="text-[11.5px] text-subtle">{i.assignedUser}</div>}</div> },
    { key: 'version', header: 'Version', width: '120px', render: (i) => <span className="font-mono text-xs">{i.version ?? '—'}</span> },
    { key: 'cores', header: 'Cores', width: '70px', className: 'text-right tabular-nums', render: (i) => i.cores ?? '—' },
    { key: 'source', header: 'Source', width: '140px', render: (i) => <SourceBadge source={i.source} /> },
    { key: 'lastSeenAt', header: 'Last seen', width: '120px', render: (i) => <span className={i.stale ? 'text-amber-600' : 'text-muted'}>{i.lastSeenAt ? relativeTime(i.lastSeenAt) : '—'}{i.stale ? ' · stale' : ''}</span> },
  ];
  const tabs = [
    { key: 'installations', label: 'Installations', count: l.installed, content: <div className="card overflow-hidden"><DataTable columns={installCols} rows={l.installations} dense onRowClick={() => navigate(`/assets/software/installations?productId=${l.productId}&customerId=${l.customerId}`)} rowClassName={(i) => (i.stale ? 'row-rail-warn' : undefined)} empty={<EmptyState icon={<HardDrive className="h-5 w-5" />} title="No installations of this title at the customer" description="Seats are counted against the installations recorded on live hosts." />} />{l.installations.length >= 100 && <div className="px-4 py-2 text-[12px] text-muted border-t border-default">Showing the 100 most recently seen. <Link to={`/assets/software/installations?productId=${l.productId}&customerId=${l.customerId}`} className="text-brand-700 hover:underline">Open the full list</Link></div>}</div> },
    { key: 'documents', label: 'Proof of purchase', count: attachments.data?.items.length, content: <Card><LazyBlock fallback={<EmptyState title="Attachments are not available" />}><AttachmentList entityType="software_licence" entityId={l.id} customerId={l.customerId} canUpload={canManage} canDelete={canManage} docTypes={DOC_TYPES} /></LazyBlock></Card> },
  ];

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'Assets', to: '/assets' }, { label: 'Software', to: '/assets/software' }, { label: 'Licences', to: '/assets/software/licences' }, { label: l.name }]}
            number={l.customerCode ?? undefined}
            title={l.name}
            badges={<><LicenceStatusBadge status={l.status} /><Badge color="slate">{title}</Badge></>}
            primary={canManage ? <>{canRenew && <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setRenewOpen(true)}>Renew</Button>}<Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditOpen(true)}>Edit</Button></> : undefined}
            menu={menu}
            createdAt={l.createdAt}
            updatedAt={l.updatedAt}
          >
            <RecordRibbon
              columns={5}
              items={[
                { label: 'Seats', value: l.metric === 'site' ? 'Unlimited' : fmtNumber(l.quantity), hint: metricLabel(l.metric) },
                { label: 'Installed', value: fmtNumber(l.installed), hint: 'of this title at the customer', tone: entitled !== null && l.installed > entitled ? 'bad' : undefined },
                { label: 'Utilisation', value: l.utilisationPct === null ? '—' : `${l.utilisationPct}%`, tone: l.compliance?.position === 'over_deployed' || l.compliance?.position === 'unlicensed' ? 'bad' : l.compliance?.position === 'under_deployed' ? 'warn' : l.compliance ? 'good' : undefined, hint: l.compliance ? `${fmtNumber(l.compliance.installed)} / ${l.compliance.entitled === null ? 'unlimited' : fmtNumber(l.compliance.entitled)} across the customer's licences` : undefined },
                { label: l.status === 'expired' ? 'Expired' : 'Ends', value: l.endDate ? daysLeftText(l.daysLeft, l.endDate) : '—', tone: l.status === 'renewed' ? undefined : l.daysLeft === null ? undefined : l.daysLeft < 0 ? 'bad' : l.daysLeft <= 30 ? 'warn' : 'good', hint: l.endDate ? `${fmtDate(l.endDate)}${l.status === 'renewed' ? ' · renewed' : ''}` : 'Perpetual' },
                { label: 'Contract', value: l.contract?.number ?? '—', hint: l.contract?.name },
              ]}
            />
          </RecordHeader>
        }
        main={
          <>
            <RecordAttention items={attention} />
            <RecordForm sections={sections} />
            <RelatedTabs tabs={tabs} />
          </>
        }
        aside={
          <RailTabs
            tabs={[
              { key: 'activity', label: 'Activity', icon: MessageSquare, badge: audit.entries.length, content: <ActivityStream entries={audit.entries} loading={audit.isLoading} maxHeight="calc(100vh - 220px)" /> },
              {
                key: 'details',
                label: 'Details',
                icon: Info,
                content: (
                  <>
                    <RailCard title={<><ShieldCheck className="h-3.5 w-3.5 text-subtle" /> Compliance</>} action={<Link to={complianceTo} className="text-[12px] text-brand-700 hover:underline">Compliance</Link>}>
                      {l.compliance ? (
                        <RailRows rows={[{ label: 'Position', value: <PositionBadge position={l.compliance.position} /> }, { label: 'Installed', value: fmtNumber(l.compliance.installed) }, { label: 'Entitled', value: l.compliance.entitled === null ? 'Unlimited' : fmtNumber(l.compliance.entitled) }, { label: 'Unused', value: l.compliance.unused === null ? '—' : fmtNumber(l.compliance.unused) }, { label: 'Licences in term', value: fmtNumber(l.compliance.licencesActive) }, { label: 'Next end', value: l.compliance.nextEndDate ? <span className={daysLeftClass(l.daysLeft)}>{fmtDate(l.compliance.nextEndDate)}</span> : '—' }, { label: 'Stale installs', value: fmtNumber(l.compliance.stale), hidden: !l.compliance.stale }]} />
                      ) : (
                        <div className="text-[12.5px] text-subtle">No installation or licence in term for this title.</div>
                      )}
                    </RailCard>
                    <RailCard title="Term">
                      <TermCell startDate={l.startDate} endDate={l.endDate} daysLeft={l.daysLeft} status={l.status} />
                    </RailCard>
                    <RailCard title="Record">
                      <RailRows rows={[{ label: 'Created', value: fmtDateTime(l.createdAt) }, { label: 'Updated', value: fmtDateTime(l.updatedAt) }, { label: 'ID', value: <span className="font-mono text-[11px]">{l.id.slice(0, 8)}…</span> }]} />
                    </RailCard>
                  </>
                ),
              },
            ]}
          />
        }
      />
      <LicenceForm open={editOpen} onClose={() => setEditOpen(false)} mode="edit" licence={l} />
      <LicenceForm open={renewOpen} onClose={() => setRenewOpen(false)} mode="renew" licence={l} onSaved={(n) => navigate(`/assets/software/licences/${n.id}`)} />
      <ConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger confirmLabel="Delete licence" title={`Delete ${l.name}?`} description="The entitlement is removed and the title's position is recomputed. Attachments on this licence are removed with it. This cannot be undone." />
    </>
  );
}
