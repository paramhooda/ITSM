import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Copy, Ban } from 'lucide-react';
import { get, post, del } from '@/api/client';
import { Button, Badge, Dialog, type Column } from '@/components/ui';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { fmtDateTime, fmtDate } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MonoCell, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, type FieldSpec } from '@/components/admin/FormDialog';
import { MultiSelect } from '@/components/admin/inputs';
import { usePermissionCatalog } from '@/components/admin/PermissionMatrix';
import { useAdminMutation } from '@/components/admin/api';

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  customerId: string | null;
  customerName: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const PRESETS: { label: string; permissions: string[] }[] = [
  { label: 'PRTG events', permissions: ['integrations:events', 'tickets:create', 'tickets:read', 'cmdb:read'] },
  { label: 'FortiSIEM events', permissions: ['integrations:events', 'tickets:create', 'tickets:read', 'soc:read', 'cmdb:read'] },
  { label: 'Read-only reporting', permissions: ['tenant:all', 'tickets:read', 'customers:read', 'contracts:read', 'reports:run'] },
];

type Values = Record<string, unknown>;

/** A key is active until it is revoked or its expiry passes; the Status column and the Status pill read the same word. */
const keyStatus = (r: ApiKey): 'active' | 'expired' | 'revoked' => (r.revokedAt ? 'revoked' : r.expiresAt && new Date(r.expiresAt) < new Date() ? 'expired' : 'active');
const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'revoked', label: 'Revoked' },
];

/** API keys: the list with the search, status and customer filters in the URL (`q`, `status`, `customerId`); revoked keys stay listed, struck through. */
export default function ApiKeysPage() {
  const q = useQuery({ queryKey: ['iam', 'api-keys'], queryFn: () => get<ApiKey[]>('/iam/api-keys') });
  const customers = useCustomersLookup();
  const catalog = usePermissionCatalog();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const invalidate = [['iam', 'api-keys']];
  const create = useAdminMutation((body: Values) => post<{ id: string; name: string; key: string }>('/iam/api-keys', body), { invalidate, onSuccess: (r) => setCreated({ name: r.name, key: r.key }) });
  const revoke = useAdminMutation((id: string) => del(`/iam/api-keys/${id}`), { invalidate, success: 'API key revoked' });

  const all = useMemo(() => q.data ?? [], [q.data]);
  const customerOpts = useMemo(() => [{ value: 'msp', label: 'MSP-wide' }, ...(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))], [customers.data]);
  const f = useConfigFilter(all, {
    search: [(r) => r.name, (r) => r.keyPrefix, (r) => r.permissions, (r) => r.customerName],
    selects: [
      { key: 'status', label: 'Status', options: STATUS_OPTIONS, predicate: (r, v) => keyStatus(r) === v },
      { key: 'customerId', label: 'Customer', options: customerOpts, predicate: (r, v) => (v === 'msp' ? r.customerId === null : r.customerId === v) },
    ],
    noun: ['API key', 'API keys'],
    searchPlaceholder: 'Search keys, permissions',
  });

  const permOptions = (catalog.data?.modules ?? []).flatMap((m) => m.permissions.filter((p) => !p.key.startsWith('portal:')).map((p) => ({ value: p.key, label: p.key, hint: m.module })));
  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'PRTG core', span: 2 },
    { key: 'permissions', label: 'Permissions', type: 'custom', required: true, render: ({ value, onChange }) => (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          Presets:
          {PRESETS.map((p) => (
            <button key={p.label} type="button" className="rounded-md border border-default px-2 py-0.5 hover:bg-surface-2" onClick={() => onChange(p.permissions)}>
              {p.label}
            </button>
          ))}
        </div>
        <MultiSelect value={(value as string[]) ?? []} onChange={onChange} options={permOptions} maxHeight="max-h-56" />
      </div>
    ) },
    { key: 'customerId', label: 'Customer scope', type: 'select', options: (customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` })), hint: 'Leave empty for an MSP-wide key (requires tenant:all for cross-customer access)' },
    { key: 'expiresAt', label: 'Expires', type: 'date', hint: 'Optional' },
  ];

  const columns: Column<ApiKey>[] = [
    { key: 'name', header: 'Key', render: (r) => (
      <div>
        <div className={r.revokedAt ? 'line-through text-subtle' : 'font-medium'}>{r.name}</div>
        <MonoCell>{r.keyPrefix}…</MonoCell>
      </div>
    ) },
    { key: 'permissions', header: 'Permissions', render: (r) => <MutedCell>{r.permissions.join(', ')}</MutedCell> },
    { key: 'customer', header: 'Customer', render: (r) => <MutedCell>{r.customerName ?? 'All (MSP)'}</MutedCell> },
    { key: 'lastUsedAt', header: 'Last used', render: (r) => <MutedCell>{r.lastUsedAt ? fmtDateTime(r.lastUsedAt) : 'Never'}</MutedCell> },
    { key: 'expiresAt', header: 'Expires', render: (r) => <MutedCell>{r.expiresAt ? fmtDate(r.expiresAt) : '—'}</MutedCell> },
    { key: 'status', header: 'Status', render: (r) => {
      const s = keyStatus(r);
      return s === 'revoked' ? <Badge color="gray">Revoked</Badge> : s === 'expired' ? <Badge color="amber">Expired</Badge> : <Badge color="green" dot>Active</Badge>;
    } },
  ];

  return (
    <div>
      <SectionHeader title="API keys" description="Keys for monitoring, SIEM and automation integrations. Send them in the X-API-Key header; the raw key is shown only once." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreateOpen(true)}>New API key</Button>} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<ApiKey>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        emptyTitle={f.filtered ? 'No API keys match' : 'No API keys yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Create a key for a monitoring, SIEM or automation integration; the raw key is shown once.'}
        actions={[{ label: 'Revoke', icon: <Ban className="h-4 w-4" />, inline: true, danger: true, hidden: (r) => !!r.revokedAt, confirm: (r) => ({ title: `Revoke "${r.name}"?`, description: 'Integrations using it stop working immediately.', confirmLabel: 'Revoke key' }), onClick: (r) => revoke.mutate(r.id) }]}
      />
      <FormDialog<Values> open={createOpen} onClose={() => setCreateOpen(false)} title="New API key" fields={fields} initial={{ name: '', permissions: [], customerId: null, expiresAt: null }} onSubmit={(v) => create.mutateAsync({ name: v.name, permissions: v.permissions, customerId: v.customerId || null, expiresAt: v.expiresAt ? new Date(`${v.expiresAt}T23:59:59`).toISOString() : null })} submitLabel="Create key" />
      <Dialog open={!!created} onClose={() => setCreated(null)} title={`API key: ${created?.name ?? ''}`} width="max-w-lg" footer={<Button onClick={() => setCreated(null)}>Done</Button>}>
        <div className="text-[13px] text-muted mb-3">Copy the key now; it cannot be displayed again.</div>
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-[12.5px] rounded-lg border border-default bg-surface-2 px-3 py-2 break-all select-all">{created?.key}</code>
          <Button variant="outline" icon={<Copy className="h-4 w-4" />} onClick={() => { void navigator.clipboard?.writeText(created?.key ?? ''); toast.success('Copied'); }}>
            Copy
          </Button>
        </div>
        <div className="mt-3 text-[12px] text-subtle font-mono">curl -H "X-API-Key: {created?.key?.slice(0, 12)}…" {window.location.origin}/api/integrations/…</div>
      </Dialog>
    </div>
  );
}
