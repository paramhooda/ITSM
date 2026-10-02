import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, AlertTriangle, FileSignature } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Button, DataTable, Pagination, SearchInput, Select, Badge, Drawer, Card, EmptyState, type Column } from '@/components/ui';
import { get, post, ApiError } from '@/api/client';
import { useListState } from '@/hooks/useListState';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ContractForm, type ContractPayload } from '@/components/contracts/ContractForm';
import { ContractStatusBadge, ExpiryCountdown } from '@/components/contracts/ContractBits';
import { CONTRACT_STATUSES, type ContractListItem, type ContractDetail, type Paginated } from '@/components/contracts/types';

const DEFAULTS = { sort: 'endDate', order: 'asc' };
const STATUS_COLORS: Record<string, string> = { draft: 'slate', active: 'green', expiring: 'amber', expired: 'red', renewed: 'blue', terminated: 'gray' };

export default function ContractListPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { options, byKey } = useLookups();
  const customers = useCustomersLookup();
  const [creating, setCreating] = useState(state.new === '1');
  const statuses = (state.status ?? '').split(',').filter(Boolean);

  const query = useQuery({
    queryKey: ['contracts', 'list', state],
    queryFn: () => get<Paginated<ContractListItem>>('/contracts', { page, pageSize, sort: state.sort, order: state.order, q: state.q, customerId: state.customerId, status: state.status, typeId: state.typeId, expiringWithinDays: state.expiringWithinDays, serviceId: state.serviceId, ownerUserId: state.ownerUserId }),
    placeholderData: (prev) => prev,
  });

  const create = useMutation({
    mutationFn: (body: ContractPayload) => post<ContractDetail>('/contracts', body),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['contracts'] });
      toast.success(`Contract ${c.number} created`);
      setCreating(false);
      navigate(`/contracts/${c.id}`);
    },
    onError: (e: ApiError) => toast.error(e.message),
  });

  const toggleStatus = (s: string) => set({ status: (statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s]).join(',') });

  const columns: Column<ContractListItem>[] = [
    { key: 'number', header: 'Number', sortable: true, width: '140px', render: (r) => <span className="font-mono text-[12.5px]">{r.number}</span> },
    { key: 'name', header: 'Contract', sortable: true, render: (r) => <div className="min-w-0"><div className="font-medium truncate">{r.name}</div>{r.ownerName && <div className="text-[11px] text-subtle">Owner: {r.ownerName}</div>}</div> },
    { key: 'customer', header: 'Customer', sortable: true, render: (r) => <span>{r.customerName} <span className="text-subtle font-mono text-[11px]">{r.customerCode}</span></span> },
    { key: 'typeLabel', header: 'Type', render: (r) => <span className="text-muted">{r.typeLabel ?? '—'}</span> },
    { key: 'status', header: 'Status', sortable: true, render: (r) => <ContractStatusBadge status={r.status} label={r.statusLabel} color={r.statusColor} /> },
    { key: 'startDate', header: 'Start', sortable: true, render: (r) => <span className="text-muted">{fmtDate(r.startDate)}</span> },
    { key: 'endDate', header: 'End', sortable: true, render: (r) => <ExpiryCountdown days={r.daysToExpiry} endDate={r.endDate} status={r.status} /> },
    { key: 'services', header: 'Services', render: (r) => <span className="text-muted truncate block max-w-[260px]" title={r.serviceNames.join(', ')}>{r.serviceNames.length ? r.serviceNames.join(', ') : '—'}</span> },
    {
      key: 'entitlements',
      header: 'Entitlements',
      render: (r) =>
        r.entitlements.count === 0 ? (
          <span className="text-subtle">—</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            {r.entitlements.count}
            {(r.entitlements.anyExhausted || r.entitlements.anyOverThreshold) && <AlertTriangle className={cn('h-3.5 w-3.5', r.entitlements.anyExhausted ? 'text-red-500' : 'text-amber-500')} aria-label={r.entitlements.anyExhausted ? 'Entitlement exhausted' : 'Entitlement over threshold'} />}
          </span>
        ),
    },
  ];
  const onSort = (key: string) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' });

  return (
    <div>
      <PageHeader
        title="Contracts & Scope"
        subtitle={query.data ? `${query.data.total} contracts` : undefined}
        actions={can('contracts:manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New contract</Button>}
      />
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search number or name…" className="w-60" />
        <Select value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} className="w-52" />
        <Select value={state.typeId ?? ''} onChange={(e) => set({ typeId: e.target.value })} placeholder="Any type" options={options('contract_type').map((o) => ({ value: o.id, label: o.label }))} className="w-44" />
        <Select value={state.expiringWithinDays ?? ''} onChange={(e) => set({ expiringWithinDays: e.target.value })} placeholder="Any expiry" options={[{ value: '30', label: 'Expiring in 30 days' }, { value: '60', label: 'Expiring in 60 days' }, { value: '90', label: 'Expiring in 90 days' }]} className="w-44" />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        <span className="text-xs text-muted mr-1">Status:</span>
        {CONTRACT_STATUSES.map((s) => {
          const opt = byKey('contract_status', s);
          const active = statuses.includes(s);
          return (
            <button key={s} onClick={() => toggleStatus(s)} className={cn('rounded-full border px-2.5 py-0.5 text-[12px] transition-colors', active ? 'border-brand-500 bg-brand-600/10 text-brand-700' : 'border-default text-muted hover:text-default')}>
              <Badge color={opt?.color ?? STATUS_COLORS[s]} className="px-0 py-0 bg-transparent">{opt?.label ?? s}</Badge>
            </button>
          );
        })}
        {statuses.length > 0 && <button className="text-xs text-subtle hover:text-default ml-1" onClick={() => set({ status: '' })}>clear</button>}
      </div>
      <Card padded={false}>
        <DataTable columns={columns} rows={query.data?.items ?? []} loading={query.isLoading} onRowClick={(r) => navigate(`/contracts/${r.id}`)} sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }} onSort={onSort} empty={<EmptyState icon={<FileSignature className="h-5 w-5" />} title="No contracts" description="Contracts define covered services and sites, SLA policy, entitlements and scope." />} />
        <Pagination page={page} pageSize={pageSize} total={query.data?.total ?? 0} onPage={setPage} />
      </Card>
      <Drawer open={creating} onClose={() => { setCreating(false); if (state.new) set({ new: undefined }, false); }} title="New contract" width="max-w-3xl">
        {creating && <ContractForm mode="create" customerId={state.customerId || undefined} onSubmit={(b) => create.mutate(b)} onCancel={() => setCreating(false)} submitting={create.isPending} />}
      </Drawer>
    </div>
  );
}
