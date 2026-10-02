import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, ExternalLink, Boxes, Server, Ticket, Users, Mail, Phone, MessageSquare, Info, Building2, Link2, Power } from 'lucide-react';
import { toast } from 'sonner';
import { Button, Badge, Card, Dialog, Drawer, ConfirmDialog, LoadingBlock, ErrorBlock, EmptyState, DataTable, Checkbox, StatTile, Avatar, type Column } from '@/components/ui';
import { get, post, patch, put, del, ApiError } from '@/api/client';
import type { MenuItem } from '@/components/Menu';
import { RecordLayout, RecordHeader, RecordRibbon, RecordForm, RelatedTabs, ActivityStream, useAuditStream, RailTabs, RailCard, RailRows, type FormSection, type FieldDef } from '@/components/record';
import { formatValue } from '@/components/audit/AuditTrail';
import { useListState } from '@/hooks/useListState';
import { useLookups } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { fmtDate, fmtDateTime, relativeTime, titleCase, fmtBytes } from '@/lib/format';
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

const errMsg = (e: unknown) => (e as ApiError)?.message ?? 'Request failed';

/** Free-form JSON (custom fields, commercial terms) as label/value rows. */
const recordFields = (rec?: Record<string, unknown> | null): FieldDef[] => Object.entries(rec ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => ({ label: titleCase(k), value: formatValue(v) }));

export default function CustomerDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const { set: setParams } = useListState();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'deactivate' | 'reactivate' | 'delete' | null>(null);

  const customer = useQuery({ queryKey: ['customers', id], queryFn: () => get<CustomerDetail>(`/customers/${id}`), enabled: !!id });
  // The 360 view feeds the ribbon (SLA breaches) and the Summary tab; one query, shared by key.
  const overview = useQuery({ queryKey: ['customers', id, 'overview'], queryFn: () => get<CustomerOverview>(`/customers/${id}/overview`), enabled: !!id });
  const sites = useQuery({ queryKey: ['customers', id, 'sites', false], queryFn: () => get<Site[]>(`/customers/${id}/sites`), enabled: !!id });
  const contacts = useQuery({ queryKey: ['customers', id, 'contacts', false], queryFn: () => get<Contact[]>(`/customers/${id}/contacts`), enabled: !!id });
  const audit = useAuditStream('customer', id);
  const canManage = can('customers:manage');

  useEffect(() => {
    if (customer.data) setAssistantContext({ label: customer.data.name, entityType: 'customer', entityId: id });
    return () => setAssistantContext(null);
  }, [customer.data, id, setAssistantContext]);

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['customers'] }); qc.invalidateQueries({ queryKey: ['audit', 'entity', 'customer', id] }); };
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
  const goTo = (tab: string) => setParams({ tab }, false);

  // ---- header: one primary action, lifecycle in the overflow menu
  const primary = canManage ? <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(true)}>Edit</Button> : undefined;
  const menu: MenuItem[] = canManage
    ? [
        c.isActive ? { label: 'Deactivate customer…', icon: <Power className="h-4 w-4" />, onClick: () => setConfirm('deactivate') } : { label: 'Reactivate customer…', icon: <Power className="h-4 w-4" />, onClick: () => setConfirm('reactivate') },
        { label: 'Delete customer…', icon: <Trash2 className="h-4 w-4" />, onClick: () => setConfirm('delete'), danger: true, disabled: c.counts.contracts > 0 || c.counts.totalTickets > 0 },
      ]
    : [];
  const controls = (
    <>
      {c.statusLabel && <Badge color={c.statusColor ?? undefined} dot>{c.statusLabel}</Badge>}
      {!c.isActive && <Badge color="gray">Inactive</Badge>}
    </>
  );

  // ---- form
  const address = formatAddress(c.address);
  const manager = c.accountManagerName ? (
    <span className="inline-flex items-center gap-1.5">
      <Avatar name={c.accountManagerName} size="xs" /> {c.accountManagerName}
      {c.accountManagerEmail && <a href={`mailto:${c.accountManagerEmail}`} className="text-subtle hover:text-default" title={c.accountManagerEmail}><Mail className="h-3 w-3" /></a>}
    </span>
  ) : null;
  const sections: FormSection[] = [
    {
      key: 'profile',
      title: 'Profile',
      fields: [
        { label: 'Legal name', value: c.legalName },
        { label: 'Industry', value: c.industryLabel },
        { label: 'Account manager', value: manager, hint: c.accountManagerEmail ?? undefined },
        { label: 'Timezone', value: c.timezone },
        { label: 'Website', value: c.website ? <a href={/^https?:\/\//.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer" className="hover:underline inline-flex items-center gap-1">{c.website} <ExternalLink className="h-3 w-3 text-subtle" /></a> : null },
        { label: 'Phone', value: c.phone ? <a href={`tel:${c.phone}`} className="hover:underline">{c.phone}</a> : null },
        { label: 'Email', value: c.email ? <a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a> : null },
        { label: 'Tags', value: c.tags.length ? <span className="flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t} color="slate">{t}</Badge>)}</span> : null },
        { label: 'Address', value: address || null, span: 2 },
        { label: 'Notes', value: c.notes ?? '', kind: 'prose', span: 2, hidden: !c.notes },
      ],
    },
    { key: 'custom', title: 'Custom fields', collapsible: true, fields: recordFields(c.customFields), hidden: recordFields(c.customFields).length === 0 },
    { key: 'commercial', title: 'Commercial', collapsible: true, fields: recordFields(c.commercial), hidden: !c.canViewCommercial || recordFields(c.commercial).length === 0 },
  ];

  // ---- related lists (keys unchanged so ?tab= deep links keep working)
  const tabs = [
    { key: 'overview', label: 'Summary', content: <SummaryTab id={id} /> },
    { key: 'sites', label: 'Sites', count: c.counts.sites, content: <SitesTab id={id} canManage={canManage} /> },
    { key: 'contacts', label: 'Contacts', count: c.counts.contacts, content: <ContactsTab id={id} canManage={canManage} /> },
    { key: 'contracts', label: 'Contracts', count: c.counts.contracts, content: <ContractsTab id={id} /> },
    { key: 'scope', label: 'Services & Scope', content: <ScopeTab id={id} /> },
    { key: 'tickets', label: 'Tickets', count: c.counts.totalTickets, content: <TicketsTab id={id} /> },
    { key: 'assets', label: 'Assets / CIs', count: c.counts.assets + c.counts.cis, content: <AssetsTab customer={c} /> },
    { key: 'documents', label: 'Documents', content: <DocumentsTab id={id} canManage={canManage} /> },
    { key: 'teams', label: 'Teams', count: c.teams.length, content: <TeamsTab customer={c} canManage={canManage} /> },
    { key: 'users', label: 'Portal users', count: c.counts.users, content: <UsersTab id={id} /> },
  ];

  // ---- rail: who looks after the account, who to call, where everything else lives
  const primarySite = (sites.data ?? []).find((s) => s.isPrimary) ?? (sites.data ?? [])[0];
  const contactList = contacts.data ?? [];
  const primaryContact = contactList.find((x) => x.isPrimary && x.isActive) ?? contactList.find((x) => x.isPrimary);
  const escalation = contactList.filter((x) => x.isEscalation && x.isActive).sort((a, b) => (a.escalationLevel ?? 99) - (b.escalationLevel ?? 99));
  const person = (p: Contact) => (
    <span className="inline-flex items-center gap-1.5 justify-end flex-wrap">
      {p.name}
      {p.email && <a href={`mailto:${p.email}`} className="text-subtle hover:text-default" title={p.email}><Mail className="h-3 w-3" /></a>}
      {(p.mobile || p.phone) && <a href={`tel:${p.mobile ?? p.phone}`} className="text-subtle hover:text-default" title={p.mobile ?? p.phone ?? ''}><Phone className="h-3 w-3" /></a>}
    </span>
  );
  const linkTo = (label: string, to: string) => <Link to={to} className="hover:underline inline-flex items-center gap-1">{label}</Link>;
  const details = (
    <>
      <RailCard title={<><Building2 className="h-3.5 w-3.5 text-subtle" /> Account</>}>
        <RailRows
          rows={[
            { label: 'Account manager', value: manager ?? <span className="text-amber-700">Unassigned</span> },
            { label: 'Teams', value: c.teams.length ? c.teams.map((t) => t.name).join(', ') : <span className="text-subtle">None</span> },
            { label: 'Primary site', value: primarySite ? <span>{primarySite.name}{primarySite.timezone && <span className="text-subtle"> · {primarySite.timezone}</span>}</span> : null, hidden: !sites.data },
          ]}
        />
      </RailCard>
      {contactList.length > 0 && (
        <RailCard title={<><Users className="h-3.5 w-3.5 text-subtle" /> Contacts</>} action={<button type="button" onClick={() => goTo('contacts')} className="text-[12px] text-brand-700 hover:underline">All {contactList.length}</button>}>
          <RailRows
            rows={[
              { label: 'Primary', value: primaryContact ? person(primaryContact) : <span className="text-amber-700">Not set</span> },
              ...escalation.map((x) => ({ label: `Escalation L${x.escalationLevel ?? 1}`, value: person(x) })),
            ]}
          />
        </RailCard>
      )}
      <RailCard title={<><Link2 className="h-3.5 w-3.5 text-subtle" /> Records</>}>
        <RailRows
          rows={[
            { label: linkTo('Tickets', `/tickets?customerId=${id}`), value: <span className="tnum">{c.counts.openTickets} open · {c.counts.totalTickets} total</span> },
            { label: linkTo('Contracts', `/contracts?customerId=${id}`), value: <span className="tnum">{c.counts.activeContracts} active · {c.counts.contracts} total</span> },
            { label: linkTo('Assets', `/assets?customerId=${id}`), value: <span className="tnum">{c.counts.assets}</span> },
            { label: linkTo('CIs', `/cmdb?customerId=${id}`), value: <span className="tnum">{c.counts.cis}</span> },
            { label: can('admin:users') ? linkTo('Portal users', `/admin/users?customerId=${id}`) : 'Portal users', value: <span className="tnum">{c.counts.users}</span> },
          ]}
        />
      </RailCard>
    </>
  );

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={[{ label: 'Customers', to: '/customers' }, { label: c.code }]}
            number={c.code}
            title={c.name}
            badges={c.typeLabel ? <Badge color="slate">{c.typeLabel}</Badge> : undefined}
            controls={controls}
            primary={primary}
            menu={menu}
            createdAt={c.createdAt}
            updatedAt={c.updatedAt}
          >
            <RecordRibbon items={glance(c, overview.data, overview.isLoading)} columns={5} />
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
              { key: 'details', label: 'Details', icon: Info, content: details },
            ]}
          />
        }
      />

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
    </>
  );
}

// ---------------------------------------------------------------- at a glance

/** What an account manager checks first: open work, service levels, coverage, footprint. */
function glance(c: CustomerDetail, o: CustomerOverview | undefined, loading: boolean): { label: string; value: string; tone?: 'good' | 'warn' | 'bad'; hint?: string }[] {
  const sla = o?.sla30d;
  return [
    { label: 'Open tickets', value: String(c.counts.openTickets), tone: c.counts.openTickets > 0 ? 'warn' : undefined, hint: `${c.counts.totalTickets} total` },
    sla
      ? { label: 'SLA breached · 30d', value: String(sla.breached), tone: sla.breached > 0 ? 'bad' : sla.met > 0 ? 'good' : undefined, hint: sla.compliancePct === null ? 'No SLA targets closed in the last 30 days' : `${sla.compliancePct}% compliance · ${sla.met} met` }
      : { label: 'SLA breached · 30d', value: loading ? '…' : '—' },
    { label: 'Active contracts', value: String(c.counts.activeContracts), tone: c.counts.activeContracts === 0 && c.isActive ? 'warn' : undefined, hint: `${c.counts.contracts} total` },
    { label: 'Sites', value: String(c.counts.sites) },
    { label: 'Contacts', value: String(c.counts.contacts) },
  ];
}

// ---------------------------------------------------------------- related lists

function SummaryTab({ id }: { id: string }) {
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
    <Card padded={false} actions={<><Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />{canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>Add site</Button>}</>}>
      <DataTable columns={columns} rows={q.data ?? []} loading={q.isLoading} dense empty={<EmptyState title="No sites" />} />
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
    <Card padded={false} actions={<><Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />{canManage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>Add contact</Button>}</>}>
      <DataTable columns={columns} rows={q.data ?? []} loading={q.isLoading} dense empty={<EmptyState title="No contacts" />} />
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
    <Card padded={false} actions={can('contracts:manage') && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>New contract</Button>}>
      <DataTable columns={columns} rows={q.data?.items ?? []} loading={q.isLoading} dense onRowClick={(r) => navigate(`/contracts/${r.id}`)} empty={<EmptyState title="No contracts" description="Coverage, SLA, entitlements and scope start with a contract." />} />
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
  if (!q.data?.length) return <Card><EmptyState title="No active contract" description="Covered services and scope appear once a contract is active." /></Card>;
  return (
    <div className="flex flex-col gap-3">
      {q.data.map(({ contract, services, sites, groups }) => (
        <Card key={contract.id} title={<Link to={`/contracts/${contract.id}`} className="hover:underline"><span className="font-mono text-[12.5px]">{contract.number}</span> · {contract.name}</Link>} actions={<><ContractStatusBadge status={contract.status} /><span className="text-xs text-muted">{fmtDate(contract.startDate)} – {fmtDate(contract.endDate)}</span></>}>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-1">
              <RailRows
                rows={[
                  { label: 'SLA policy', value: contract.slaPolicyName ?? <span className="text-subtle">Platform default</span> },
                  { label: 'Covered sites', value: sites.length === 0 ? 'All sites' : sites.map((s) => s.name).join(', ') },
                ]}
              />
              <div className="text-[12px] text-muted mt-3 mb-1">Covered services</div>
              {services.length === 0 ? <span className="text-[12.5px] text-subtle">None</span> : (
                <ul className="space-y-1.5">
                  {services.map((s) => (
                    <li key={s.serviceId} className="text-[13px]">
                      <div className="font-medium flex items-center gap-2">{s.serviceName}<Badge color="slate">{s.domain}</Badge></div>
                      <div className="text-xs text-muted">SLA: {s.effectiveSlaPolicyName ?? 'default'}{s.slaPolicyName && ' (override)'} · Team: {s.teamName ?? 'service default'}{s.supportHoursCalendarName && ` · ${s.supportHoursCalendarName}`}</div>
                    </li>
                  ))}
                </ul>
              )}
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
    { key: 'priority', header: 'Priority', render: (t) => (t.priorityLabel ? <Badge color={t.priorityColor ?? undefined}>{t.priorityLabel}</Badge> : '—') },
    { key: 'status', header: 'Status', render: (t) => (t.statusLabel ? <Badge color={t.statusColor ?? undefined} dot>{t.statusLabel}</Badge> : '—') },
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
    </div>
  );
}

interface DocRow { id: string; filename: string; title: string | null; docType: string; contentType: string; size: number; uploadedByName: string | null; createdAt: string }

function DocumentsTab({ id, canManage }: { id: string; canManage: boolean }) {
  return (
    <Card>
      <OptionalAttachmentList entityType="customer" entityId={id} customerId={id} canUpload={canManage} canDelete={canManage} showVisibility fallback={<DocumentsFallback id={id} />} docTypes={[{ value: 'agreement', label: 'Agreement' }, { value: 'po', label: 'Purchase order' }, { value: 'sow', label: 'Statement of work' }, { value: 'report', label: 'Report' }, { value: 'other', label: 'Other' }]} />
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
  return <DataTable columns={columns} rows={q.data?.items ?? []} loading={q.isLoading} dense empty={<EmptyState title="No documents" />} />;
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
    <Card title="MSP teams serving this customer" actions={canManage && <Button size="sm" onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending} title="Members of assigned teams can see this customer without a customer-scoped role">Save</Button>}>
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
  const users = q.data ?? [];
  const summary = users.length > 0 ? `${users.length} users · ${users.filter((u) => u.status === 'active').length} active · ${users.filter((u) => u.roles.some((r) => r.key === 'customer_admin')).length} admins` : null;
  return (
    <Card padded={false} title={summary} actions={can('admin:users') && <Button size="sm" variant="outline" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => navigate(`/admin/users?customerId=${id}`)}>Manage in administration</Button>}>
      <DataTable columns={columns} rows={users} loading={q.isLoading} dense onRowClick={can('admin:users') ? (u) => navigate(`/admin/users/${u.id}`) : undefined} empty={<EmptyState title="No portal users" description="Created in Administration → Users with the customer user type." />} />
    </Card>
  );
}
