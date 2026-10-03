import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Pin, Megaphone, Globe, Copy, Ban, Link2, Info, Wrench, Siren, Users } from 'lucide-react';
import { PageHeader, DataTable, Pagination, EmptyState, ErrorBlock, Badge, Button, Select, Input, Dialog, ListShell, FilterGroup, FilterOptions, FilterSelect, type AppliedFilter, type Column } from '@/components/ui';
import { Segmented } from '@/components/dashboards/Panel';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { OPERATIONS_MODULES } from '@/layouts/modules';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { ANNOUNCEMENT_TYPE_COLORS } from '@/lib/statusColors';
import { announcementsApi, announcementKeys, type AnnouncementRow, type StatusToken } from '@/components/announcements/api';
import { AnnouncementDialog, TYPE_OPTIONS, AUDIENCE_OPTIONS, type AnnouncementSeed } from '@/components/announcements/AnnouncementDialog';

const STATE_OPTIONS = [
  { value: 'live', label: 'Live now' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'ended', label: 'Ended' },
  { value: 'all', label: 'Everything' },
];
const STATE_COLOR: Record<string, string> = { live: 'green', scheduled: 'blue', ended: 'slate' };
const TYPE_ICON = { info: Info, maintenance: Wrench, outage: Siren };
const FILTER_KEYS = ['state', 'type', 'audience', 'customerId', 'q'];

/**
 * Announcements: banners for customers and staff (news, planned maintenance, outages), and
 * the public status page links per customer.
 */
export default function AnnouncementsPage() {
  const { state, set, page, pageSize } = useListState({ state: 'live', pageSize: '25' });
  const tab = state.tab === 'status' ? 'status' : 'announcements';
  const customers = useCustomersLookup();
  const customerItems = customers.data?.items ?? [];
  const qc = useQueryClient();
  const params = useMemo(() => ({ state: state.state || 'live', type: state.type || undefined, audience: state.audience || undefined, customerId: state.customerId || undefined, q: state.q || undefined, page, pageSize }), [state.state, state.type, state.audience, state.customerId, state.q, page, pageSize]);
  const q = useQuery({ queryKey: announcementKeys.list(params), queryFn: () => announcementsApi.list(params), placeholderData: (p) => p, enabled: tab === 'announcements' });
  const [editor, setEditor] = useState<{ open: boolean; seed: AnnouncementSeed | null }>({ open: false, seed: null });
  const invalidate = () => qc.invalidateQueries({ queryKey: announcementKeys.all });
  const remove = useMutation({ mutationFn: (id: string) => announcementsApi.remove(id), onSuccess: () => { toast.success('Announcement deleted'); void invalidate(); }, onError: (e: Error) => toast.error(e.message) });
  const end = useMutation({ mutationFn: (id: string) => announcementsApi.update(id, { isActive: false }), onSuccess: () => { toast.success('Announcement taken down'); void invalidate(); }, onError: (e: Error) => toast.error(e.message) });
  const data = q.data;

  const applied: AppliedFilter[] = [];
  const addApplied = (key: string, label: ReactNode) => applied.push({ key, label, onRemove: () => set({ [key]: undefined }) });
  if (state.state && state.state !== 'live') addApplied('state', `State: ${STATE_OPTIONS.find((s) => s.value === state.state)?.label ?? state.state}`);
  if (state.type) addApplied('type', `Type: ${TYPE_OPTIONS.find((t) => t.value === state.type)?.label ?? state.type}`);
  if (state.audience) addApplied('audience', `Audience: ${AUDIENCE_OPTIONS.find((a) => a.value === state.audience)?.label ?? state.audience}`);
  if (state.customerId) addApplied('customerId', `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`);

  const columns: Column<AnnouncementRow>[] = [
    {
      key: 'title',
      header: 'Announcement',
      width: '100%',
      render: (r) => {
        const Icon = TYPE_ICON[r.type] ?? Info;
        return (
          <div className="min-w-0 flex gap-2.5" style={{ width: 0, minWidth: '100%' }}>
            <span className="mt-0.5 shrink-0 text-subtle"><Icon className="h-4 w-4" /></span>
            <div className="min-w-0">
              <div className="font-medium truncate flex items-center gap-1.5">{r.pinned && <Pin className="h-3 w-3 text-subtle shrink-0" />}<span className="truncate" title={r.title}>{r.title}</span></div>
              <div className="text-[11.5px] text-muted truncate" title={r.body}>{r.body}</div>
              {r.sourceTicket && <Link to={`/tickets/${r.sourceTicket.id}`} onClick={(e) => e.stopPropagation()} className="text-[11.5px] font-mono text-brand-700 hover:underline">{r.sourceTicket.number}</Link>}
            </div>
          </div>
        );
      },
    },
    { key: 'type', header: 'Type', width: '150px', render: (r) => <Badge color={ANNOUNCEMENT_TYPE_COLORS[r.type]}>{TYPE_OPTIONS.find((t) => t.value === r.type)?.label ?? r.type}</Badge> },
    {
      key: 'audience',
      header: 'Audience',
      width: '200px',
      render: (r) => (
        <div className="text-[12.5px] min-w-0">
          <div className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5 text-subtle" /> {AUDIENCE_OPTIONS.find((a) => a.value === r.audience)?.label.replace(' (customers and staff)', '') ?? r.audience}</div>
          {r.customers.length > 0 && <div className="text-[11.5px] text-muted truncate" title={r.customers.map((c) => c.name).join(', ')}>{r.customers.length === 1 ? r.customers[0]!.name : `${r.customers.length} customers`}</div>}
        </div>
      ),
    },
    {
      key: 'window',
      header: 'Window',
      width: '190px',
      render: (r) => (
        <div className="text-[12.5px] min-w-0">
          <div className="inline-flex items-center gap-1.5"><Badge color={STATE_COLOR[r.state] ?? 'slate'} dot>{r.state === 'live' ? 'Live' : r.state === 'scheduled' ? 'Scheduled' : 'Ended'}</Badge></div>
          <div className="text-[11.5px] text-muted truncate" title={`${fmtDateTime(r.startsAt)}${r.endsAt ? ` → ${fmtDateTime(r.endsAt)}` : ''}`}>
            {r.state === 'scheduled' ? `from ${fmtDateTime(r.startsAt)}` : `${relativeTime(r.startsAt)}${r.endsAt ? ` · until ${fmtDateTime(r.endsAt)}` : ' · open-ended'}`}
          </div>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '110px',
      render: (r) => (
        <div className="flex items-center gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="ghost" className="px-2" icon={<Pencil className="h-3.5 w-3.5" />} aria-label="Edit" title="Edit" onClick={() => setEditor({ open: true, seed: { ...r, sourceTicketId: r.sourceTicket?.id ?? null, sourceTicket: r.sourceTicket } })} />
          {r.state !== 'ended' && <Button size="sm" variant="ghost" className="px-2" icon={<Ban className="h-3.5 w-3.5" />} aria-label="Take down" title="Take down now" onClick={() => end.mutate(r.id)} />}
          <Button size="sm" variant="ghost" className="px-2 text-red-600" icon={<Trash2 className="h-3.5 w-3.5" />} aria-label="Delete" title="Delete" onClick={() => { if (window.confirm(`Delete "${r.title}"?`)) remove.mutate(r.id); }} />
        </div>
      ),
    },
  ];

  const filters = (
    <>
      <FilterGroup label="State">
        <FilterOptions options={STATE_OPTIONS} value={state.state || 'live'} onChange={(v) => set({ state: (v as string | undefined) ?? 'live' })} />
      </FilterGroup>
      <FilterGroup label="Type">
        <FilterOptions options={TYPE_OPTIONS} value={state.type} onChange={(v) => set({ type: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Audience">
        <FilterOptions options={AUDIENCE_OPTIONS.map((a) => ({ value: a.value, label: a.label.replace(' (customers and staff)', '') }))} value={state.audience} onChange={(v) => set({ audience: v as string | undefined })} />
      </FilterGroup>
      <FilterGroup label="Customer" defaultOpen={!!state.customerId}>
        <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
      </FilterGroup>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Announcements"
        subtitle="Banners for customers and staff: news, planned maintenance and outage notices, plus the public status page per customer"
        actions={
          <div className="flex items-center gap-2">
            <Segmented value={tab} onChange={(v) => set({ tab: v === 'status' ? 'status' : undefined })} options={[{ value: 'announcements', label: 'Announcements' }, { value: 'status', label: 'Status pages' }]} />
            {tab === 'announcements' && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditor({ open: true, seed: null })}>New announcement</Button>}
          </div>
        }
      />
      {tab === 'status' ? (
        <StatusPagesTab customers={customerItems} />
      ) : (
        <>
          {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}
          <ListShell
            id="announcements"
            modules={OPERATIONS_MODULES}
            filters={filters}
            search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Title or message…' }}
            applied={applied}
            activeCount={applied.length}
            onClear={() => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])))}
            count={data ? `${data.total} announcement${data.total === 1 ? '' : 's'}` : undefined}
          >
            <div className="card overflow-x-auto">
              <DataTable
                columns={columns}
                rows={data?.items ?? []}
                loading={q.isLoading}
                dense
                onRowClick={(r) => setEditor({ open: true, seed: { ...r, sourceTicketId: r.sourceTicket?.id ?? null, sourceTicket: r.sourceTicket } })}
                empty={<EmptyState icon={<Megaphone className="h-5 w-5" />} title={state.state === 'live' || !state.state ? 'Nothing announced right now' : 'Nothing here'} description="Publish a notice, a maintenance window or an outage update; it appears above every page for its audience and on the customer status page." action={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditor({ open: true, seed: null })}>New announcement</Button>} />}
              />
              {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set({ page: p }, false)} />}
            </div>
          </ListShell>
        </>
      )}
      <AnnouncementDialog open={editor.open} onClose={() => setEditor({ open: false, seed: null })} seed={editor.seed} onSaved={() => setEditor({ open: false, seed: null })} />
    </div>
  );
}

/** Public status page links: one or more tokens per customer, shown once, revocable. */
function StatusPagesTab({ customers }: { customers: { id: string; name: string }[] }) {
  const [customerId, setCustomerId] = useState('');
  const [label, setLabel] = useState('');
  const [minted, setMinted] = useState<{ label: string; url: string } | null>(null);
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: announcementKeys.tokens(customerId), queryFn: () => announcementsApi.tokens(customerId), enabled: !!customerId });
  const refresh = () => qc.invalidateQueries({ queryKey: announcementKeys.tokens(customerId) });
  const create = useMutation({ mutationFn: () => announcementsApi.createToken({ customerId, label: label.trim() || 'Status page' }), onSuccess: (t) => { setMinted({ label: t.label, url: t.url }); setLabel(''); void refresh(); }, onError: (e: Error) => toast.error(e.message) });
  const revoke = useMutation({ mutationFn: (id: string) => announcementsApi.revokeToken(id), onSuccess: () => { toast.success('Link revoked'); void refresh(); }, onError: (e: Error) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: (id: string) => announcementsApi.deleteToken(id), onSuccess: () => { toast.success('Link deleted'); void refresh(); }, onError: (e: Error) => toast.error(e.message) });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy; select the link instead');
    }
  };
  const columns: Column<StatusToken>[] = [
    { key: 'label', header: 'Link', width: '100%', render: (r) => <div className="min-w-0"><div className="font-medium truncate">{r.label}</div><div className="text-[11.5px] text-muted font-mono">{r.tokenPrefix}…</div></div> },
    { key: 'status', header: 'Status', width: '110px', render: (r) => <Badge color={r.isActive ? 'green' : 'slate'} dot>{r.isActive ? 'Active' : 'Revoked'}</Badge> },
    { key: 'lastUsedAt', header: 'Last opened', width: '150px', render: (r) => <span className="text-muted text-[12.5px]">{r.lastUsedAt ? relativeTime(r.lastUsedAt) : 'never'}</span> },
    { key: 'createdAt', header: 'Created', width: '140px', render: (r) => <span className="text-muted text-[12.5px]">{relativeTime(r.createdAt)}</span> },
    {
      key: 'actions',
      header: '',
      width: '90px',
      render: (r) => (
        <div className="flex items-center gap-1 justify-end">
          {r.isActive && <Button size="sm" variant="ghost" className="px-2" icon={<Ban className="h-3.5 w-3.5" />} aria-label="Revoke" title="Revoke the link" onClick={() => revoke.mutate(r.id)} />}
          <Button size="sm" variant="ghost" className="px-2 text-red-600" icon={<Trash2 className="h-3.5 w-3.5" />} aria-label="Delete" title="Delete" onClick={() => remove.mutate(r.id)} />
        </div>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="card p-4 flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <span className="h-8 w-8 rounded-lg bg-brand-600/10 text-brand-700 flex items-center justify-center shrink-0"><Globe className="h-4 w-4" /></span>
          <div className="text-[13px]">
            <div className="font-medium">Public status pages</div>
            <div className="text-muted">A link anyone can open without signing in: the customer's business services with their health, planned maintenance, announcements and incident notices in plain words. Each link is shown once; revoke it to close the page.</div>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[12px] text-muted min-w-[220px]">
            Customer
            <Select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setMinted(null); }}>
              <option value="">Choose a customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-muted min-w-[220px]">
            Label
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Lobby screen, IT team" />
          </label>
          <Button icon={<Link2 className="h-4 w-4" />} disabled={!customerId} loading={create.isPending} onClick={() => create.mutate()}>Create link</Button>
        </div>
      </div>
      {customerId ? (
        <div className="card overflow-x-auto">
          <DataTable columns={columns} rows={tokens.data?.items ?? []} loading={tokens.isLoading} dense empty={<EmptyState icon={<Globe className="h-5 w-5" />} title="No status page link yet" description="Create one above and share it; the page updates every couple of minutes." />} />
        </div>
      ) : (
        <EmptyState icon={<Globe className="h-5 w-5" />} title="Pick a customer" description="Their public links are listed here." />
      )}
      <Dialog open={!!minted} onClose={() => setMinted(null)} title="Status page link" width="max-w-lg" footer={<><Button variant="outline" onClick={() => setMinted(null)}>Close</Button><Button icon={<Copy className="h-3.5 w-3.5" />} onClick={() => minted && copy(minted.url)}>Copy link</Button></>}>
        {minted && (
          <div className="flex flex-col gap-2 text-[13px]">
            <p>This is the only time the full link is shown. Anyone with it can open the page.</p>
            <code className="block rounded-md border border-default bg-surface-2 p-2 text-[12px] break-all select-all">{minted.url}</code>
            <p className="text-subtle text-[12px]">Label: {minted.label}</p>
          </div>
        )}
      </Dialog>
    </div>
  );
}
