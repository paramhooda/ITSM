import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, ExternalLink, MoreHorizontal, Boxes, Server, Ticket, Users } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Button, Badge, Tabs, Card, Dialog, Drawer, ConfirmDialog, LoadingBlock, ErrorBlock, EmptyState, DataTable, Checkbox, KeyValue, StatTile, type Column } from '@/components/ui';
import { get, post, patch, put, del, ApiError } from '@/api/client';
import { useLookups } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { fmtDate, fmtDateTime, relativeTime, titleCase, fmtBytes } from '@/lib/format';
import { Menu } from '@/components/Menu';
import { CustomerForm, type CustomerPayload } from '@/components/customers/CustomerForm';
import { SiteForm, type SitePayload } from '@/components/customers/SiteForm';
import { ContactForm, type ContactPayload } from '@/components/customers/ContactForm';
import { OverviewPanel } from '@/components/customers/OverviewPanel';
import { OptionalAttachmentList } from '@/components/customers/OptionalModules';
import { ContractForm, type ContractPayload } from '@/components/contracts/ContractForm';
import { ContractStatusBadge, ExpiryCountdown } from '@/components/contracts/ContractBits';
import { ScopeTable } from '@/components/contracts/ScopeTable';
import { formatAddress, type CustomerDetail, type CustomerOverview, type Site, type Contact, type PortalUser } from '@/components/customers/types';
import type { ContractListItem, ContractDetail, ContractService, ScopeGroup, Paginated } from '@/components/contracts/types';

type TabKey = 'overview' | 'sites' | 'contacts' | 'contracts' | 'scope' | 'tickets' | 'assets' | 'documents' | 'teams' | 'users';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'sites', label: 'Sites' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'contracts', label: 'Contracts' },
  { key: 'scope', label: 'Services & Scope' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'assets', label: 'Assets / CIs' },
  { key: 'documents', label: 'Documents' },
  { key: 'teams', label: 'Teams' },
  { key: 'users', label: 'Portal users' },
];

const errMsg = (e: unknown) => (e as ApiError)?.message ?? 'Request failed';

export default function CustomerDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabKey) || 'overview';
  const setTab = (t: TabKey) => setParams((p) => { p.set('tab', t); return p; }, { replace: true });
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'deactivate' | 'reactivate' | 'delete' | null>(null);

  const customer = useQuery({ queryKey: ['customers', id], queryFn: () => get<CustomerDetail>(`/customers/${id}`), enabled: !!id });
  const canManage = can('customers:manage');

  useEffect(() => {
    if (customer.data) setAssistantContext({ label: customer.data.name, entityType: 'customer', entityId: id });
    return () => setAssistantContext(null);
  }, [customer.data, id, setAssistantContext]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['customers'] });
  const update = useMutation({
    mutationFn: (body: CustomerPayload) => patch<CustomerDetail>(`/customers/${id}`, body),
    onSuccess: () => { invalidate(); setEditing(false); toast.success('Customer updated'); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const lifecycle = useMutation({
    mutationFn: async (action: 'deactivate' | 'reactivate' | 'delete') => (action === 'delete' ? del(`/customers/${id}`) : post(`/customers/${id}/${action}`, {})),
    onSuccess: (_d, action) => {
      setConfirm(null);
      if (action === 'delete') { toast.success('Customer deleted'); qc.invalidateQueries({ queryKey: ['customers'] }); navigate('/customers'); return; }
      invalidate();
      toast.success(action === 'deactivate' ? 'Customer deactivated' : 'Customer reactivated');
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (customer.isLoading) return <LoadingBlock />;
  if (customer.isError || !customer.data) return <ErrorBlock error={customer.error} retry={() => customer.refetch()} />;
  const c = customer.data;

  return (
    <div>
      <PageHeader
        breadcrumb={<Link to="/customers" className="hover:underline">Customers</Link>}
        title={
          <span className="flex items-center gap-2 flex-wrap">
            {c.name}
            <span className="font-mono text-[12px] text-subtle font-normal">{c.code}</span>
            {c.statusLabel && <Badge color={c.statusColor} dot>{c.statusLabel}</Badge>}
            {!c.isActive && <Badge color="gray">Inactive</Badge>}
          </span>
        }
        subtitle={
          <span className="flex items-center gap-2 flex-wrap">
            {c.industryLabel && <span>{c.industryLabel}</span>}
            {c.typeLabel && <span>· {c.typeLabel}</span>}
            <span>· Account manager: {c.accountManagerName ?? <span className="text-subtle">unassigned</span>}</span>
            {c.tags.map((t) => (
              <Badge key={t} color="slate">{t}</Badge>
            ))}
          </span>
        }
        actions={
          canManage && (
            <>
              <Button variant="outline" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Menu
                trigger={<Button variant="ghost" size="icon" aria-label="More"><MoreHorizontal className="h-4 w-4" /></Button>}
                items={[
                  c.isActive ? { label: 'Deactivate customer', onClick: () => setConfirm('deactivate') } : { label: 'Reactivate customer', onClick: () => setConfirm('reactivate') },
                  { label: 'Delete customer', onClick: () => setConfirm('delete'), danger: true, disabled: c.counts.contracts > 0 || c.counts.totalTickets > 0 },
                ]}
              />
            </>
          )
        }
      />
      <Tabs tabs={TABS.map((t) => ({ ...t, count: t.key === 'sites' ? c.counts.sites : t.key === 'contacts' ? c.counts.contacts : t.key === 'contracts' ? c.counts.contracts : t.key === 'users' ? c.counts.users : undefined }))} value={tab} onChange={setTab} className="mb-4" />

      {tab === 'overview' && <OverviewTab id={id} />}
      {tab === 'sites' && <SitesTab id={id} canManage={canManage} />}
      {tab === 'contacts' && <ContactsTab id={id} canManage={canManage} />}
      {tab === 'contracts' && <ContractsTab id={id} />}
      {tab === 'scope' && <ScopeTab id={id} />}
      {tab === 'tickets' && <TicketsTab id={id} />}
      {tab === 'assets' && <AssetsTab customer={c} />}
      {tab === 'documents' && <DocumentsTab id={id} canManage={canManage} />}
      {tab === 'teams' && <TeamsTab customer={c} canManage={canManage} />}
      {tab === 'users' && <UsersTab id={id} />}

      <Drawer open={editing} onClose={() => setEditing(false)} title={`Edit ${c.name}`} width="max-w-2xl">
        <CustomerForm mode="edit" initial={c} onSubmit={(b) => update.mutate(b)} onCancel={() => setEditing(false)} submitting={update.isPending} />
      </Drawer>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && lifecycle.mutate(confirm)}
        loading={lifecycle.isPending}
        danger={confirm !== 'reactivate'}
        title={confirm === 'delete' ? 'Delete customer?' : confirm === 'deactivate' ? 'Deactivate customer?' : 'Reactivate customer?'}
        confirmLabel={confirm === 'delete' ? 'Delete' : confirm === 'deactivate' ? 'Deactivate' : 'Reactivate'}
        description={confirm === 'delete' ? 'This permanently removes the customer, its sites and contacts. Only possible when there are no tickets or contracts.' : confirm === 'deactivate' ? 'The customer is hidden from active lists; data is retained and it can be reactivated later.' : 'The customer becomes active again.'}
      />
    </div>
  );
}

// ---------------------------------------------------------------- tabs

function OverviewTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['customers', id, 'overview'], queryFn: () => get<CustomerOverview>(`/customers/${id}/overview`) });
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError || !q.data) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  return <OverviewPanel overview={q.data} customerId={id} />;
}

function SitesTab({ id, canManage }: { id: string; canManage: boolean }) {
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Site | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Site | null>(null);
  const q = useQuery({ queryKey: ['customers', id, 'sites', showInactive], queryFn: () => get<Site[]>(`/customers/${id}/sites`, { includeInactive: showInactive }) });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['customers', id] }); };
  const save = useMutation({
    mutationFn: (body: SitePayload) => (editing && editing !== 'new' ? patch<Site>(`/sites/${editing.id}`, body) : post<Site>(`/customers/${id}/sites`, body)),
    onSuccess: () => { invalidate(); setEditing(null); toast.success('Site saved'); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (s: Site) => del<{ deleted?: boolean; deactivated?: boolean }>(`/sites/${s.id}`),
    onSuccess: (r) => { invalidate(); setDeleting(null); toast.success(r.deactivated ? 'Site is referenced by tickets, assets or contracts and was deactivated instead' : 'Site deleted'); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const columns: Column<Site>[] = [
    { key: 'code', header: 'Code', width: '110px', render: (s) => <span className="font-mono text-[12.5px]">{s.code}</span> },
    { key: 'name', header: 'Site', render: (s) => <span className="font-medium flex items-center gap-2">{s.name}{s.isPrimary && <Badge color="blue">Primary</Badge>}{!s.isActive && <Badge color="gray">Inactive</Badge>}</span> },
    { key: 'typeLabel', header: 'Type', render: (s) => <span className="text-muted">{s.typeLabel ?? '—'}</span> },
    { key: 'address', header: 'Address', render: (s) => <span className="text-muted">{formatAddress(s.address) || '—'}</span> },
    { key: 'timezone', header: 'Timezone', render: (s) => <span className="text-muted">{s.timezone ?? '—'}</span> },
    { key: 'counts', header: 'Assets / CIs / Open', className: 'tabular-nums', render: (s) => <span className="text-muted">{s.counts.assets} / {s.counts.cis} / {s.counts.openTickets}</span> },
    ...(canManage ? [{ key: 'actions', header: '', width: '80px', render: (s: Site) => (
      <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="icon" onClick={() => setEditing(s)} title="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="icon" onClick={() => setDeleting(s)} title="Delete"><Trash2 className="h-3.5 w-3.5 text-red-500" /></Button>
      </div>
    ) }] : []),
  ];
  return (
    <Card padded={false} title="Sites" actions={<><Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />{canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>Add site</Button>}</>}>
      <DataTable columns={columns} rows={q.data ?? []} loading={q.isLoading} dense empty={<EmptyState title="No sites" description="Add the locations you support for this customer." />} />
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add site' : 'Edit site'} width="max-w-2xl">
        {editing && <SiteForm initial={editing === 'new' ? undefined : editing} onSubmit={(b) => save.mutate(b)} onCancel={() => setEditing(null)} submitting={save.isPending} />}
      </Dialog>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)} loading={remove.isPending} danger title="Delete site?" confirmLabel="Delete" description={`${deleting?.name}: sites referenced by tickets, assets, CIs or contracts are deactivated instead of removed.`} />
    </Card>
  );
}

function ContactsTab({ id, canManage }: { id: string; canManage: boolean }) {
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Contact | null>(null);
  const q = useQuery({ queryKey: ['customers', id, 'contacts', showInactive], queryFn: () => get<Contact[]>(`/customers/${id}/contacts`, { includeInactive: showInactive }) });
  const sites = useQuery({ queryKey: ['customers', id, 'sites', false], queryFn: () => get<Site[]>(`/customers/${id}/sites`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['customers', id] });
  const save = useMutation({
    mutationFn: (body: ContactPayload) => (editing && editing !== 'new' ? patch<Contact>(`/contacts/${editing.id}`, body) : post<Contact>(`/customers/${id}/contacts`, body)),
    onSuccess: () => { invalidate(); setEditing(null); toast.success('Contact saved'); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (c: Contact) => del<{ deleted?: boolean; deactivated?: boolean }>(`/contacts/${c.id}`),
    onSuccess: (r) => { invalidate(); setDeleting(null); toast.success(r.deactivated ? 'Contact is referenced by tickets or assets and was deactivated instead' : 'Contact deleted'); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const columns: Column<Contact>[] = [
    { key: 'name', header: 'Name', render: (c) => (
      <div>
        <div className="font-medium flex items-center gap-2">{c.name}{c.isPrimary && <Badge color="blue">Primary</Badge>}{c.isEscalation && <Badge color="amber">Escalation L{c.escalationLevel ?? 1}</Badge>}{!c.isActive && <Badge color="gray">Inactive</Badge>}</div>
        {(c.title || c.department) && <div className="text-xs text-muted">{[c.title, c.department].filter(Boolean).join(' · ')}</div>}
      </div>
    ) },
    { key: 'email', header: 'Email', render: (c) => (c.email ? <a href={`mailto:${c.email}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{c.email}</a> : '—') },
    { key: 'phone', header: 'Phone', render: (c) => <span className="text-muted">{[c.mobile, c.phone].filter(Boolean).join(' / ') || '—'}</span> },
    { key: 'siteName', header: 'Site', render: (c) => <span className="text-muted">{c.siteName ?? 'Any'}</span> },
    { key: 'portal', header: 'Portal', render: (c) => (c.portalUser ? <Badge color={c.portalUser.status === 'active' ? 'green' : 'gray'}>{titleCase(c.portalUser.status)}</Badge> : <span className="text-subtle">—</span>) },
    ...(canManage ? [{ key: 'actions', header: '', width: '80px', render: (c: Contact) => (
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="icon" onClick={() => setEditing(c)} title="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="icon" onClick={() => setDeleting(c)} title="Delete"><Trash2 className="h-3.5 w-3.5 text-red-500" /></Button>
      </div>
    ) }] : []),
  ];
  return (
    <Card padded={false} title="Contacts" actions={<><Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />{canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>Add contact</Button>}</>}>
      <DataTable columns={columns} rows={q.data ?? []} loading={q.isLoading} dense empty={<EmptyState title="No contacts" description="Add customer contacts, including escalation contacts by level." />} />
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add contact' : 'Edit contact'} width="max-w-2xl">
        {editing && <ContactForm initial={editing === 'new' ? undefined : editing} sites={sites.data ?? []} onSubmit={(b) => save.mutate(b)} onCancel={() => setEditing(null)} submitting={save.isPending} />}
      </Dialog>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)} loading={remove.isPending} danger title="Delete contact?" confirmLabel="Delete" description={`${deleting?.name}: contacts referenced by tickets or assets are deactivated instead of removed.`} />
    </Card>
  );
}

function ContractsTab({ id }: { id: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['contracts', 'customer', id], queryFn: () => get<Paginated<ContractListItem>>(`/customers/${id}/contracts`) });
  const create = useMutation({
    mutationFn: (body: ContractPayload) => post<ContractDetail>('/contracts', body),
    onSuccess: (c) => { qc.invalidateQueries({ queryKey: ['contracts'] }); qc.invalidateQueries({ queryKey: ['customers', id] }); toast.success(`Contract ${c.number} created`); navigate(`/contracts/${c.id}`); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const columns: Column<ContractListItem>[] = [
    { key: 'number', header: 'Number', width: '140px', render: (r) => <span className="font-mono text-[12.5px]">{r.number}</span> },
    { key: 'name', header: 'Contract', render: (r) => <div><div className="font-medium">{r.name}</div>{r.typeLabel && <div className="text-xs text-muted">{r.typeLabel}</div>}</div> },
    { key: 'status', header: 'Status', render: (r) => <ContractStatusBadge status={r.status} label={r.statusLabel} color={r.statusColor} /> },
    { key: 'startDate', header: 'Start', render: (r) => <span className="text-muted">{fmtDate(r.startDate)}</span> },
    { key: 'endDate', header: 'End', render: (r) => <ExpiryCountdown days={r.daysToExpiry} endDate={r.endDate} status={r.status} /> },
    { key: 'services', header: 'Services', render: (r) => <span className="text-muted truncate block max-w-xs" title={r.serviceNames.join(', ')}>{r.serviceNames.join(', ') || '—'}</span> },
    { key: 'entitlements', header: 'Entitlements', render: (r) => (r.entitlements.count === 0 ? <span className="text-subtle">—</span> : <span className="flex items-center gap-1.5">{r.entitlements.count}{r.entitlements.anyExhausted ? <Badge color="red">Exhausted</Badge> : r.entitlements.anyOverThreshold ? <Badge color="amber">Over threshold</Badge> : null}</span>) },
  ];
  return (
    <Card padded={false} title="Contracts" actions={can('contracts:manage') && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>New contract</Button>}>
      <DataTable columns={columns} rows={q.data?.items ?? []} loading={q.isLoading} dense onRowClick={(r) => navigate(`/contracts/${r.id}`)} empty={<EmptyState title="No contracts" description="Contracts define covered services and sites, SLA policy, entitlements and scope." />} />
      <Drawer open={creating} onClose={() => setCreating(false)} title="New contract" width="max-w-3xl">
        {creating && <ContractForm mode="create" customerId={id} onSubmit={(b) => create.mutate(b)} onCancel={() => setCreating(false)} submitting={create.isPending} />}
      </Drawer>
    </Card>
  );
}

interface CustomerScopeEntry {
  contract: { id: string; number: string; name: string; status: string; startDate: string; endDate: string; slaPolicyId: string | null; slaPolicyName: string | null };
  services: Pick<ContractService, 'serviceId' | 'serviceName' | 'domain' | 'slaPolicyName' | 'effectiveSlaPolicyName' | 'teamName' | 'supportHoursCalendarName'>[];
  sites: { id: string; name: string; code: string }[];
  groups: ScopeGroup[];
}

function ScopeTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['customers', id, 'scope'], queryFn: () => get<CustomerScopeEntry[]>(`/customers/${id}/scope`) });
  if (q.isLoading) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  if (!q.data?.length) return <Card><EmptyState title="No active contract" description="Covered services and scope definitions appear once a contract is active." /></Card>;
  return (
    <div className="space-y-4">
      {q.data.map(({ contract, services, sites, groups }) => (
        <Card key={contract.id} title={<span className="flex items-center gap-2"><Link to={`/contracts/${contract.id}`} className="hover:underline">{contract.number} · {contract.name}</Link><ContractStatusBadge status={contract.status} /></span>} actions={<span className="text-xs text-muted">{fmtDate(contract.startDate)} – {fmtDate(contract.endDate)} · SLA: {contract.slaPolicyName ?? 'default'}</span>}>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-1">
              <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium mb-1.5">Covered services</div>
              {services.length === 0 ? <div className="text-[13px] text-muted">No services selected.</div> : (
                <ul className="space-y-1.5">
                  {services.map((s) => (
                    <li key={s.serviceId} className="text-[13px]">
                      <div className="font-medium flex items-center gap-2">{s.serviceName}<Badge color="slate">{s.domain}</Badge></div>
                      <div className="text-xs text-muted">SLA: {s.effectiveSlaPolicyName ?? 'default'}{s.slaPolicyName && ' (override)'} · Team: {s.teamName ?? 'service default'}{s.supportHoursCalendarName && ` · ${s.supportHoursCalendarName}`}</div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium mt-3 mb-1.5">Covered sites</div>
              <div className="text-[13px] text-muted">{sites.length === 0 ? 'All sites' : sites.map((s) => s.name).join(', ')}</div>
            </div>
            <div className="lg:col-span-2">
              <ScopeTable groups={groups} filterable={false} />
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

interface TicketRow {
  id: string;
  number: string;
  type: string;
  title: string;
  statusLabel?: string | null;
  statusColor?: string | null;
  priorityLabel?: string | null;
  priorityColor?: string | null;
  assigneeName?: string | null;
  serviceName?: string | null;
  createdAt: string;
  lastActivityAt?: string | null;
}

function TicketsTab({ id }: { id: string }) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['customers', id, 'tickets'],
    queryFn: async () => {
      try {
        return await get<{ items: TicketRow[]; total: number }>('/tickets', { customerId: id, pageSize: 20, sort: 'lastActivityAt', order: 'desc' });
      } catch (e) {
        if ((e as ApiError).status === 404) return get<{ items: TicketRow[]; total: number }>(`/customers/${id}/tickets`, { limit: 20 });
        throw e;
      }
    },
  });
  const columns: Column<TicketRow>[] = [
    { key: 'number', header: 'Ticket', width: '130px', render: (t) => <span className="font-mono text-[12.5px]">{t.number}</span> },
    { key: 'title', header: 'Title', render: (t) => <span className="font-medium">{t.title}</span> },
    { key: 'type', header: 'Type', render: (t) => <span className="text-muted">{titleCase(t.type)}</span> },
    { key: 'priority', header: 'Priority', render: (t) => (t.priorityLabel ? <Badge color={t.priorityColor}>{t.priorityLabel}</Badge> : '—') },
    { key: 'status', header: 'Status', render: (t) => (t.statusLabel ? <Badge color={t.statusColor}>{t.statusLabel}</Badge> : '—') },
    { key: 'assigneeName', header: 'Assignee', render: (t) => <span className="text-muted">{t.assigneeName ?? 'Unassigned'}</span> },
    { key: 'createdAt', header: 'Created', render: (t) => <span className="text-muted" title={fmtDateTime(t.createdAt)}>{relativeTime(t.createdAt)}</span> },
  ];
  return (
    <Card padded={false} title="Latest tickets" actions={<Button size="sm" variant="outline" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => navigate(`/tickets?customerId=${id}`)}>All tickets</Button>}>
      {q.isError ? <ErrorBlock error={q.error} retry={() => q.refetch()} /> : <DataTable columns={columns} rows={q.data?.items ?? []} loading={q.isLoading} dense onRowClick={(t) => navigate(`/tickets/${t.id}`)} empty={<EmptyState icon={<Ticket className="h-5 w-5" />} title="No tickets" />} />}
    </Card>
  );
}

function AssetsTab({ customer }: { customer: CustomerDetail }) {
  const navigate = useNavigate();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
      <StatTile label="Assets" value={customer.counts.assets} hint="Financial / lifecycle register" icon={<Boxes className="h-4 w-4" />} onClick={() => navigate(`/assets?customerId=${customer.id}`)} />
      <StatTile label="Configuration items" value={customer.counts.cis} hint="Operational CMDB view" icon={<Server className="h-4 w-4" />} onClick={() => navigate(`/cmdb?customerId=${customer.id}`)} />
      <div className="sm:col-span-2 flex gap-2">
        <Button variant="outline" onClick={() => navigate(`/assets?customerId=${customer.id}`)} icon={<ExternalLink className="h-4 w-4" />}>Open assets</Button>
        <Button variant="outline" onClick={() => navigate(`/cmdb?customerId=${customer.id}`)} icon={<ExternalLink className="h-4 w-4" />}>Open CMDB</Button>
      </div>
    </div>
  );
}

interface DocRow { id: string; filename: string; title: string | null; docType: string; contentType: string; size: number; uploadedByName: string | null; createdAt: string }

function DocumentsTab({ id, canManage }: { id: string; canManage: boolean }) {
  const fallback = <DocumentsFallback id={id} />;
  return (
    <Card title="Documents">
      <OptionalAttachmentList entityType="customer" entityId={id} customerId={id} canUpload={canManage} canDelete={canManage} showVisibility fallback={fallback} docTypes={[{ value: 'agreement', label: 'Agreement' }, { value: 'po', label: 'Purchase order' }, { value: 'sow', label: 'Statement of work' }, { value: 'report', label: 'Report' }, { value: 'other', label: 'Other' }]} />
    </Card>
  );
}

function DocumentsFallback({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['customers', id, 'documents'], queryFn: () => get<{ items: DocRow[] }>(`/customers/${id}/documents`) });
  const columns: Column<DocRow>[] = [
    { key: 'filename', header: 'File', render: (d) => <span className="font-medium">{d.title ?? d.filename}</span> },
    { key: 'docType', header: 'Type', render: (d) => <Badge color="slate">{titleCase(d.docType)}</Badge> },
    { key: 'size', header: 'Size', render: (d) => <span className="text-muted">{fmtBytes(d.size)}</span> },
    { key: 'uploadedByName', header: 'Uploaded by', render: (d) => <span className="text-muted">{d.uploadedByName ?? '—'}</span> },
    { key: 'createdAt', header: 'Date', render: (d) => <span className="text-muted">{fmtDateTime(d.createdAt)}</span> },
  ];
  return <DataTable columns={columns} rows={q.data?.items ?? []} loading={q.isLoading} dense empty={<EmptyState title="No documents" description="Upload agreements, purchase orders and reports through the attachments module." />} />;
}

function TeamsTab({ customer, canManage }: { customer: CustomerDetail; canManage: boolean }) {
  const qc = useQueryClient();
  const { lookups } = useLookups();
  const [selected, setSelected] = useState<string[]>(customer.teams.map((t) => t.id));
  useEffect(() => setSelected(customer.teams.map((t) => t.id)), [customer.teams]);
  const save = useMutation({
    mutationFn: () => put(`/customers/${customer.id}/teams`, { teamIds: selected }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['customers', customer.id] }); toast.success('Teams updated'); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const teams = lookups?.teams ?? [];
  const dirty = useMemo(() => JSON.stringify([...selected].sort()) !== JSON.stringify(customer.teams.map((t) => t.id).sort()), [selected, customer.teams]);
  return (
    <Card title="MSP teams serving this customer" actions={canManage && <Button size="sm" onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>Save</Button>}>
      <div className="text-[13px] text-muted mb-3">Members of assigned teams can see this customer even without a customer-scoped role.</div>
      {teams.length === 0 ? <EmptyState icon={<Users className="h-5 w-5" />} title="No teams defined" /> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {teams.map((t) => (
            <label key={t.id} className="flex items-center gap-2 border border-default rounded-lg px-3 py-2 text-[13px] cursor-pointer hover:bg-surface-2">
              <input type="checkbox" className="h-4 w-4 accent-brand-600" disabled={!canManage} checked={selected.includes(t.id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))} />
              <span className="flex-1 truncate">{t.name}</span>
              <Badge color="slate">{titleCase(t.teamType)}</Badge>
            </label>
          ))}
        </div>
      )}
    </Card>
  );
}

function UsersTab({ id }: { id: string }) {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const q = useQuery({ queryKey: ['customers', id, 'users'], queryFn: () => get<PortalUser[]>(`/customers/${id}/users`) });
  const columns: Column<PortalUser>[] = [
    { key: 'name', header: 'Name', render: (u) => <div><div className="font-medium">{u.name}</div>{u.title && <div className="text-xs text-muted">{u.title}</div>}</div> },
    { key: 'email', header: 'Email' },
    { key: 'roles', header: 'Roles', render: (u) => <span className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r.key} color="slate">{r.name}</Badge>)}</span> },
    { key: 'status', header: 'Status', render: (u) => <Badge color={u.status === 'active' ? 'green' : u.status === 'invited' ? 'blue' : 'gray'}>{titleCase(u.status)}</Badge> },
    { key: 'lastLoginAt', header: 'Last login', render: (u) => <span className="text-muted">{u.lastLoginAt ? relativeTime(u.lastLoginAt) : 'never'}</span> },
  ];
  return (
    <Card padded={false} title="Portal users" actions={can('admin:users') && <Button size="sm" variant="outline" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => navigate(`/admin/users?customerId=${id}`)}>Manage in administration</Button>}>
      <DataTable columns={columns} rows={q.data ?? []} loading={q.isLoading} dense onRowClick={can('admin:users') ? (u) => navigate(`/admin/users/${u.id}`) : undefined} empty={<EmptyState title="No portal users" description="Portal users are created in Administration → Users with the customer user type." />} />
      {q.data && q.data.length > 0 && <div className="px-4 py-2 text-xs text-subtle"><KeyValue columns={3} items={[{ label: 'Users', value: q.data.length }, { label: 'Active', value: q.data.filter((u) => u.status === 'active').length }, { label: 'Admins', value: q.data.filter((u) => u.roles.some((r) => r.key === 'customer_admin')).length }]} /></div>}
    </Card>
  );
}
