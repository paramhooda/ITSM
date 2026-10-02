import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight, RefreshCw, Play, Ban, Layers, History, Ticket, Gauge, CalendarClock, Banknote } from 'lucide-react';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { toast } from 'sonner';
import { PageHeader, Button, Badge, Tabs, Card, Dialog, Drawer, ConfirmDialog, LoadingBlock, ErrorBlock, EmptyState, DataTable, Checkbox, KeyValue, Field, Input, type Column } from '@/components/ui';
import { get, post, patch, put, del, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { fmtDate, fmtDateTime, fmtDuration, fmtMoney, fmtNumber, relativeTime, titleCase } from '@/lib/format';
import { ContractForm, ServiceCoverageEditor, SiteMultiSelect, type ContractPayload } from '@/components/contracts/ContractForm';
import { ContractStatusBadge, ExpiryCountdown, DocTick, PERIOD_LABELS } from '@/components/contracts/ContractBits';
import { EntitlementBar } from '@/components/contracts/EntitlementBar';
import { EntitlementForm, ConsumptionForm, type EntitlementPayload, type ConsumptionPayload } from '@/components/contracts/EntitlementForms';
import { ScopeTable, ScopeItemForm, BulkScopeForm, type ScopeItemPayload } from '@/components/contracts/ScopeTable';
import { EscalationMatrixEditor } from '@/components/contracts/EscalationMatrixEditor';
import { OptionalAttachmentList, OptionalAuditTrail } from '@/components/customers/OptionalModules';
import type { ContractDetail, Entitlement, Consumption, ScopeItem, ServiceCoverageInput, EscalationLevel } from '@/components/contracts/types';
import type { Contact, Site } from '@/components/customers/types';

type TabKey = 'overview' | 'services' | 'entitlements' | 'scope' | 'sla' | 'documents' | 'history';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'services', label: 'Services & Sites' },
  { key: 'entitlements', label: 'Entitlements' },
  { key: 'scope', label: 'Scope' },
  { key: 'sla', label: 'SLA' },
  { key: 'documents', label: 'Documents' },
  { key: 'history', label: 'History' },
];
const errMsg = (e: unknown) => (e as ApiError)?.message ?? 'Request failed';
const DOC_TYPES = [{ value: 'agreement', label: 'Signed agreement' }, { value: 'po', label: 'Purchase order' }, { value: 'sow', label: 'Statement of work' }, { value: 'report', label: 'Report' }, { value: 'other', label: 'Other' }];

export default function ContractDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabKey) || 'overview';
  const setTab = (t: TabKey) => setParams((p) => { p.set('tab', t); return p; }, { replace: true });
  const [editing, setEditing] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const contract = useQuery({ queryKey: ['contracts', id], queryFn: () => get<ContractDetail>(`/contracts/${id}`), enabled: !!id });
  const c = contract.data;
  const canManage = !!c && can('contracts:manage');
  useEffect(() => {
    if (c) setAssistantContext({ label: `${c.number} ${c.name}`, entityType: 'contract', entityId: id, customerId: c.customerId });
    return () => setAssistantContext(null);
  }, [c, id, setAssistantContext]);

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['contracts'] }); if (c) qc.invalidateQueries({ queryKey: ['customers', c.customerId] }); };
  const update = useMutation({
    mutationFn: (body: Partial<ContractPayload>) => patch<ContractDetail>(`/contracts/${id}`, body),
    onSuccess: () => { invalidate(); setEditing(false); toast.success('Contract updated'); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const activate = useMutation({ mutationFn: () => post<ContractDetail>(`/contracts/${id}/activate`, {}), onSuccess: (r) => { invalidate(); toast.success(`Contract is now ${r.statusLabel.toLowerCase()}`); }, onError: (e) => toast.error(errMsg(e)) });
  const terminate = useMutation({ mutationFn: (reason: string) => post(`/contracts/${id}/terminate`, { reason: reason || null }), onSuccess: () => { invalidate(); setTerminating(false); toast.success('Contract terminated'); }, onError: (e) => toast.error(errMsg(e)) });
  const remove = useMutation({ mutationFn: () => del(`/contracts/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['contracts'] }); toast.success('Draft contract deleted'); navigate('/contracts'); }, onError: (e) => toast.error(errMsg(e)) });
  const renew = useMutation({
    mutationFn: (body: { startDate: string; endDate: string; number?: string; carryEntitlements: boolean }) => post<ContractDetail>(`/contracts/${id}/renew`, body),
    onSuccess: (r) => { invalidate(); setRenewing(false); toast.success(`Renewal ${r.number} created as draft`); navigate(`/contracts/${r.id}`); },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (contract.isLoading) return <LoadingBlock />;
  if (contract.isError || !c) return <ErrorBlock error={contract.error} retry={() => contract.refetch()} />;
  const canActivate = ['draft', 'expired', 'terminated'].includes(c.status);
  const canRenew = ['active', 'expiring', 'expired'].includes(c.status);
  const canTerminate = !['terminated', 'renewed'].includes(c.status);

  return (
    <div>
      <PageHeader
        breadcrumb={<span><Link to="/contracts" className="hover:underline">Contracts</Link> {c.customer && <>/ <Link to={`/customers/${c.customer.id}`} className="hover:underline">{c.customer.name}</Link></>}</span>}
        title={<span className="flex items-center gap-2 flex-wrap"><span className="font-mono text-[15px]">{c.number}</span><span>{c.name}</span><ContractStatusBadge status={c.status} label={c.statusLabel} color={c.statusColor} /></span>}
        subtitle={<span className="flex items-center gap-2 flex-wrap">{c.typeLabel && <span>{c.typeLabel} ·</span>}<span>{fmtDate(c.startDate)} →</span><ExpiryCountdown days={c.daysToExpiry} endDate={c.endDate} status={c.status} />{c.ownerName && <span>· Owner: {c.ownerName}</span>}{c.parent && <span>· Renewal of <Link to={`/contracts/${c.parent.id}`} className="hover:underline">{c.parent.number}</Link></span>}{c.children.length > 0 && <span>· Renewed by {c.children.map((ch) => <Link key={ch.id} to={`/contracts/${ch.id}`} className="hover:underline mr-1">{ch.number}</Link>)}</span>}</span>}
        actions={canManage && (
          <>
            {canActivate && <Button variant="primary" icon={<Play className="h-4 w-4" />} onClick={() => activate.mutate()} loading={activate.isPending}>Activate</Button>}
            {canRenew && <Button variant="outline" icon={<RefreshCw className="h-4 w-4" />} onClick={() => setRenewing(true)}>Renew</Button>}
            {canTerminate && <Button variant="outline" icon={<Ban className="h-4 w-4" />} onClick={() => setTerminating(true)}>Terminate</Button>}
            <Button variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>
            {c.status === 'draft' && <Button variant="ghost" size="icon" title="Delete draft" onClick={() => setDeleting(true)}><Trash2 className="h-4 w-4 text-red-500" /></Button>}
          </>
        )}
      />
      <ContractStats c={c} />
      <Tabs tabs={TABS.map((t) => ({ ...t, count: t.key === 'services' ? c.services.length : t.key === 'entitlements' ? c.entitlements.filter((e) => e.isActive).length : t.key === 'scope' ? c.scopeItems.length : t.key === 'documents' ? c.documents.count : undefined }))} value={tab} onChange={setTab} className="mb-4" />

      {tab === 'overview' && <OverviewTab c={c} canManage={canManage} onSaveMatrix={(m) => update.mutate({ escalationMatrix: m } as Partial<ContractPayload>)} saving={update.isPending} goTo={setTab} />}
      {tab === 'services' && <ServicesTab c={c} canManage={canManage} />}
      {tab === 'entitlements' && <EntitlementsTab c={c} canManage={canManage} canConsume={canManage || can('field:execute')} />}
      {tab === 'scope' && <ScopeTab c={c} canManage={canManage} />}
      {tab === 'sla' && <SlaTab c={c} />}
      {tab === 'documents' && <Card title="Documents"><div className="flex flex-wrap gap-4 mb-3"><DocTick ok={c.documents.signedAgreement} label="Signed agreement" /><DocTick ok={c.documents.purchaseOrder} label="Purchase order" /><DocTick ok={c.documents.sow} label="Statement of work" /></div><OptionalAttachmentList entityType="contract" entityId={c.id} customerId={c.customerId} canUpload={canManage} canDelete={canManage} showVisibility docTypes={DOC_TYPES} fallback={<DocumentsFallback c={c} />} /></Card>}
      {tab === 'history' && <HistoryTab c={c} />}

      <Drawer open={editing} onClose={() => setEditing(false)} title={`Edit ${c.number}`} width="max-w-3xl">
        {editing && <ContractForm mode="edit" initial={c} onSubmit={(b) => update.mutate(b)} onCancel={() => setEditing(false)} submitting={update.isPending} />}
      </Drawer>
      <Dialog open={renewing} onClose={() => setRenewing(false)} title={`Renew ${c.number}`}>
        {renewing && <RenewForm c={c} onSubmit={(b) => renew.mutate(b)} onCancel={() => setRenewing(false)} submitting={renew.isPending} />}
      </Dialog>
      <Dialog open={terminating} onClose={() => setTerminating(false)} title="Terminate contract" width="max-w-md">
        {terminating && <TerminateForm onSubmit={(r) => terminate.mutate(r)} onCancel={() => setTerminating(false)} submitting={terminate.isPending} />}
      </Dialog>
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger title="Delete draft contract?" confirmLabel="Delete" description="The draft and its coverage, entitlements and scope items are removed permanently." />
    </div>
  );
}

// ---------------------------------------------------------------- overview

function OverviewTab({ c, canManage, onSaveMatrix, saving, goTo }: { c: ContractDetail; canManage: boolean; onSaveMatrix: (m: EscalationLevel[]) => void; saving: boolean; goTo: (t: TabKey) => void }) {
  const contacts = useQuery({ queryKey: ['customers', c.customerId, 'contacts', false], queryFn: () => get<Contact[]>(`/customers/${c.customerId}/contacts`) });
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <Card title="Contract" className="xl:col-span-2">
        <KeyValue
          columns={3}
          items={[
            { label: 'Customer', value: c.customer ? <Link to={`/customers/${c.customer.id}`} className="hover:underline">{c.customer.name}</Link> : '—' },
            { label: 'Type', value: c.typeLabel ?? '—' },
            { label: 'Owner', value: c.ownerName ?? '—' },
            { label: 'Start', value: fmtDate(c.startDate) },
            { label: 'End', value: <ExpiryCountdown days={c.daysToExpiry} endDate={c.endDate} status={c.status} /> },
            { label: 'Renewal date', value: c.renewalDate ? fmtDate(c.renewalDate) : '—' },
            { label: 'Notice period', value: c.noticePeriodDays != null ? `${c.noticePeriodDays} days` : '—' },
            { label: 'Auto-renew', value: c.autoRenew ? 'Yes' : 'No' },
            { label: 'SLA policy', value: c.slaPolicyId ? <Link to={`/sla/${c.slaPolicyId}`} className="hover:underline">{c.slaPolicyName}</Link> : <span className="text-subtle">Platform default</span> },
            { label: 'Support hours', value: c.supportHoursCalendarName ?? <span className="text-subtle">Policy calendar</span> },
            { label: 'Holiday calendar', value: c.holidayCalendarName ?? '—' },
            { label: 'Tickets', value: <span>{c.tickets.open} open · {c.tickets.total} total</span> },
            { label: 'Response commitment', value: c.responseCommitment ?? '—', span: 3 },
            { label: 'Resolution commitment', value: c.resolutionCommitment ?? '—', span: 3 },
            { label: 'Exclusions', value: c.exclusions ? <span className="whitespace-pre-wrap">{c.exclusions}</span> : '—', span: 3 },
            { label: 'Description', value: c.description ? <span className="whitespace-pre-wrap">{c.description}</span> : '—', span: 3 },
          ]}
        />
      </Card>
      <div className="space-y-4">
        {c.canViewCommercial && (
          <Card title="Commercial">
            <KeyValue columns={2} items={[
              { label: 'Value', value: c.value != null ? fmtMoney(c.value, c.currency ?? 'INR') : '—' },
              { label: 'Currency', value: c.currency ?? '—' },
              { label: 'Billing cycle', value: c.billingCycle ? titleCase(c.billingCycle) : '—' },
              { label: 'PO number', value: c.poNumber ?? '—' },
              { label: 'Signed on', value: c.signedAt ? fmtDate(c.signedAt) : '—' },
            ]} />
          </Card>
        )}
        <Card title="Documents" actions={<button className="text-xs text-brand-600 hover:underline" onClick={() => goTo('documents')}>Manage</button>}>
          <div className="flex flex-col gap-2">
            <DocTick ok={c.documents.signedAgreement} label="Signed agreement" />
            <DocTick ok={c.documents.purchaseOrder} label="Purchase order" />
            <DocTick ok={c.documents.sow} label="Statement of work" />
          </div>
          {!c.documents.signedAgreement && ['active', 'expiring'].includes(c.status) && <div className="text-xs text-amber-600 mt-2">Active contract without a signed agreement on file.</div>}
        </Card>
      </div>
      <Card title="Escalation matrix" className="xl:col-span-3">
        <EscalationMatrixEditor value={c.escalationMatrix} contacts={contacts.data ?? []} canEdit={canManage} onSave={onSaveMatrix} saving={saving} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- services & sites

function ServicesTab({ c, canManage }: { c: ContractDetail; canManage: boolean }) {
  const qc = useQueryClient();
  const [editServices, setEditServices] = useState(false);
  const [editSites, setEditSites] = useState(false);
  const [services, setServices] = useState<ServiceCoverageInput[]>([]);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['contracts', c.id] });
  const saveServices = useMutation({ mutationFn: () => put(`/contracts/${c.id}/services`, { services }), onSuccess: () => { invalidate(); setEditServices(false); toast.success('Covered services updated'); }, onError: (e) => toast.error(errMsg(e)) });
  const saveSites = useMutation({ mutationFn: () => put(`/contracts/${c.id}/sites`, { siteIds }), onSuccess: () => { invalidate(); setEditSites(false); toast.success('Covered sites updated'); }, onError: (e) => toast.error(errMsg(e)) });
  const columns: Column<ContractDetail['services'][number]>[] = [
    { key: 'serviceName', header: 'Service', render: (s) => <span className="font-medium flex items-center gap-2">{s.serviceName}<Badge color="slate">{s.domain}</Badge></span> },
    { key: 'sla', header: 'SLA policy', render: (s) => <span>{s.effectiveSlaPolicyName ?? <span className="text-subtle">Platform default</span>}{s.slaPolicyName ? <Badge color="blue" className="ml-1.5">override</Badge> : <span className="text-subtle text-xs ml-1.5">{c.slaPolicyId ? 'contract' : 'service default'}</span>}</span> },
    { key: 'teamName', header: 'Team', render: (s) => s.teamName ?? <span className="text-subtle">Service default</span> },
    { key: 'supportHoursCalendarName', header: 'Support hours', render: (s) => s.supportHoursCalendarName ?? c.supportHoursCalendarName ?? <span className="text-subtle">Policy calendar</span> },
    { key: 'notes', header: 'Notes', render: (s) => <span className="text-muted">{s.notes ?? '—'}</span> },
  ];
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <Card padded={false} className="xl:col-span-2" title="Covered services" actions={canManage && <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setServices(c.services.map((s) => ({ serviceId: s.serviceId, slaPolicyId: s.slaPolicyId, teamId: s.teamId, supportHoursCalendarId: s.supportHoursCalendarId, notes: s.notes }))); setEditServices(true); }}>Edit coverage</Button>}>
        <DataTable columns={columns} rows={c.services.map((s) => ({ ...s, id: s.serviceId }))} dense empty={<EmptyState icon={<Layers className="h-5 w-5" />} title="No services covered" description="Tickets for this customer will be classified out of scope until services are added." />} />
      </Card>
      <Card title="Covered sites" actions={canManage && <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setSiteIds(c.sites.map((s) => s.id)); setEditSites(true); }}>Edit</Button>}>
        {c.allSites ? <div className="text-[13px] text-muted">All sites of the customer are covered.</div> : (
          <ul className="space-y-1 text-[13px]">
            {c.sites.map((s) => <li key={s.id} className="flex items-center gap-2"><span className="font-mono text-[11.5px] text-subtle">{s.code}</span>{s.name}{s.isPrimary && <Badge color="blue">Primary</Badge>}{!s.isActive && <Badge color="gray">Inactive</Badge>}</li>)}
          </ul>
        )}
      </Card>
      <Dialog open={editServices} onClose={() => setEditServices(false)} title="Covered services" width="max-w-3xl" footer={<><Button variant="ghost" onClick={() => setEditServices(false)}>Cancel</Button><Button onClick={() => saveServices.mutate()} loading={saveServices.isPending}>Save</Button></>}>
        <ServiceCoverageEditor value={services} onChange={setServices} />
      </Dialog>
      <Dialog open={editSites} onClose={() => setEditSites(false)} title="Covered sites" footer={<><Button variant="ghost" onClick={() => setEditSites(false)}>Cancel</Button><Button onClick={() => saveSites.mutate()} loading={saveSites.isPending}>Save</Button></>}>
        <SiteMultiSelect customerId={c.customerId} value={siteIds} onChange={setSiteIds} />
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- entitlements

function EntitlementsTab({ c, canManage, canConsume }: { c: ContractDetail; canManage: boolean; canConsume: boolean }) {
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Entitlement | 'new' | null>(null);
  const [consuming, setConsuming] = useState<Entitlement | null>(null);
  const [deleting, setDeleting] = useState<Entitlement | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['contracts', c.id] }); qc.invalidateQueries({ queryKey: ['entitlements'] }); };
  const save = useMutation({
    mutationFn: (body: EntitlementPayload) => (editing && editing !== 'new' ? patch(`/entitlements/${editing.id}`, body) : post(`/contracts/${c.id}/entitlements`, body)),
    onSuccess: () => { invalidate(); setEditing(null); toast.success('Entitlement saved'); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const consume = useMutation({
    mutationFn: (body: ConsumptionPayload) => post<{ utilization: Entitlement['utilization']; notification: string | null; overage: boolean }>(`/entitlements/${consuming!.id}/consume`, body),
    onSuccess: (r) => { invalidate(); setConsuming(null); toast.success(r.overage ? 'Consumption recorded (overage)' : `Consumption recorded · ${fmtNumber(r.utilization.pct)}% used`); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (e: Entitlement) => del<{ deleted?: boolean; deactivated?: boolean }>(`/entitlements/${e.id}`),
    onSuccess: (r) => { invalidate(); setDeleting(null); toast.success(r.deactivated ? 'Entitlement has consumption history and was deactivated' : 'Entitlement deleted'); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const rows = c.entitlements.filter((e) => showInactive || e.isActive);
  const serviceIds = c.services.map((s) => s.serviceId);
  return (
    <Card padded={false} title="Entitlements" actions={<><Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />{canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>Add entitlement</Button>}</>}>
      {rows.length === 0 ? <EmptyState title="No entitlements" description="Entitlements track consumable allowances such as site visits, engineering hours or incidents per period." /> : (
        <table className="table">
          <thead>
            <tr>
              <th className="w-8"></th>
              <th>Entitlement</th>
              <th className="w-[38%]">Utilisation</th>
              <th>Period</th>
              <th>Rules</th>
              <th className="w-44"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <EntitlementRow key={e.id} e={e} open={expanded === e.id} onToggle={() => setExpanded(expanded === e.id ? null : e.id)} canManage={canManage} canConsume={canConsume} onConsume={() => setConsuming(e)} onEdit={() => setEditing(e)} onDelete={() => setDeleting(e)} />
            ))}
          </tbody>
        </table>
      )}
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add entitlement' : 'Edit entitlement'} width="max-w-2xl">
        {editing && <EntitlementForm initial={editing === 'new' ? undefined : editing} contractServiceIds={serviceIds} onSubmit={(b) => save.mutate(b)} onCancel={() => setEditing(null)} submitting={save.isPending} />}
      </Dialog>
      <Dialog open={!!consuming} onClose={() => setConsuming(null)} title="Record consumption">
        {consuming && <ConsumptionForm entitlement={consuming} onSubmit={(b) => consume.mutate(b)} onCancel={() => setConsuming(null)} submitting={consume.isPending} />}
      </Dialog>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)} loading={remove.isPending} danger title="Delete entitlement?" confirmLabel="Delete" description={`${deleting?.name}: entitlements with consumption history are deactivated instead of removed.`} />
    </Card>
  );
}

function EntitlementRow({ e, open, onToggle, canManage, canConsume, onConsume, onEdit, onDelete }: { e: Entitlement; open: boolean; onToggle: () => void; canManage: boolean; canConsume: boolean; onConsume: () => void; onEdit: () => void; onDelete: () => void }) {
  const u = e.utilization;
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td className="text-subtle">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
        <td>
          <div className="font-medium flex items-center gap-2">{e.name}{!e.isActive && <Badge color="gray">Inactive</Badge>}</div>
          <div className="text-xs text-muted">{[e.typeLabel, e.serviceName ?? 'Any service'].filter(Boolean).join(' · ')}</div>
        </td>
        <td><EntitlementBar entitlement={{ ...e, name: '' }} compact /><div className="text-[11px] text-subtle mt-0.5">{fmtNumber(u.remaining, 2)} {e.unit} remaining{u.exhausted && ' · exhausted'}</div></td>
        <td className="text-[12.5px]"><div>{PERIOD_LABELS[e.period] ?? e.period}</div><div className="text-xs text-muted whitespace-nowrap">{fmtDate(u.periodStart)} – {fmtDate(u.periodEnd)}</div></td>
        <td className="text-[12.5px] text-muted">Warn at {e.warnThresholdPct}%<br />{e.overageAllowed ? `Overage allowed${e.overageRate != null ? ` @ ${e.overageRate}/${e.unit}` : ''}` : 'No overage'}</td>
        <td onClick={(ev) => ev.stopPropagation()}>
          <div className="flex items-center justify-end gap-1">
            {canConsume && e.isActive && <Button size="sm" variant="outline" onClick={onConsume}>Record</Button>}
            {canManage && <Button variant="ghost" size="icon" onClick={onEdit} title="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
            {canManage && <Button variant="ghost" size="icon" onClick={onDelete} title="Delete"><Trash2 className="h-3.5 w-3.5 text-red-500" /></Button>}
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td></td>
          <td colSpan={5} className="bg-surface-2/40"><ConsumptionHistory entitlement={e} canManage={canManage} /></td>
        </tr>
      )}
    </>
  );
}

function ConsumptionHistory({ entitlement, canManage }: { entitlement: Entitlement; canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['entitlements', entitlement.id, 'consumptions'], queryFn: () => get<Consumption[]>(`/entitlements/${entitlement.id}/consumptions`) });
  const remove = useMutation({ mutationFn: (id: string) => del(`/entitlement-consumptions/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['entitlements'] }); qc.invalidateQueries({ queryKey: ['contracts', entitlement.contractId] }); toast.success('Consumption removed'); }, onError: (e) => toast.error(errMsg(e)) });
  if (q.isLoading) return <LoadingBlock label="Loading history…" />;
  const rows = q.data ?? [];
  if (!rows.length) return <div className="text-[13px] text-muted py-1">No consumption recorded.</div>;
  return (
    <table className="table [&_td]:py-1 [&_th]:py-1">
      <thead><tr><th>When</th><th>Quantity</th><th>Source</th><th>Ticket</th><th>By</th><th>Notes</th>{canManage && <th></th>}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="whitespace-nowrap">{fmtDateTime(r.consumedAt)}</td>
            <td className="tabular-nums">{fmtNumber(r.quantity, 2)} {entitlement.unit}</td>
            <td><Badge color="slate">{titleCase(r.sourceType)}</Badge></td>
            <td>{r.ticketId ? <Link to={`/tickets/${r.ticketId}`} className="hover:underline">{r.ticketNumber ?? 'ticket'}</Link> : '—'}</td>
            <td className="text-muted">{r.createdByName ?? 'system'}</td>
            <td className="text-muted">{r.notes ?? '—'}</td>
            {canManage && <td className="text-right">{r.sourceType === 'manual' && <Button variant="ghost" size="icon" title="Remove" onClick={() => remove.mutate(r.id)}><Trash2 className="h-3.5 w-3.5 text-red-500" /></Button>}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- scope

function ScopeTab({ c, canManage }: { c: ContractDetail; canManage: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<ScopeItem | 'new' | 'bulk' | null>(null);
  const [deleting, setDeleting] = useState<ScopeItem | null>(null);
  const sites = useQuery({ queryKey: ['customers', c.customerId, 'sites', false], queryFn: () => get<Site[]>(`/customers/${c.customerId}/sites`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['contracts', c.id] });
  const save = useMutation({
    mutationFn: (body: ScopeItemPayload) => (editing && editing !== 'new' && editing !== 'bulk' ? patch(`/scope-items/${editing.id}`, body) : post(`/contracts/${c.id}/scope`, body)),
    onSuccess: () => { invalidate(); setEditing(null); toast.success('Scope item saved'); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const bulk = useMutation({ mutationFn: (items: ScopeItemPayload[]) => post<unknown[]>(`/contracts/${c.id}/scope/bulk`, { items }), onSuccess: (r) => { invalidate(); setEditing(null); toast.success(`${(r as unknown[]).length} scope items added`); }, onError: (e) => toast.error(errMsg(e)) });
  const remove = useMutation({ mutationFn: (s: ScopeItem) => del(`/scope-items/${s.id}`), onSuccess: () => { invalidate(); setDeleting(null); toast.success('Scope item deleted'); }, onError: (e) => toast.error(errMsg(e)) });
  const serviceIds = c.services.map((s) => s.serviceId);
  const siteList = (sites.data ?? []).filter((s) => c.allSites || c.sites.some((x) => x.id === s.id));
  return (
    <div>
      {canManage && (
        <div className="flex justify-end gap-2 mb-3">
          <Button size="sm" variant="outline" onClick={() => setEditing('bulk')}>Bulk add</Button>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>Add scope item</Button>
        </div>
      )}
      <ScopeTable groups={c.scopeGroups} canManage={canManage} onEdit={(i) => setEditing(i)} onDelete={(i) => setDeleting(i)} />
      <Dialog open={editing !== null && editing !== 'bulk'} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add scope item' : 'Edit scope item'} width="max-w-2xl">
        {editing && editing !== 'bulk' && <ScopeItemForm initial={editing === 'new' ? undefined : editing} sites={siteList} contractServiceIds={serviceIds} onSubmit={(b) => save.mutate(b)} onCancel={() => setEditing(null)} submitting={save.isPending} />}
      </Dialog>
      <Dialog open={editing === 'bulk'} onClose={() => setEditing(null)} title="Bulk add scope items" width="max-w-2xl">
        {editing === 'bulk' && <BulkScopeForm sites={siteList} contractServiceIds={serviceIds} onSubmit={(items) => bulk.mutate(items)} onCancel={() => setEditing(null)} submitting={bulk.isPending} />}
      </Dialog>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)} loading={remove.isPending} danger title="Delete scope item?" confirmLabel="Delete" description={deleting?.name} />
    </div>
  );
}

// ---------------------------------------------------------------- SLA

interface SlaPolicy { id: string; name: string; description: string | null; calendarName: string | null; calendarIs24x7: boolean | null; holidayCalendarName: string | null; isDefault: boolean; targets: { id: string; ticketType: string; priorityLabel: string | null; priorityLevel: number | null; metric: string; minutes: number; warnPct: number; calendarTime: boolean }[] }

function SlaTab({ c }: { c: ContractDetail }) {
  const policyId = c.slaPolicyId;
  const q = useQuery({ queryKey: ['sla', 'policies', policyId], queryFn: () => get<SlaPolicy>(`/sla/policies/${policyId}`), enabled: !!policyId, retry: false });
  const overrides = c.services.filter((s) => s.slaPolicyId);
  return (
    <div className="space-y-4">
      <Card title={<span>Contract SLA policy: {c.slaPolicyId ? <Link to={`/sla/${c.slaPolicyId}`} className="hover:underline">{c.slaPolicyName}</Link> : 'platform default'}</span>} padded={!q.data}>
        {!policyId && <div className="text-[13px] text-muted">No contract-level SLA policy. Tickets use the service default or the platform default policy.</div>}
        {policyId && q.isLoading && <LoadingBlock />}
        {policyId && q.isError && <div className="text-[13px] text-muted">{(q.error as ApiError)?.status === 404 ? 'SLA policy details are not available (policy not found or the SLA module is not deployed).' : errMsg(q.error)}</div>}
        {q.data && (
          <>
            <div className="px-4 py-2 text-[13px] text-muted border-b border-default">{q.data.description ?? ''} Calendar: {q.data.calendarName ?? 'default'}{q.data.calendarIs24x7 && ' (24x7)'}{q.data.holidayCalendarName && ` · Holidays: ${q.data.holidayCalendarName}`}</div>
            <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
              <thead><tr><th>Ticket type</th><th>Priority</th><th>Metric</th><th>Target</th><th>Warn at</th><th>Clock</th></tr></thead>
              <tbody>
                {q.data.targets.map((t) => (
                  <tr key={t.id}><td>{titleCase(t.ticketType)}</td><td>{t.priorityLabel ?? 'Any'}</td><td>{titleCase(t.metric)}</td><td className="tabular-nums">{fmtDuration(t.minutes)}</td><td className="tabular-nums">{t.warnPct}%</td><td className="text-muted">{t.calendarTime ? '24x7 elapsed' : 'Business hours'}</td></tr>
                ))}
                {q.data.targets.length === 0 && <tr><td colSpan={6} className="text-muted">No targets defined.</td></tr>}
              </tbody>
            </table>
          </>
        )}
      </Card>
      {overrides.length > 0 && (
        <Card title="Per-service overrides">
          <ul className="space-y-1 text-[13px]">
            {overrides.map((s) => <li key={s.serviceId}><span className="font-medium">{s.serviceName}</span> → {s.slaPolicyName}{s.supportHoursCalendarName && <span className="text-muted"> · {s.supportHoursCalendarName}</span>}</li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- documents fallback / history

function DocumentsFallback({ c }: { c: ContractDetail }) {
  if (!c.documents.items.length) return <EmptyState title="No documents" description="Upload the signed agreement, purchase order and SOW through the attachments module." />;
  return (
    <ul className="divide-y divide-[var(--border)] text-[13px]">
      {c.documents.items.map((d) => <li key={d.id} className="py-1.5 flex items-center gap-2"><Badge color="slate">{titleCase(d.docType)}</Badge><span className="font-medium">{d.title ?? d.filename}</span><span className="text-subtle ml-auto">{fmtDateTime(d.createdAt)}</span></li>)}
    </ul>
  );
}

interface HistoryRow { id: string; occurredAt: string; userName: string | null; entityType: string; entityId: string | null; entityLabel: string | null; action: string; changes: Record<string, { old: unknown; new: unknown }>; source: string }

function HistoryList({ c, exclude }: { c: ContractDetail; exclude?: string[] }) {
  const q = useQuery({ queryKey: ['contracts', c.id, 'history'], queryFn: () => get<{ items: HistoryRow[] }>(`/contracts/${c.id}/history`) });
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  const rows = (q.data?.items ?? []).filter((r) => !exclude?.includes(r.entityType));
  if (!rows.length) return <EmptyState icon={<History className="h-5 w-5" />} title="No history" />;
  const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <ul className="divide-y divide-[var(--border)]">
      {rows.map((r) => (
        <li key={r.id} className="py-2 text-[13px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-subtle w-28 shrink-0" title={fmtDateTime(r.occurredAt)}>{relativeTime(r.occurredAt)}</span>
            <span className="font-medium">{r.userName ?? 'system'}</span>
            <span className="text-muted">{titleCase(r.action)}</span>
            <Badge color="slate">{titleCase(r.entityType)}</Badge>
            {r.entityLabel && <span className="truncate">{r.entityLabel}</span>}
          </div>
          {Object.keys(r.changes ?? {}).length > 0 && (
            <div className="ml-30 pl-[7.5rem] mt-1 text-xs text-muted space-y-0.5">
              {Object.entries(r.changes).slice(0, 8).map(([k, v]) => <div key={k}><span className="text-subtle">{titleCase(k)}:</span> {fmt(v.old)} → <span className="text-default">{fmt(v.new)}</span></div>)}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function HistoryTab({ c }: { c: ContractDetail }) {
  return (
    <div className="space-y-4">
      <Card title="Contract audit trail">
        <OptionalAuditTrail entityType="contract" entityId={c.id} fallback={<HistoryList c={c} exclude={['contract_entitlement', 'scope_item', 'entitlement_consumption']} />} />
      </Card>
      <Card title="Entitlement, consumption and scope changes">
        <HistoryList c={c} exclude={['contract']} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- lifecycle forms

function RenewForm({ c, onSubmit, onCancel, submitting }: { c: ContractDetail; onSubmit: (b: { startDate: string; endDate: string; number?: string; carryEntitlements: boolean }) => void; onCancel: () => void; submitting: boolean }) {
  const next = (d: string, days: number) => new Date(new Date(d + 'T00:00:00Z').getTime() + days * 86_400_000).toISOString().slice(0, 10);
  const start = next(c.endDate, 1);
  const termDays = Math.round((new Date(c.endDate + 'T00:00:00Z').getTime() - new Date(c.startDate + 'T00:00:00Z').getTime()) / 86_400_000);
  const [startDate, setStartDate] = useState(start);
  const [endDate, setEndDate] = useState(next(start, Math.max(30, termDays)));
  const [number, setNumber] = useState('');
  const [carry, setCarry] = useState(true);
  function submit(e: FormEvent) { e.preventDefault(); onSubmit({ startDate, endDate, number: number.trim() || undefined, carryEntitlements: carry }); }
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="text-[13px] text-muted">Creates a draft successor copying services, sites and scope. This contract is marked as renewed.</div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date" required><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required /></Field>
        <Field label="End date" required error={endDate < startDate ? 'Must be after start' : undefined}><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required /></Field>
        <Field label="Number" hint="Blank = generated" className="col-span-2"><Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="CTR-2027-0001" /></Field>
      </div>
      <Checkbox label="Carry entitlements over (quantities reset for the new term)" checked={carry} onChange={(e) => setCarry(e.target.checked)} />
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button type="submit" loading={submitting} disabled={endDate < startDate}>Create renewal</Button></div>
    </form>
  );
}

function TerminateForm({ onSubmit, onCancel, submitting }: { onSubmit: (reason: string) => void; onCancel: () => void; submitting: boolean }) {
  const [reason, setReason] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(reason); }} className="space-y-4">
      <div className="text-[13px] text-muted">The contract stops providing coverage immediately. Tickets, entitlements and scope history are retained.</div>
      <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer churned, replaced by…" autoFocus /></Field>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button type="submit" variant="danger" loading={submitting}>Terminate</Button></div>
    </form>
  );
}

// ---------------------------------------------------------------- stats strip

/** The numbers a manager wants before reading the tabs: work, service levels, consumption, time left and value. */
function ContractStats({ c }: { c: ContractDetail }) {
  const active = c.entitlements.filter((e) => e.isActive);
  const hot = active.filter((e) => e.utilization.overThreshold || e.utilization.exhausted);
  const exhausted = active.filter((e) => e.utilization.exhausted).length;
  const expiryTone = c.status === 'expired' || c.status === 'terminated' ? 'bad' : c.daysToExpiry <= 30 ? 'bad' : c.daysToExpiry <= 90 ? 'warn' : 'default';
  const items = [
    { label: 'Open tickets', value: fmtNumber(c.tickets.open), hint: `${fmtNumber(c.tickets.total)} raised under this contract`, icon: <Ticket className="h-4 w-4" />, onClick: () => (window.location.href = `/tickets?contractId=${c.id}&open=true`) },
    { label: 'Covered services', value: fmtNumber(c.services.length), hint: c.slaPolicyName ? `SLA: ${c.slaPolicyName}` : 'Platform default SLA', icon: <Layers className="h-4 w-4" /> },
    { label: 'Entitlements near limit', value: fmtNumber(hot.length), tone: exhausted > 0 ? 'bad' : hot.length > 0 ? 'warn' : 'good', hint: `${fmtNumber(active.length)} active · ${fmtNumber(exhausted)} exhausted`, icon: <Gauge className="h-4 w-4" /> },
    { label: c.status === 'expired' ? 'Expired' : 'Days to expiry', value: c.status === 'expired' ? `${fmtNumber(Math.abs(c.daysToExpiry))}d ago` : fmtNumber(Math.max(0, c.daysToExpiry)), tone: expiryTone, hint: `${fmtDate(c.startDate)} → ${fmtDate(c.endDate)}${c.autoRenew ? ' · auto-renews' : ''}`, icon: <CalendarClock className="h-4 w-4" /> },
  ] as const;
  const commercial = c.canViewCommercial && c.value != null ? { label: 'Contract value', value: fmtMoney(c.value, c.currency ?? 'INR'), hint: c.typeLabel ?? 'Annual', icon: <Banknote className="h-4 w-4" /> } : null;
  return (
    <div className="mb-5">
      <KpiGrid items={commercial ? [...items, commercial] : [...items]} columns={commercial ? 5 : 4} />
    </div>
  );
}
