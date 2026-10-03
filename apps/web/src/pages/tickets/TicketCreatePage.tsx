import { useEffect, useMemo, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Flame, Save, X } from 'lucide-react';
import { PageHeader, Button, Card, Field, Input, Textarea, Select, Checkbox, Badge } from '@/components/ui';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { get } from '@/api/client';
import { cn } from '@/lib/utils';
import { ticketsApi, itemsOf } from '@/components/tickets/api';
import { CatalogForm } from '@/components/tickets/CatalogForm';
import { EntityPicker, type PickerItem } from '@/components/tickets/EntityPicker';
import { ScopeBadge } from '@/components/tickets/ScopeBadge';
import { PriorityBadge } from '@/components/tickets/PriorityBadge';
import { TypeBadge } from '@/components/tickets/TicketStatusBadge';
import type { TicketType, CatalogItem, ScopeStatus } from '@/components/tickets/types';
import { ClassifyDraftButton } from '@/components/ai/ClassifyDraftButton';
import { FilePicker, pastedFiles } from '@/components/attachments/FilePicker';
import { addFiles, uploadAttachments, reportUploadFailures, UPLOAD_HINT } from '@/components/attachments/upload';

const TYPES: { key: TicketType; label: string; hint: string }[] = [
  { key: 'incident', label: 'Incident', hint: 'Something is broken or degraded' },
  { key: 'request', label: 'Service request', hint: 'Access, software, provisioning…' },
  { key: 'problem', label: 'Problem', hint: 'Root cause of recurring incidents' },
  { key: 'change', label: 'Change', hint: 'Planned modification with approval' },
];

interface FormState {
  type: TicketType;
  customerId: string;
  siteId: string;
  serviceId: string;
  contractId: string;
  title: string;
  description: string;
  categoryId: string;
  subcategoryId: string;
  impactId: string;
  urgencyId: string;
  priorityId: string;
  securitySeverityId: string;
  assignedTeamId: string;
  assigneeId: string;
  catalogItemId: string;
  formData: Record<string, unknown>;
  tags: string;
  isMajor: boolean;
  changeType: string;
  riskId: string;
  scheduledStart: string;
  scheduledEnd: string;
  implementationPlan: string;
  backoutPlan: string;
  justification: string;
  symptoms: string;
}

const empty = (type: TicketType, customerId = ''): FormState => ({ type, customerId, siteId: '', serviceId: '', contractId: '', title: '', description: '', categoryId: '', subcategoryId: '', impactId: '', urgencyId: '', priorityId: '', securitySeverityId: '', assignedTeamId: '', assigneeId: '', catalogItemId: '', formData: {}, tags: '', isMajor: false, changeType: 'normal', riskId: '', scheduledStart: '', scheduledEnd: '', implementationPlan: '', backoutPlan: '', justification: '', symptoms: '' });

const nn = (v: string) => (v ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Prefill parameters (from the assistant or a link): ids must be well formed, text is capped. */
const idParam = (v: string | null) => (v && UUID.test(v) ? v : '');
const textParam = (v: string | null, max: number) => (v ?? '').slice(0, max);

export default function TicketCreatePage() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const user = useAuthStore((s) => s.user)!;
  const isCustomer = user.userType === 'customer';
  const { options, byId, lookups } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const [f, setF] = useState<FormState>(() => ({
    ...empty((search.get('type') as TicketType) || 'incident', isCustomer ? (user.customerId ?? '') : idParam(search.get('customerId'))),
    title: textParam(search.get('title'), 300),
    description: textParam(search.get('description'), 20000),
    priorityId: isCustomer ? '' : idParam(search.get('priorityId')),
    serviceId: idParam(search.get('serviceId')),
    siteId: idParam(search.get('siteId')),
    categoryId: idParam(search.get('categoryId')),
    catalogItemId: idParam(search.get('catalogItemId')),
  }));
  const mounted = useRef(false);
  const [cis, setCis] = useState<PickerItem[]>([]);
  const [assets, setAssets] = useState<PickerItem[]>([]);
  // Files chosen now are uploaded to the ticket right after it is created.
  const [files, setFiles] = useState<File[]>([]);
  const [filesVisible, setFilesVisible] = useState(true);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const patch = (p: Partial<FormState>) => setF((s) => ({ ...s, ...p }));

  const customerItems = itemsOf<{ id: string; name: string; code: string }>(customers.data);
  const sites = useQuery({ queryKey: ['customers', f.customerId, 'sites'], queryFn: () => get<unknown>(`/customers/${f.customerId}/sites`).then((d) => itemsOf<{ id: string; name: string; code: string }>(d)), enabled: !!f.customerId, retry: false });
  const contracts = useQuery({ queryKey: ['contracts', 'lookup', f.customerId], queryFn: () => get<unknown>('/contracts', { customerId: f.customerId, status: 'active', pageSize: 100 }).then((d) => itemsOf<{ id: string; number: string; name: string }>(d)), enabled: !!f.customerId && !isCustomer, retry: false });
  const catalog = useQuery({ queryKey: ['catalog', 'items', isCustomer ? 'portal' : 'all'], queryFn: () => get<unknown>('/catalog/items', isCustomer ? { portal: true } : { portal: false }).then((d) => itemsOf<CatalogItem>(d)), enabled: f.type === 'request', retry: false });
  const matrix = useQuery({ queryKey: ['config', 'priority-matrix'], queryFn: () => get<{ impactId: string; urgencyId: string; priorityId: string }[]>('/config/priority-matrix'), staleTime: 5 * 60_000 });
  const scope = useQuery({
    queryKey: ['tickets', 'scope-preview', f.customerId, f.serviceId, f.siteId, f.categoryId, cis[0]?.id],
    queryFn: () => ticketsApi.scopePreview({ customerId: f.customerId, serviceId: nn(f.serviceId), siteId: nn(f.siteId), ticketCategoryId: nn(f.categoryId), primaryCiId: cis[0]?.id ?? null }),
    enabled: !!f.customerId && (!!f.serviceId || !!f.siteId),
    retry: false,
  });

  const catalogItem = useMemo(() => (catalog.data ?? []).find((c) => c.id === f.catalogItemId) ?? null, [catalog.data, f.catalogItemId]);
  const category = byId(f.categoryId);
  const isSoc = category?.domain === 'soc';
  const matrixPriority = useMemo(() => {
    if (!f.impactId || !f.urgencyId) return null;
    const cell = (matrix.data ?? []).find((c) => c.impactId === f.impactId && c.urgencyId === f.urgencyId);
    return cell ? byId(cell.priorityId) ?? null : null;
  }, [f.impactId, f.urgencyId, matrix.data, byId]);
  const effectivePriority = matrixPriority ?? byId(f.priorityId) ?? (catalogItem?.defaultPriorityId ? byId(catalogItem.defaultPriorityId) : undefined) ?? options('ticket_priority').find((p) => p.isDefault);

  // When a catalog item is chosen, pre-fill category/service.
  useEffect(() => {
    if (!catalogItem) return;
    patch({ categoryId: catalogItem.ticketCategoryId ?? catalogItem.categoryId ?? f.categoryId, serviceId: catalogItem.serviceId ?? f.serviceId, formData: {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogItem?.id]);
  useEffect(() => {
    if (f.type !== 'request' && f.catalogItemId) patch({ catalogItemId: '', formData: {} });
  }, [f.type, f.catalogItemId]);
  useEffect(() => {
    // The first run keeps a prefilled site; later customer changes reset what depends on the customer.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setCis([]);
    setAssets([]);
    patch({ siteId: '', contractId: '' });
  }, [f.customerId]);

  const subcategories = options('ticket_subcategory', { parentId: f.categoryId || null }).filter((o) => o.parentId === f.categoryId);
  const teamEngineers = (engineers.data ?? []).filter((e) => !f.assignedTeamId || e.teamIds.includes(f.assignedTeamId));
  const services = lookups?.services ?? [];

  const create = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        type: f.type,
        customerId: f.customerId,
        siteId: nn(f.siteId),
        serviceId: nn(f.serviceId),
        contractId: nn(f.contractId),
        title: f.title.trim(),
        description: f.description.trim() || null,
        categoryId: nn(f.categoryId),
        subcategoryId: nn(f.subcategoryId),
        impactId: nn(f.impactId),
        urgencyId: nn(f.urgencyId),
        priorityId: matrixPriority ? null : nn(f.priorityId),
        securitySeverityId: isSoc ? nn(f.securitySeverityId) : null,
        assignedTeamId: nn(f.assignedTeamId),
        assigneeId: nn(f.assigneeId),
        catalogItemId: f.type === 'request' ? nn(f.catalogItemId) : null,
        formData: f.type === 'request' && f.catalogItemId ? f.formData : {},
        tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
        isMajor: f.type === 'incident' ? f.isMajor : false,
        primaryCiId: cis[0]?.id ?? null,
        ciIds: cis.map((c) => c.id),
        primaryAssetId: assets[0]?.id ?? null,
        assetIds: assets.map((a) => a.id),
      };
      if (f.type === 'change') body.change = { changeType: f.changeType, riskId: nn(f.riskId), scheduledStart: nn(f.scheduledStart) ? new Date(f.scheduledStart).toISOString() : null, scheduledEnd: nn(f.scheduledEnd) ? new Date(f.scheduledEnd).toISOString() : null, implementationPlan: f.implementationPlan || null, backoutPlan: f.backoutPlan || null, justification: f.justification || null };
      if (f.type === 'problem') body.problem = { symptoms: f.symptoms || null };
      const t = await ticketsApi.create(body);
      let attached = 0;
      if (files.length) {
        const r = await uploadAttachments(files, { entityType: 'ticket', entityId: t.id, customerId: t.customerId, customerVisible: isCustomer ? true : filesVisible }, (done, total, name) => setUploadNote(name ? `Uploading ${done + 1}/${total}…` : null));
        reportUploadFailures(r);
        attached = r.ok.length;
      }
      return { ticket: t, attached };
    },
    onSuccess: ({ ticket: t, attached }) => {
      toast.success(`${t.number} created${attached ? ` · ${attached} file${attached === 1 ? '' : 's'} attached` : ''}`);
      navigate(isCustomer ? `/portal/tickets/${t.id}` : `/tickets/${t.id}`);
    },
    onError: (e: Error & { details?: { missing?: string[] } }) => toast.error(e.message),
  });

  const valid = !!f.customerId && f.title.trim().length >= 3 && (f.type !== 'request' || !f.catalogItemId || (catalogItem?.formSchema ?? []).every((x) => !x.required || (f.formData[x.key] !== undefined && f.formData[x.key] !== '' && f.formData[x.key] !== null)));
  const scopeStatus = (scope.data?.status ?? 'unknown') as ScopeStatus;

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="New ticket"
        breadcrumb={<span className="hover:underline cursor-pointer" onClick={() => navigate(-1)}>Tickets</span>}
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate(-1)} icon={<X className="h-4 w-4" />}>
              Cancel
            </Button>
            <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!valid} icon={<Save className="h-4 w-4" />}>
              {uploadNote ?? `Create ${TYPES.find((t) => t.key === f.type)?.label.toLowerCase()}`}
            </Button>
          </>
        }
      />

      {/* type selector */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        {TYPES.filter((t) => !isCustomer || t.key === 'incident' || t.key === 'request').map((t) => (
          <button key={t.key} onClick={() => patch({ type: t.key })} className={cn('card text-left px-3 py-2 transition-colors', f.type === t.key ? 'border-brand-500 ring-2 ring-brand-500/20' : 'hover:border-brand-300')}>
            <div className="flex items-center gap-2">
              <TypeBadge type={t.key} short className="px-1 py-0 text-[10px]" />
              <span className="font-medium text-[13px]">{t.label}</span>
            </div>
            <div className="text-[11.5px] text-muted mt-0.5">{t.hint}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4 items-start">
        <div className="flex flex-col gap-4">
          <Card title="Details">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {!isCustomer && (
                <Field label="Customer" required>
                  <Select value={f.customerId} onChange={(e) => patch({ customerId: e.target.value })} placeholder="Select customer…" options={customerItems.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} />
                </Field>
              )}
              <Field label="Site">
                <Select value={f.siteId} onChange={(e) => patch({ siteId: e.target.value })} placeholder={f.customerId ? 'Any site' : 'Select a customer first'} disabled={!f.customerId} options={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))} />
              </Field>
              <Field label="Service">
                <Select value={f.serviceId} onChange={(e) => patch({ serviceId: e.target.value })} placeholder="Select service…" options={services.map((s) => ({ value: s.id, label: s.name }))} />
              </Field>
              {!isCustomer && (
                <Field label="Contract" hint={scope.data?.contract && !f.contractId ? `Auto: ${scope.data.contract.number}${scope.data.contract.slaPolicyName ? ` · ${scope.data.contract.slaPolicyName}` : ''}` : undefined}>
                  <Select value={f.contractId} onChange={(e) => patch({ contractId: e.target.value })} placeholder="Automatic" disabled={!f.customerId} options={(contracts.data ?? []).map((c) => ({ value: c.id, label: `${c.number} · ${c.name}` }))} />
                </Field>
              )}
              {f.type === 'request' && (
                <Field label="Catalog item" className="sm:col-span-2" hint={catalogItem?.description ?? undefined}>
                  <Select value={f.catalogItemId} onChange={(e) => patch({ catalogItemId: e.target.value })} placeholder="Free-form request" options={(catalog.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
                </Field>
              )}
              <Field label="Title" required className="sm:col-span-2">
                <Input autoFocus value={f.title} onChange={(e) => patch({ title: e.target.value })} placeholder="Short, specific summary" maxLength={300} />
              </Field>
              {catalogItem && catalogItem.formSchema?.length > 0 && (
                <div className="sm:col-span-2 rounded-lg border border-default bg-surface-2/40 p-3">
                  <div className="text-[12.5px] font-medium mb-2">{catalogItem.name} form</div>
                  <CatalogForm schema={catalogItem.formSchema} value={f.formData} onChange={(formData) => patch({ formData })} />
                </div>
              )}
              <Field label="Description" className="sm:col-span-2">
                <Textarea
                  value={f.description}
                  onChange={(e) => patch({ description: e.target.value })}
                  placeholder={f.type === 'incident' ? 'What is affected, since when, what has been tried…' : 'Details'}
                  className="min-h-[120px]"
                  onPaste={(e) => {
                    const fs = pastedFiles(e);
                    if (fs.length) {
                      e.preventDefault();
                      setFiles((cur) => addFiles(cur, fs));
                    }
                  }}
                />
              </Field>
              <Field label="Attachments" className="sm:col-span-2" hint={`${UPLOAD_HINT} · a screenshot pasted into the description is attached too`}>
                <FilePicker files={files} onChange={setFiles} disabled={create.isPending} />
                {!isCustomer && files.length > 0 && <Checkbox checked={filesVisible} onChange={(e) => setFilesVisible(e.target.checked)} label="Visible to the customer" className="mt-1" />}
              </Field>
            </div>
          </Card>

          <Card title="Classification" actions={<ClassifyDraftButton title={f.title} description={f.description} customerId={f.customerId || undefined} type={f.type} onApply={(r) => patch({ categoryId: r.categoryId ?? '', subcategoryId: r.subcategoryId ?? '', impactId: r.impactId ?? '', urgencyId: r.urgencyId ?? '', priorityId: !isCustomer && r.priorityId ? r.priorityId : f.priorityId })} />}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Category">
                <Select value={f.categoryId} onChange={(e) => patch({ categoryId: e.target.value, subcategoryId: '' })} placeholder="Select…" options={options('ticket_category').map((o) => ({ value: o.id, label: `${o.label}${o.domain !== 'general' ? ` · ${o.domain.toUpperCase()}` : ''}` }))} />
              </Field>
              <Field label="Subcategory">
                <Select value={f.subcategoryId} onChange={(e) => patch({ subcategoryId: e.target.value })} placeholder={subcategories.length ? 'Select…' : '—'} disabled={!subcategories.length} options={subcategories.map((o) => ({ value: o.id, label: o.label }))} />
              </Field>
              <Field label="Impact">
                <Select value={f.impactId} onChange={(e) => patch({ impactId: e.target.value })} placeholder="Select…" options={options('ticket_impact').map((o) => ({ value: o.id, label: o.label }))} />
              </Field>
              <Field label="Urgency">
                <Select value={f.urgencyId} onChange={(e) => patch({ urgencyId: e.target.value })} placeholder="Select…" options={options('ticket_urgency').map((o) => ({ value: o.id, label: o.label }))} />
              </Field>
              {!isCustomer && (
                <Field label="Priority" hint={matrixPriority ? 'Derived from impact × urgency' : undefined}>
                  <div className="flex items-center gap-2">
                    <Select value={matrixPriority ? matrixPriority.id : f.priorityId} onChange={(e) => patch({ priorityId: e.target.value })} disabled={!!matrixPriority} placeholder="Default" options={options('ticket_priority').map((o) => ({ value: o.id, label: o.label }))} />
                  </div>
                </Field>
              )}
              <Field label="Effective priority">
                <div className="h-[34px] flex items-center">
                  <PriorityBadge priority={effectivePriority ? { id: effectivePriority.id, key: effectivePriority.key, label: effectivePriority.label, color: effectivePriority.color ?? null, level: effectivePriority.level } : null} />
                </div>
              </Field>
              {isSoc && (
                <Field label="Security severity" required>
                  <Select value={f.securitySeverityId} onChange={(e) => patch({ securitySeverityId: e.target.value })} placeholder="Select…" options={options('security_severity').map((o) => ({ value: o.id, label: o.label }))} />
                </Field>
              )}
              {!isCustomer && (
                <Field label="Tags" hint="Comma separated">
                  <Input value={f.tags} onChange={(e) => patch({ tags: e.target.value })} placeholder="outage, vip" />
                </Field>
              )}
              {f.type === 'incident' && !isCustomer && (
                <div className="sm:col-span-2">
                  <Checkbox checked={f.isMajor} onChange={(e) => patch({ isMajor: e.target.checked })} label={<span className="inline-flex items-center gap-1"><Flame className="h-3.5 w-3.5 text-red-500" /> Major incident</span>} />
                </div>
              )}
            </div>
          </Card>

          {f.type === 'change' && (
            <Card title="Change">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Change type">
                  <Select value={f.changeType} onChange={(e) => patch({ changeType: e.target.value })} options={[{ value: 'standard', label: 'Standard (pre-approved)' }, { value: 'normal', label: 'Normal' }, { value: 'emergency', label: 'Emergency' }]} />
                </Field>
                <Field label="Risk">
                  <Select value={f.riskId} onChange={(e) => patch({ riskId: e.target.value })} placeholder="Default" options={options('change_risk').map((o) => ({ value: o.id, label: o.label }))} />
                </Field>
                <Field label="Scheduled start">
                  <Input type="datetime-local" value={f.scheduledStart} onChange={(e) => patch({ scheduledStart: e.target.value })} />
                </Field>
                <Field label="Scheduled end">
                  <Input type="datetime-local" value={f.scheduledEnd} onChange={(e) => patch({ scheduledEnd: e.target.value })} />
                </Field>
                <Field label="Justification" className="sm:col-span-2">
                  <Textarea value={f.justification} onChange={(e) => patch({ justification: e.target.value })} />
                </Field>
                <Field label="Implementation plan">
                  <Textarea value={f.implementationPlan} onChange={(e) => patch({ implementationPlan: e.target.value })} />
                </Field>
                <Field label="Backout plan">
                  <Textarea value={f.backoutPlan} onChange={(e) => patch({ backoutPlan: e.target.value })} />
                </Field>
              </div>
            </Card>
          )}
          {f.type === 'problem' && (
            <Card title="Problem">
              <Field label="Symptoms">
                <Textarea value={f.symptoms} onChange={(e) => patch({ symptoms: e.target.value })} placeholder="Observed symptoms and affected incidents" />
              </Field>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4">
          <Card title="Scope">
            {!f.customerId || (!f.serviceId && !f.siteId) ? (
              <div className="text-[12.5px] text-muted">Select a customer and service (or site) to preview the scope classification.</div>
            ) : scope.isFetching && !scope.data ? (
              <div className="text-[12.5px] text-muted">Evaluating…</div>
            ) : scope.isError ? (
              <div className="text-[12.5px] text-muted">Scope preview unavailable.</div>
            ) : (
              <div className="flex flex-col gap-2">
                <ScopeBadge status={scopeStatus} detail={scope.data?.contract?.number} />
                <div className="text-[12.5px] text-muted">{scope.data?.reason}</div>
                {scope.data?.contract?.slaPolicyName && <div className="text-[12px] text-subtle">SLA policy: {scope.data.contract.slaPolicyName}</div>}
                <div className="text-[11.5px] text-subtle inline-flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> Scope is informational and never blocks work.
                </div>
              </div>
            )}
          </Card>

          {!isCustomer && (
            <Card title="Assignment" actions={<span className="text-[11px] text-subtle">Optional · rules apply otherwise</span>}>
              <div className="flex flex-col gap-3">
                <Field label="Team">
                  <Select value={f.assignedTeamId} onChange={(e) => patch({ assignedTeamId: e.target.value, assigneeId: '' })} placeholder="Automatic" options={(lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))} />
                </Field>
                <Field label="Engineer">
                  <Select value={f.assigneeId} onChange={(e) => patch({ assigneeId: e.target.value })} placeholder="Unassigned" options={teamEngineers.map((u) => ({ value: u.id, label: u.name }))} />
                </Field>
              </div>
            </Card>
          )}

          <Card title="Affected items">
            <div className="flex flex-col gap-3">
              <Field label="Configuration items" hint={cis.length ? 'First item is the primary CI' : undefined}>
                <EntityPicker
                  multiple
                  queryKey={`cis-${f.customerId}`}
                  disabled={!f.customerId}
                  placeholder={f.customerId ? 'Search CIs by name, hostname, IP…' : 'Select a customer first'}
                  value={cis}
                  onChange={setCis}
                  search={async (q) => itemsOf<{ id: string; name: string; hostname?: string | null; ipAddress?: string | null }>(await get<unknown>('/cmdb/cis', { customerId: f.customerId, q, pageSize: 20 })).map((c) => ({ id: c.id, label: c.name, sublabel: [c.hostname, c.ipAddress].filter(Boolean).join(' · ') || null }))}
                />
              </Field>
              <Field label="Assets">
                <EntityPicker
                  multiple
                  queryKey={`assets-${f.customerId}`}
                  disabled={!f.customerId}
                  placeholder={f.customerId ? 'Search assets by tag, name, serial…' : 'Select a customer first'}
                  value={assets}
                  onChange={setAssets}
                  search={async (q) => itemsOf<{ id: string; tag: string; name: string; serialNumber?: string | null }>(await get<unknown>('/assets', { customerId: f.customerId, q, pageSize: 20 })).map((a) => ({ id: a.id, label: `${a.tag} · ${a.name}`, sublabel: a.serialNumber ?? null }))}
                />
              </Field>
            </div>
          </Card>
          {category && <Badge color="slate" className="self-start">Domain: {category.domain}</Badge>}
        </div>
      </div>
    </div>
  );
}
