import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2, Ban, Play, Plus, MessageSquare, Info, Package, FileSignature, HardDrive } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Badge, LoadingBlock, ErrorBlock, ConfirmDialog, EmptyState, DataTable, type Column } from '@/components/ui';
import type { MenuItem } from '@/components/Menu';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RelatedTabs, ActivityStream, useAuditStream, RailTabs, RailCard, RailRows, type FormSection } from '@/components/record';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useListState } from '@/hooks/useListState';
import { fmtDate, fmtDateTime, fmtNumber, relativeTime } from '@/lib/format';
import { errorMessage } from '@/components/cmdb/hooks';
import { ProductForm } from '@/components/software/ProductForm';
import { LicenceForm } from '@/components/software/LicenceForm';
import { InstallationForm } from '@/components/software/InstallationForm';
import { PositionBadge, LicenceStatusBadge, SourceBadge, UtilisationCell, TermCell, metricLabel, seats } from '@/components/software/SoftwareBits';
import { softwareApi, softwareKeys, LICENCE_MODEL_LABELS, hostOf, titleOf, type CompliancePosition, type SoftwareInstallation, type SoftwareLicence } from '@/components/software/api';

/** One catalogue title: its compliance position per customer, the installations and the licences behind it. */
export default function SoftwareTitlePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const { state } = useListState();
  const customerId = state.customerId || undefined;
  const q = useQuery({ queryKey: softwareKeys.product(id, customerId), queryFn: () => softwareApi.product(id, customerId), enabled: !!id });
  const audit = useAuditStream('software_product', id);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [licenceOpen, setLicenceOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const p = q.data;
  const canManage = !!p && can('software:manage');

  useEffect(() => {
    if (p) setAssistantContext({ label: `${p.publisher} ${p.name}`, entityType: 'software_product', entityId: p.id, customerId: null });
    return () => setAssistantContext(null);
  }, [p, setAssistantContext]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: softwareKeys.all });
    qc.invalidateQueries({ queryKey: ['audit', 'entity', 'software_product', id] });
  };
  const setActive = useMutation({ mutationFn: (isActive: boolean) => softwareApi.updateProduct(id, { isActive }), onSuccess: (_r, isActive) => { toast.success(isActive ? 'Title reactivated' : 'Title deactivated'); invalidate(); }, onError: (e) => toast.error(errorMessage(e)) });
  const remove = useMutation({ mutationFn: () => softwareApi.deleteProduct(id), onSuccess: () => { toast.success('Title deleted'); invalidate(); navigate('/assets/software/titles'); }, onError: (e) => { setDeleteOpen(false); toast.error(errorMessage(e, 'Deactivate the title instead')); } });

  if (q.isLoading) return <LoadingBlock />;
  if (q.isError || !p) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;

  const title = titleOf(p);
  const menu: MenuItem[] = canManage
    ? [
        p.isActive ? { label: 'Deactivate title', icon: <Ban className="h-4 w-4" />, onClick: () => setActive.mutate(false) } : { label: 'Reactivate title', icon: <Play className="h-4 w-4" />, onClick: () => setActive.mutate(true) },
        { label: 'Delete title', icon: <Trash2 className="h-4 w-4" />, onClick: () => setDeleteOpen(true), danger: true },
      ]
    : [];
  const sections: FormSection[] = [
    {
      key: 'identity',
      title: 'Identity',
      fields: [
        { label: 'Publisher', value: p.publisher },
        { label: 'Product', value: p.name },
        { label: 'Version family', value: p.versionFamily },
        { label: 'Category', value: p.categoryLabel },
        { label: 'Licence model', value: LICENCE_MODEL_LABELS[p.licenceModel] ?? p.licenceModel },
        { label: 'End of life', value: p.eolDate ? fmtDate(p.eolDate) : null },
        { label: 'Website', value: p.website ? <a href={p.website} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline break-all">{p.website}</a> : null },
        { label: 'Catalogue key', value: p.key, kind: 'mono' },
        { label: 'Tags', value: p.tags?.length ? <span className="flex flex-wrap gap-1">{p.tags.map((t) => <Badge key={t} color="slate">{t}</Badge>)}</span> : null },
        { label: 'Description', value: p.description ?? '', kind: 'prose', span: 2, hidden: !p.description },
      ],
    },
  ];

  const complianceCols: Column<CompliancePosition>[] = [
    { key: 'customer', header: 'Customer', render: (r) => <Link to={`/customers/${r.customerId}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">{r.customerName}</Link> },
    { key: 'metric', header: 'Metric', width: '110px', render: (r) => <span className="text-muted">{metricLabel(r.metric)}</span> },
    { key: 'installed', header: 'Installed', width: '90px', className: 'text-right tabular-nums', render: (r) => fmtNumber(r.installed) },
    { key: 'entitled', header: 'Entitled', width: '90px', className: 'text-right tabular-nums', render: (r) => (r.entitled === null ? 'Unlimited' : fmtNumber(r.entitled)) },
    { key: 'unused', header: 'Unused', width: '80px', className: 'text-right tabular-nums', render: (r) => (r.unused === null ? '—' : fmtNumber(r.unused)) },
    { key: 'utilisation', header: 'Utilisation', width: '170px', render: (r) => <UtilisationCell installed={r.installed} entitled={r.entitled} pct={r.utilisationPct} position={r.position} /> },
    { key: 'position', header: 'Position', width: '140px', render: (r) => <PositionBadge position={r.position} /> },
    { key: 'nextEndDate', header: 'Next end', width: '120px', render: (r) => (r.nextEndDate ? fmtDate(r.nextEndDate) : <span className="text-subtle">—</span>) },
  ];
  const installCols: Column<SoftwareInstallation>[] = [
    { key: 'host', header: 'Host', render: (i) => <div className="leading-tight"><div className="font-medium">{hostOf(i)}</div>{i.assignedUser && i.ciName && <div className="text-[11.5px] text-subtle">{i.assignedUser}</div>}</div> },
    { key: 'customer', header: 'Customer', render: (i) => i.customerName ?? '—' },
    { key: 'version', header: 'Version', width: '120px', render: (i) => <span className="font-mono text-xs">{i.version ?? '—'}</span> },
    { key: 'cores', header: 'Cores', width: '70px', className: 'text-right tabular-nums', render: (i) => i.cores ?? '—' },
    { key: 'source', header: 'Source', width: '140px', render: (i) => <SourceBadge source={i.source} /> },
    { key: 'lastSeenAt', header: 'Last seen', width: '120px', render: (i) => <span className={i.stale ? 'text-amber-600' : 'text-muted'}>{i.lastSeenAt ? relativeTime(i.lastSeenAt) : '—'}{i.stale ? ' · stale' : ''}</span> },
  ];
  const licenceCols: Column<SoftwareLicence>[] = [
    { key: 'name', header: 'Licence', render: (l) => <span className="font-medium">{l.name}</span> },
    { key: 'customer', header: 'Customer', render: (l) => l.customerName ?? '—' },
    { key: 'metric', header: 'Metric', width: '110px', render: (l) => <span className="text-muted">{metricLabel(l.metric)}</span> },
    { key: 'quantity', header: 'Seats', width: '110px', className: 'text-right tabular-nums', render: (l) => seats(l.metric === 'site' ? null : l.quantity, l.metric) },
    { key: 'term', header: 'Term', width: '190px', render: (l) => <TermCell startDate={l.startDate} endDate={l.endDate} daysLeft={l.daysLeft} status={l.status} /> },
    { key: 'contract', header: 'Contract', width: '120px', render: (l) => (l.contractNumber ? <span className="font-mono text-xs">{l.contractNumber}</span> : <span className="text-subtle">—</span>) },
    { key: 'status', header: 'Status', width: '110px', render: (l) => <LicenceStatusBadge status={l.status} /> },
  ];
  const tabs = [
    { key: 'compliance', label: 'Compliance by customer', count: p.compliance.length, content: <div className="card overflow-hidden"><DataTable columns={complianceCols} rows={p.compliance} dense rowKey={(r) => `${r.customerId}:${r.productId}`} rowClassName={(r) => (customerId && r.customerId === customerId ? 'bg-brand-50/60' : r.position === 'over_deployed' || r.position === 'unlicensed' ? 'row-rail-bad' : r.position === 'under_deployed' ? 'row-rail-warn' : undefined)} onRowClick={(r) => navigate(`/assets/software/compliance?customerId=${r.customerId}&productId=${r.productId}`)} empty={<EmptyState icon={<Package className="h-5 w-5" />} title="Not in use" description="No customer has an installation or a licence for this title." />} /></div> },
    { key: 'installations', label: 'Installations', count: p.installationCount, content: <div className="card overflow-hidden"><DataTable columns={installCols} rows={p.installations} dense onRowClick={(i) => navigate(`/assets/software/installations?productId=${p.id}&customerId=${i.customerId}`)} rowClassName={(i) => (i.stale ? 'row-rail-warn' : undefined)} empty={<EmptyState icon={<HardDrive className="h-5 w-5" />} title="No installations recorded" action={canManage ? <Button size="sm" onClick={() => setInstallOpen(true)}>Record installation</Button> : undefined} />} />{p.installations.length >= 100 && <div className="px-4 py-2 text-[12px] text-muted border-t border-default">Showing the 100 most recently seen. <Link to={`/assets/software/installations?productId=${p.id}`} className="text-brand-700 hover:underline">Open the full list</Link></div>}</div> },
    { key: 'licences', label: 'Licences', count: p.licences.length, content: <div className="card overflow-hidden"><DataTable columns={licenceCols} rows={p.licences} dense onRowClick={(l) => navigate(`/assets/software/licences/${l.id}`)} rowClassName={(l) => (l.status === 'expired' ? 'row-rail-bad' : l.status === 'expiring' ? 'row-rail-warn' : undefined)} empty={<EmptyState icon={<FileSignature className="h-5 w-5" />} title="No licences recorded" action={canManage && p.isActive ? <Button size="sm" onClick={() => setLicenceOpen(true)}>New licence</Button> : undefined} />} /></div> },
  ];

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'Assets', to: '/assets' }, { label: 'Software', to: '/assets/software' }, { label: 'Titles', to: '/assets/software/titles' }, { label: title }]}
            number={p.publisher}
            title={`${p.name}${p.versionFamily ? ` ${p.versionFamily}` : ''}`}
            badges={<><Badge color="indigo">{LICENCE_MODEL_LABELS[p.licenceModel] ?? p.licenceModel}</Badge>{!p.isActive && <Badge color="gray">inactive</Badge>}{p.categoryLabel && <Badge color="slate">{p.categoryLabel}</Badge>}</>}
            primary={canManage ? <><Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setInstallOpen(true)}>Record installation</Button>{p.isActive && <Button size="sm" variant="outline" icon={<FileSignature className="h-3.5 w-3.5" />} onClick={() => setLicenceOpen(true)}>New licence</Button>}<Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditOpen(true)}>Edit</Button></> : undefined}
            menu={menu}
            createdAt={p.createdAt}
            updatedAt={p.updatedAt}
          >
            <RecordRibbon
              columns={5}
              items={[
                { label: 'Installations', value: fmtNumber(p.installationCount), hint: customerId ? 'at this customer' : 'live hosts, counted by metric' },
                { label: 'Customers', value: fmtNumber(p.customerCount) },
                { label: 'Licensed seats', value: fmtNumber(p.licensedSeats), hint: 'licences in term' },
                { label: 'Over-deployed customers', value: fmtNumber(p.overDeployedCustomers), tone: p.overDeployedCustomers ? 'bad' : 'good', hint: 'over-deployed or unlicensed' },
                { label: 'End of life', value: p.eolDate ? fmtDate(p.eolDate) : '—', tone: p.eolDate && p.eolDate < new Date().toISOString().slice(0, 10) ? 'warn' : undefined },
              ]}
            />
          </RecordHeader>
        }
        main={
          <>
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
                    <RailCard title="Catalogue">
                      <RailRows rows={[{ label: 'Key', value: <span className="font-mono text-[11px]">{p.key}</span> }, { label: 'Model', value: LICENCE_MODEL_LABELS[p.licenceModel] ?? p.licenceModel }, { label: 'Active', value: p.isActive ? 'Yes' : 'No' }, { label: 'Created', value: fmtDateTime(p.createdAt) }, { label: 'Updated', value: fmtDateTime(p.updatedAt) }]} />
                    </RailCard>
                    <RailCard title="Positions">
                      {p.compliance.length ? <RailRows rows={p.compliance.slice(0, 8).map((r) => ({ label: r.customerName, value: <PositionBadge position={r.position} /> }))} /> : <div className="text-[12.5px] text-subtle">Not in use at any customer.</div>}
                    </RailCard>
                  </>
                ),
              },
            ]}
          />
        }
      />
      <ProductForm open={editOpen} onClose={() => setEditOpen(false)} product={p} />
      <LicenceForm open={licenceOpen} onClose={() => setLicenceOpen(false)} defaultProductId={p.id} defaultCustomerId={customerId} onSaved={(l) => navigate(`/assets/software/licences/${l.id}`)} />
      <InstallationForm open={installOpen} onClose={() => setInstallOpen(false)} defaultProductId={p.id} defaultCustomerId={customerId} />
      <ConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger confirmLabel="Delete title" title={`Delete ${title}?`} description="A title with installations or licences cannot be deleted; deactivate it instead so it keeps its history." />
    </>
  );
}
