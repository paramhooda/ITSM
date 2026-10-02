import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Building2, Ticket, Timer, FileSignature } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Button, DataTable, Pagination, SearchInput, Select, Badge, Dialog, Card, EmptyState, FilterBar, type Column } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel, RowList } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { get, post, ApiError } from '@/api/client';
import { useListState } from '@/hooks/useListState';
import { useLookups, useEngineers } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber } from '@/lib/format';
import { CustomerForm, type CustomerPayload } from '@/components/customers/CustomerForm';
import type { CustomerListItem, CustomerDetail } from '@/components/customers/types';
import type { Paginated } from '@/components/contracts/types';

interface CustomerSummary {
  total: number;
  active: number;
  inactive: number;
  byType: { key: string; label: string; count: number }[];
  byStatus: { key: string; label: string; count: number }[];
  openTickets: number;
  breachedTickets: number;
  contractsExpiring60: number;
}

const DEFAULTS = { sort: 'name', order: 'asc', isActive: 'true' };
const FILTER_KEYS = ['q', 'statusId', 'typeId', 'industryId', 'accountManagerId', 'tag'];

export default function CustomerListPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { options } = useLookups();
  const engineers = useEngineers();
  const [creating, setCreating] = useState(false);

  const filters = useMemo(() => ({ q: state.q, statusId: state.statusId, typeId: state.typeId, industryId: state.industryId, accountManagerId: state.accountManagerId, isActive: state.isActive, tag: state.tag }), [state]);
  const query = useQuery({
    queryKey: ['customers', 'list', state],
    queryFn: () => get<Paginated<CustomerListItem>>('/customers', { page, pageSize, sort: state.sort, order: state.order, ...filters }),
    placeholderData: (prev) => prev,
  });
  const summary = useQuery({ queryKey: ['customers', 'summary', filters], queryFn: () => get<CustomerSummary>('/customers/summary', filters), placeholderData: (prev) => prev, staleTime: 30_000 });
  const busiest = useQuery({ queryKey: ['customers', 'busiest', filters], queryFn: () => get<Paginated<CustomerListItem>>('/customers', { page: 1, pageSize: 6, sort: 'openTickets', order: 'desc', ...filters }), staleTime: 30_000 });

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
    { key: 'activeContracts', header: 'Active contracts', sortable: true, className: 'text-right tabular-nums', render: (r) => (r.activeContracts > 0 ? r.activeContracts : <span className="text-amber-600 font-medium" title="No active contract">0</span>) },
    { key: 'sites', header: 'Sites', className: 'text-right tabular-nums' },
  ];

  const onSort = (key: string) => set({ sort: key, order: state.sort === key && state.order === 'asc' ? 'desc' : 'asc' });
  const activeCount = FILTER_KEYS.filter((k) => state[k]).length + (state.isActive !== DEFAULTS.isActive ? 1 : 0);
  const clear = () => set({ ...Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])), isActive: DEFAULTS.isActive });
  const sm = summary.data;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Customers"
        subtitle={sm ? `${fmtNumber(sm.total)} customers · ${fmtNumber(sm.openTickets)} open tickets · ${fmtNumber(sm.contractsExpiring60)} contracts expiring within 60 days` : 'Accounts, sites, contacts and contracts you deliver services to'}
        actions={
          can('customers:manage') && (
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              New customer
            </Button>
          )
        }
      />

      <FilterBar activeCount={activeCount} onClear={clear}>
        <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search name, code, email…" className="w-64" />
        <Select value={state.statusId ?? ''} onChange={(e) => set({ statusId: e.target.value })} placeholder="Any status" options={opt('customer_status')} className="w-36 h-8 py-0 text-[13px]" />
        <Select value={state.typeId ?? ''} onChange={(e) => set({ typeId: e.target.value })} placeholder="Any type" options={opt('customer_type')} className="w-36 h-8 py-0 text-[13px]" />
        <Select value={state.industryId ?? ''} onChange={(e) => set({ industryId: e.target.value })} placeholder="Any industry" options={opt('customer_industry')} className="w-40 h-8 py-0 text-[13px]" />
        <Select value={state.accountManagerId ?? ''} onChange={(e) => set({ accountManagerId: e.target.value })} placeholder="Any account manager" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} className="w-44 h-8 py-0 text-[13px]" />
        <Select value={state.isActive ?? 'true'} onChange={(e) => set({ isActive: e.target.value })} options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }, { value: 'all', label: 'All' }]} className="w-28 h-8 py-0 text-[13px]" />
      </FilterBar>

      <InsightBand
        id="customers"
        loading={summary.isLoading}
        summary={sm ? `${fmtNumber(sm.total)} customers match` : undefined}
        kpis={
          sm
            ? [
                { label: 'Customers', value: fmtNumber(sm.total), icon: <Building2 className="h-4 w-4" />, hint: `${fmtNumber(sm.active)} active · ${fmtNumber(sm.inactive)} inactive` },
                { label: 'Open tickets', value: fmtNumber(sm.openTickets), icon: <Ticket className="h-4 w-4" />, hint: 'across the customers shown', onClick: () => navigate('/tickets') },
                { label: 'SLA breached', value: fmtNumber(sm.breachedTickets), tone: sm.breachedTickets > 0 ? 'bad' : 'good', icon: <Timer className="h-4 w-4" />, hint: 'open tickets past an SLA target', onClick: () => navigate('/tickets?slaState=breached') },
                { label: 'Contracts expiring · 60d', value: fmtNumber(sm.contractsExpiring60), tone: sm.contractsExpiring60 > 0 ? 'warn' : 'good', icon: <FileSignature className="h-4 w-4" />, hint: 'renewals to start now', onClick: () => navigate('/contracts?expiringWithinDays=60') },
              ]
            : []
        }
        panels={
          sm && (
            <>
              <Panel title="Most open tickets" subtitle="Customers carrying the most open work" to="/tickets" toLabel="All tickets">
                <RowList
                  dense
                  empty="No open tickets"
                  items={(busiest.data?.items ?? []).filter((c) => c.openTickets > 0).map((c) => ({ key: c.id, primary: c.name, secondary: `${c.code}${c.accountManagerName ? ` · ${c.accountManagerName}` : ''}`, right: `${fmtNumber(c.openTickets)} open`, href: `/customers/${c.id}` }))}
                />
              </Panel>
              <Panel title="By type" subtitle="How the customer base is made up">
                <BreakdownBar dense items={sm.byType.map((t) => ({ label: t.label, value: t.count }))} emptyText="No customers" />
              </Panel>
            </>
          )
        }
      />

      <Card padded={false}>
        <DataTable
          columns={columns}
          rows={query.data?.items ?? []}
          loading={query.isLoading}
          onRowClick={(r) => navigate(`/customers/${r.id}`)}
          sort={{ key: state.sort, order: state.order as 'asc' | 'desc' }}
          onSort={onSort}
          rowClassName={(r) => (r.isActive && r.activeContracts === 0 ? 'row-rail-warn' : undefined)}
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
