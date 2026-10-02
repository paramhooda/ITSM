import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Button, DataTable, Pagination, SearchInput, Select, Badge, Dialog, Card, EmptyState, type Column } from '@/components/ui';
import { get, post, ApiError } from '@/api/client';
import { useListState } from '@/hooks/useListState';
import { useLookups, useEngineers } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { CustomerForm, type CustomerPayload } from '@/components/customers/CustomerForm';
import type { CustomerListItem, CustomerDetail } from '@/components/customers/types';
import type { Paginated } from '@/components/contracts/types';

const DEFAULTS = { sort: 'name', order: 'asc', isActive: 'true' };

export default function CustomerListPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { options } = useLookups();
  const engineers = useEngineers();
  const [creating, setCreating] = useState(false);

  const query = useQuery({
    queryKey: ['customers', 'list', state],
    queryFn: () => get<Paginated<CustomerListItem>>('/customers', { page, pageSize, sort: state.sort, order: state.order, q: state.q, statusId: state.statusId, typeId: state.typeId, industryId: state.industryId, accountManagerId: state.accountManagerId, isActive: state.isActive, tag: state.tag }),
    placeholderData: (prev) => prev,
  });

  const create = useMutation({
    mutationFn: (body: CustomerPayload) => post<CustomerDetail>('/customers', body),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      toast.success(`Customer ${c.code} created`);
      setCreating(false);
      navigate(`/customers/${c.id}`);
    },
    onError: (e: ApiError) => toast.error(e.message),
  });

  const opt = (type: string) => options(type).map((o) => ({ value: o.id, label: o.label }));
  const columns: Column<CustomerListItem>[] = [
    { key: 'code', header: 'Code', sortable: true, width: '120px', render: (r) => <span className="font-mono text-[12.5px]">{r.code}</span> },
    {
      key: 'name',
      header: 'Customer',
      sortable: true,
      render: (r) => (
        <div className="min-w-0">
          <div className="font-medium flex items-center gap-2">
            {r.name}
            {!r.isActive && <Badge color="gray">Inactive</Badge>}
          </div>
          {r.tags.length > 0 && <div className="text-[11px] text-subtle truncate">{r.tags.join(' · ')}</div>}
        </div>
      ),
    },
    { key: 'industryLabel', header: 'Industry', render: (r) => <span className="text-muted">{r.industryLabel ?? '—'}</span> },
    { key: 'typeLabel', header: 'Type', render: (r) => <span className="text-muted">{r.typeLabel ?? '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => (r.statusLabel ? <Badge color={r.statusColor ?? undefined} dot>{r.statusLabel}</Badge> : '—') },
    { key: 'accountManagerName', header: 'Account manager', render: (r) => r.accountManagerName ?? <span className="text-subtle">Unassigned</span> },
    { key: 'openTickets', header: 'Open tickets', sortable: true, className: 'text-right tabular-nums', render: (r) => (r.openTickets > 0 ? <span className="font-medium">{r.openTickets}</span> : <span className="text-subtle">0</span>) },
    { key: 'activeContracts', header: 'Active contracts', sortable: true, className: 'text-right tabular-nums', render: (r) => (r.activeContracts > 0 ? r.activeContracts : <span className="text-amber-600">0</span>) },
    { key: 'sites', header: 'Sites', className: 'text-right tabular-nums' },
  ];

  const onSort = (key: string) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' });

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle={query.data ? `${query.data.total} customers` : undefined}
        actions={
          can('customers:manage') && (
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              New customer
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search name, code, email…" className="w-64" />
        <Select value={state.statusId ?? ''} onChange={(e) => set({ statusId: e.target.value })} placeholder="Any status" options={opt('customer_status')} className="w-40" />
        <Select value={state.typeId ?? ''} onChange={(e) => set({ typeId: e.target.value })} placeholder="Any type" options={opt('customer_type')} className="w-40" />
        <Select value={state.industryId ?? ''} onChange={(e) => set({ industryId: e.target.value })} placeholder="Any industry" options={opt('customer_industry')} className="w-44" />
        <Select value={state.accountManagerId ?? ''} onChange={(e) => set({ accountManagerId: e.target.value })} placeholder="Any account manager" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} className="w-48" />
        <Select value={state.isActive ?? 'true'} onChange={(e) => set({ isActive: e.target.value })} options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }, { value: 'all', label: 'All' }]} className="w-28" />
      </div>
      <Card padded={false}>
        <DataTable
          columns={columns}
          rows={query.data?.items ?? []}
          loading={query.isLoading}
          onRowClick={(r) => navigate(`/customers/${r.id}`)}
          sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }}
          onSort={onSort}
          empty={<EmptyState icon={<Building2 className="h-5 w-5" />} title="No customers" description={state.q ? 'No customers match your search.' : 'Create your first customer to start onboarding sites, contacts and contracts.'} />}
        />
        <Pagination page={page} pageSize={pageSize} total={query.data?.total ?? 0} onPage={setPage} />
      </Card>
      <Dialog open={creating} onClose={() => setCreating(false)} title="New customer" width="max-w-2xl">
        <CustomerForm mode="create" onSubmit={(b) => create.mutate(b)} onCancel={() => setCreating(false)} submitting={create.isPending} />
      </Dialog>
    </div>
  );
}
