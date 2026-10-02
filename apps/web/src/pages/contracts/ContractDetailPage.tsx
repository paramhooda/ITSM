import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight, RefreshCw, Play, Ban, Layers, MessageSquare, Info, ShieldCheck, GitBranch, FileCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Badge, Card, Dialog, Drawer, ConfirmDialog, LoadingBlock, ErrorBlock, EmptyState, DataTable, Checkbox, Field, Input, type Column } from '@/components/ui';
import { get, post, patch, put, del, ApiError } from '@/api/client';
import type { MenuItem } from '@/components/Menu';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RecordAttention, RelatedTabs, ActivityStream, useAuditStream, RailTabs, RailCard, RailRows, type FormSection, type StreamEntry } from '@/components/record';
import { contractAttention } from '@/components/record/attention';
import { humanizeAction } from '@/components/audit/AuditTrail';
import { useListState } from '@/hooks/useListState';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { fmtDate, fmtDateTime, fmtDuration, fmtNumber, titleCase } from '@/lib/format';
import { ContractForm, ServiceCoverageEditor, SiteMultiSelect, type ContractPayload } from '@/components/contracts/ContractForm';
import { ContractStatusBadge, ExpiryCountdown, DocTick, PERIOD_LABELS } from '@/components/contracts/ContractBits';
import { EntitlementBar } from '@/components/contracts/EntitlementBar';
import { EntitlementForm, ConsumptionForm, type EntitlementPayload, type ConsumptionPayload } from '@/components/contracts/EntitlementForms';
import { ScopeTable, ScopeItemForm, BulkScopeForm, type ScopeItemPayload } from '@/components/contracts/ScopeTable';
import { EscalationMatrixEditor } from '@/components/contracts/EscalationMatrixEditor';
import { OptionalAttachmentList } from '@/components/customers/OptionalModules';
import type { ContractDetail, Entitlement, Consumption, ScopeItem, ServiceCoverageInput, EscalationLevel } from '@/components/contracts/types';
import type { Contact, Site } from '@/components/customers/types';
import { PRIORITY_LEVEL_COLORS } from '@/lib/statusColors';

const errMsg = (e: unknown) => (e as ApiError)?.message ?? 'Request failed';
const DOC_TYPES = [{ value: 'agreement', label: 'Signed agreement' }, { value: 'sow', label: 'Statement of work' }, { value: 'report', label: 'Report' }, { value: 'other', label: 'Other' }];

interface HistoryRow { id: string; occurredAt: string; userName: string | null; entityType: string; entityId: string | null; entityLabel: string | null; action: string; changes: Record<string, { old: unknown; new: unknown }>; source: string }

/** Entitlement, consumption and scope changes from `/contracts/:id/history`, in stream shape. */
const fromHistory = (r: HistoryRow): StreamEntry => ({
  id: r.id,
  at: r.occurredAt,
  actor: r.userName ?? (r.source && r.source !== 'ui' ? titleCase(r.source) : 'System'),
  kind: 'event',
  title: `${humanizeAction(r.action)} · ${titleCase(r.entityType)}${r.entityLabel ? ` ${r.entityLabel}` : ''}`,
  changes: r.changes && Object.keys(r.changes).length ? r.changes : undefined,
  icon: /delete|remove/.test(r.action) ? 'escalation' : /create|consume/.test(r.action) ? 'created' : 'update',
  tone: /delete|remove/.test(r.action) ? 'bad' : undefined,
});

export default function ContractDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const isCustomer = useAuthStore((s) => s.user?.userType === 'customer');
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const { set: setParams } = useListState();
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

  // Activity: the contract's own audit rows, plus child-entity rows (entitlements, consumption, scope) from the history endpoint.
  const audit = useAuditStream('contract', id);
  const history = useQuery({ queryKey: ['contracts', id, 'history'], queryFn: () => get<{ items: HistoryRow[] }>(`/contracts/${id}/history`), enabled: !!id, staleTime: 30_000 });
  const entries = useMemo<StreamEntry[]>(() => {
    const seen = new Set(audit.entries.map((e) => e.id));
    const extra = (history.data?.items ?? []).filter((r) => !seen.has(r.id) && (audit.isError || r.entityType !== 'contract')).map(fromHistory);
    return [...audit.entries, ...extra];
  }, [audit.entries, audit.isError, history.data]);

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['contracts'] }); qc.invalidateQueries({ queryKey: ['audit', 'entity', 'contract', id] }); if (c) qc.invalidateQueries({ queryKey: ['customers', c.customerId] }); };
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
  const goTo = (tab: string) => setParams({ tab }, false);
  // What needs attention (MSP staff only): running out, no SLA policy, nothing covered, unsigned, entitlements used up.
  const attention = isCustomer ? [] : contractAttention(c, { onRenew: canManage && canRenew ? () => setRenewing(true) : undefined, onEdit: canManage ? () => setEditing(true) : undefined });

  // ---- header: two primary actions, the rest in the overflow menu
  const primary = canManage ? (
    <>
      {canActivate ? (
        <Button size="sm" icon={<Play className="h-3.5 w-3.5" />} onClick={() => activate.mutate()} loading={activate.isPending}>Activate</Button>
      ) : canRenew ? (
        <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setRenewing(true)}>Renew</Button>
      ) : null}
      <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(true)}>Edit</Button>
    </>
  ) : undefined;
  const menu: MenuItem[] = canManage
    ? [
        ...(canActivate && canRenew ? [{ label: 'Renew…', icon: <RefreshCw className="h-4 w-4" />, onClick: () => setRenewing(true) }] : []),
        ...(canTerminate ? [{ label: 'Terminate contract…', icon: <Ban className="h-4 w-4" />, onClick: () => setTerminating(true), danger: true }] : []),
        ...(c.status === 'draft' ? [{ label: 'Delete draft', icon: <Trash2 className="h-4 w-4" />, onClick: () => setDeleting(true), danger: true }] : []),
      ]
    : [];

  // ---- form
  const hasCommitments = !!(c.responseCommitment || c.resolutionCommitment || c.exclusions);
  const sections: FormSection[] = [
    {
      key: 'contract',
      title: 'Contract',
      fields: [
        { label: 'Customer', value: c.customer ? <Link to={`/customers/${c.customer.id}`} className="hover:underline">{c.customer.name}</Link> : null },
        { label: 'Owner', value: c.ownerName },
        { label: 'Start', value: fmtDate(c.startDate) },
        { label: 'End', value: <ExpiryCountdown days={c.daysToExpiry} endDate={c.endDate} status={c.status} /> },
        { label: 'Renewal date', value: c.renewalDate ? fmtDate(c.renewalDate) : null },
        { label: 'Notice period', value: c.noticePeriodDays != null ? `${c.noticePeriodDays} days` : null },
        { label: 'Signed on', value: c.signedAt ? fmtDate(c.signedAt) : null },
        { label: 'Auto-renew', value: c.autoRenew ? 'Yes' : 'No' },
        { label: 'SLA policy', value: c.slaPolicyId ? <Link to={`/sla/${c.slaPolicyId}`} className="hover:underline">{c.slaPolicyName}</Link> : <span className="text-subtle">Platform default</span> },
        { label: 'Support hours', value: c.supportHoursCalendarName ?? <span className="text-subtle">Policy calendar</span> },
        { label: 'Holiday calendar', value: c.holidayCalendarName },
        { label: 'Description', value: c.description ?? '', kind: 'prose', span: 2, hidden: !c.description },
      ],
    },
    {
      key: 'commitments',
      title: 'Commitments',
      columns: 1,
      hidden: !hasCommitments,
      fields: [
        { label: 'Response', value: c.responseCommitment ?? '', kind: 'prose' },
        { label: 'Resolution', value: c.resolutionCommitment ?? '', kind: 'prose' },
        { label: 'Exclusions', value: c.exclusions ?? '', kind: 'prose' },
      ],
    },
  ];

  // ---- related lists (keys kept so ?tab=services / ?tab=entitlements deep links still land)
  const tabs = [
    { key: 'services', label: 'Services & Sites', count: c.services.length, content: <ServicesTab c={c} canManage={canManage} /> },
    { key: 'entitlements', label: 'Entitlements', count: c.entitlements.filter((e) => e.isActive).length, content: <EntitlementsTab c={c} canManage={canManage} canConsume={canManage || can('field:execute')} /> },
    { key: 'scope', label: 'Scope', count: c.scopeItems.length, content: <ScopeTab c={c} canManage={canManage} /> },
    { key: 'sla', label: 'SLA', content: <SlaTab c={c} /> },
    { key: 'escalation', label: 'Escalation matrix', count: c.escalationMatrix.length, content: <EscalationTab c={c} canManage={canManage} onSave={(m) => update.mutate({ escalationMatrix: m } as Partial<ContractPayload>)} saving={update.isPending} /> },
    { key: 'documents', label: 'Documents', count: c.documents.count, content: <Card><OptionalAttachmentList entityType="contract" entityId={c.id} customerId={c.customerId} canUpload={canManage} canDelete={canManage} showVisibility docTypes={DOC_TYPES} fallback={<DocumentsFallback c={c} />} /></Card> },
  ];

  // ---- rail: SLA, renewal lineage, document checklist
  const overrides = c.services.filter((s) => s.slaPolicyId);
  const lineage = (x: { id: string; number: string; name: string; status: string; startDate: string; endDate: string }) => (
    <span className="inline-flex flex-col items-end">
      <Link to={`/contracts/${x.id}`} className="font-mono text-[12.5px] hover:underline">{x.number}</Link>
      <span className="text-[11.5px] text-subtle">{fmtDate(x.startDate)} – {fmtDate(x.endDate)}</span>
    </span>
  );
  const details = (
    <>
      <RailCard title={<><ShieldCheck className="h-3.5 w-3.5 text-subtle" /> SLA policy</>} action={<button type="button" onClick={() => goTo('sla')} className="text-[12px] text-brand-700 hover:underline">Targets</button>}>
        <RailRows
          rows={[
            { label: 'Policy', value: c.slaPolicyId ? <Link to={`/sla/${c.slaPolicyId}`} className="hover:underline">{c.slaPolicyName}</Link> : <span className="text-subtle">Platform default</span> },
            { label: 'Support hours', value: c.supportHoursCalendarName ?? <span className="text-subtle">Policy calendar</span> },
            { label: 'Holidays', value: c.holidayCalendarName },
            { label: 'Service overrides', value: overrides.length ? overrides.map((s) => <span key={s.serviceId} className="block">{s.serviceName} → {s.slaPolicyName}</span>) : <span className="text-subtle">None</span> },
          ]}
        />
      </RailCard>
      {(c.parent || c.children.length > 0) && (
        <RailCard title={<><GitBranch className="h-3.5 w-3.5 text-subtle" /> Renewal lineage</>}>
          <RailRows
            rows={[
              { label: 'Renewal of', value: c.parent ? lineage(c.parent) : null, hidden: !c.parent },
              ...c.children.map((ch, i) => ({ label: i === 0 ? 'Renewed by' : '', value: lineage(ch) })),
            ]}
          />
        </RailCard>
      )}
      <RailCard title={<><FileCheck className="h-3.5 w-3.5 text-subtle" /> Documents</>} action={<button type="button" onClick={() => goTo('documents')} className="text-[12px] text-brand-700 hover:underline">Manage</button>}>
        <div className="flex flex-col gap-1.5">
          <DocTick ok={c.documents.signedAgreement} label="Signed agreement" />
          <DocTick ok={c.documents.sow} label="Statement of work" />
          {!c.documents.signedAgreement && ['active', 'expiring'].includes(c.status) && <Badge color="amber" className="self-start mt-1">Active without signed agreement</Badge>}
        </div>
      </RailCard>
    </>
  );

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'Contracts', to: '/contracts' }, ...(c.customer ? [{ label: c.customer.name, to: `/customers/${c.customer.id}` }] : []), { label: c.number }]}
            number={c.number}
            title={c.name}
            badges={c.typeLabel ? <Badge color="slate">{c.typeLabel}</Badge> : undefined}
            controls={<ContractStatusBadge status={c.status} label={c.statusLabel} color={c.statusColor} />}
            primary={primary}
            menu={menu}
            createdAt={c.createdAt}
            updatedAt={c.updatedAt}
          >
            <RecordRibbon items={glance(c)} columns={4} />
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
              { key: 'activity', label: 'Activity', icon: MessageSquare, badge: entries.length, content: <ActivityStream entries={entries} loading={audit.isLoading || history.isLoading} maxHeight="calc(100vh - 220px)" /> },
              { key: 'details', label: 'Details', icon: Info, content: details },
            ]}
          />
        }
      />

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
    </>
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
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
      <Card padded={false} className="xl:col-span-2" title="Covered services" actions={canManage && <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setServices(c.services.map((s) => ({ serviceId: s.serviceId, slaPolicyId: s.slaPolicyId, teamId: s.teamId, supportHoursCalendarId: s.supportHoursCalendarId, notes: s.notes }))); setEditServices(true); }}>Edit coverage</Button>}>
        <DataTable columns={columns} rows={c.services.map((s) => ({ ...s, id: s.serviceId }))} dense empty={<EmptyState icon={<Layers className="h-5 w-5" />} title="No services covered" description="Tickets stay out of scope until a service is added." />} />
      </Card>
      <Card title="Covered sites" actions={canManage && <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setSiteIds(c.sites.map((s) => s.id)); setEditSites(true); }}>Edit</Button>}>
        {c.allSites ? (
          <Badge color="slate">All customer sites</Badge>
        ) : (
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
    <Card padded={false} actions={<><Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />{canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>Add entitlement</Button>}</>}>
      {rows.length === 0 ? <EmptyState title="No entitlements" description="Consumable allowances per period: visits, hours, incidents." /> : (
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
        <td className="text-[12.5px] text-muted">Warn at {e.warnThresholdPct}%<br />{e.overageAllowed ? 'Overage allowed' : 'No overage'}</td>
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
  if (!rows.length) return <div className="text-[12.5px] text-subtle py-1">No consumption recorded.</div>;
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
    <div className="flex flex-col gap-3">
      <Card padded={false} title={c.slaPolicyId ? <Link to={`/sla/${c.slaPolicyId}`} className="hover:underline">{c.slaPolicyName}</Link> : 'Contract SLA policy'}>
        {!policyId && <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No contract-level SLA policy" description="Tickets use the service default or the platform default." />}
        {policyId && q.isLoading && <LoadingBlock />}
        {policyId && q.isError && <EmptyState title="SLA policy details unavailable" description={(q.error as ApiError)?.status === 404 ? 'Policy not found or the SLA module is not deployed.' : errMsg(q.error)} />}
        {q.data && (
          <>
            <div className="px-4 py-2 border-b border-default">
              <RailRows
                rows={[
                  { label: 'Description', value: q.data.description, hidden: !q.data.description },
                  { label: 'Calendar', value: `${q.data.calendarName ?? 'default'}${q.data.calendarIs24x7 ? ' (24x7)' : ''}` },
                  { label: 'Holidays', value: q.data.holidayCalendarName, hidden: !q.data.holidayCalendarName },
                ]}
              />
            </div>
            {q.data.targets.length === 0 ? (
              <EmptyState title="No targets defined" />
            ) : (
              <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
                <thead><tr><th>Ticket type</th><th>Priority</th><th>Metric</th><th>Target</th><th>Warn at</th><th>Clock</th></tr></thead>
                <tbody>
                  {q.data.targets.map((t) => (
                    <tr key={t.id}><td>{titleCase(t.ticketType)}</td><td>{t.priorityLabel ? <Badge color={PRIORITY_LEVEL_COLORS[t.priorityLevel ?? 0] ?? 'slate'}>{t.priorityLabel}</Badge> : <span className="text-muted">Any</span>}</td><td>{titleCase(t.metric)}</td><td className="tabular-nums">{fmtDuration(t.minutes)}</td><td className="tabular-nums">{t.warnPct}%</td><td className="text-muted">{t.calendarTime ? '24x7 elapsed' : 'Business hours'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Card>
      {overrides.length > 0 && (
        <Card title="Per-service overrides">
          <RailRows rows={overrides.map((s) => ({ label: s.serviceName, value: <span>{s.slaPolicyName}{s.supportHoursCalendarName && <span className="text-muted"> · {s.supportHoursCalendarName}</span>}</span> }))} />
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- escalation matrix / documents fallback

function EscalationTab({ c, canManage, onSave, saving }: { c: ContractDetail; canManage: boolean; onSave: (m: EscalationLevel[]) => void; saving: boolean }) {
  const contacts = useQuery({ queryKey: ['customers', c.customerId, 'contacts', false], queryFn: () => get<Contact[]>(`/customers/${c.customerId}/contacts`) });
  return (
    <Card>
      <EscalationMatrixEditor value={c.escalationMatrix} contacts={contacts.data ?? []} canEdit={canManage} onSave={onSave} saving={saving} />
    </Card>
  );
}

function DocumentsFallback({ c }: { c: ContractDetail }) {
  if (!c.documents.items.length) return <EmptyState title="No documents" description="Signed agreement and SOW go here." />;
  return (
    <ul className="divide-y divide-[var(--border)] text-[13px]">
      {c.documents.items.map((d) => <li key={d.id} className="py-1.5 flex items-center gap-2"><Badge color="slate">{titleCase(d.docType)}</Badge><span className="font-medium">{d.title ?? d.filename}</span><span className="text-subtle ml-auto">{fmtDateTime(d.createdAt)}</span></li>)}
    </ul>
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

// ---------------------------------------------------------------- at a glance

/** The numbers a manager wants before reading the related lists: time left, work, coverage and consumption. */
function glance(c: ContractDetail): { label: string; value: ReactNode; tone?: 'good' | 'warn' | 'bad'; hint?: string }[] {
  const active = c.entitlements.filter((e) => e.isActive);
  const hot = active.filter((e) => e.utilization.overThreshold || e.utilization.exhausted);
  const exhausted = active.filter((e) => e.utilization.exhausted).length;
  const ended = ['terminated', 'renewed'].includes(c.status);
  const expiry =
    c.status === 'expired'
      ? { label: 'Expired', value: `${fmtNumber(Math.abs(c.daysToExpiry))}d ago`, tone: 'bad' as const }
      : ended
        ? { label: titleCase(c.status), value: fmtDate(c.endDate), tone: undefined }
        : { label: 'Days to expiry', value: fmtNumber(Math.max(0, c.daysToExpiry)), tone: c.daysToExpiry <= 30 ? ('bad' as const) : c.daysToExpiry <= 90 ? ('warn' as const) : ('good' as const) };
  const items: { label: string; value: ReactNode; tone?: 'good' | 'warn' | 'bad'; hint?: string }[] = [
    { ...expiry, hint: `${fmtDate(c.startDate)} → ${fmtDate(c.endDate)}${c.autoRenew ? ' · auto-renews' : ''}` },
    { label: 'Open tickets', value: <Link to={`/tickets?contractId=${c.id}&open=true`} className="hover:underline">{fmtNumber(c.tickets.open)}</Link>, hint: `${fmtNumber(c.tickets.total)} raised under this contract` },
    { label: 'Covered services', value: fmtNumber(c.services.length), hint: c.slaPolicyName ? `SLA: ${c.slaPolicyName}` : 'Platform default SLA' },
    { label: 'Entitlements near limit', value: fmtNumber(hot.length), tone: exhausted > 0 ? 'bad' : hot.length > 0 ? 'warn' : active.length > 0 ? 'good' : undefined, hint: `${fmtNumber(active.length)} active · ${fmtNumber(exhausted)} exhausted` },
  ];
  return items;
}
