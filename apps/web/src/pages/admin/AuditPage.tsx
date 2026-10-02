import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, ChevronRight, ChevronDown } from 'lucide-react';
import { get, download, buildQuery } from '@/api/client';
import { Button, Badge, Input, Select, SearchInput, Pagination, EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { fmtDateTime, titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { isNotFound, errorMessage } from '@/components/admin/api';
import { cn } from '@/lib/utils';

interface AuditRow {
  id: string;
  occurredAt: string;
  userId: string | null;
  userName: string | null;
  customerId: string | null;
  customerName?: string | null;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  action: string;
  changes: Record<string, { old: unknown; new: unknown }>;
  source: string;
  ip: string | null;
  metadata: Record<string, unknown>;
}

const ENTITY_TYPES = ['ticket', 'customer', 'site', 'contact', 'contract', 'service', 'asset', 'ci', 'field_visit', 'pm_program', 'kb_article', 'user', 'role', 'team', 'api_key', 'config_option', 'sla_policy', 'catalog_item', 'business_calendar', 'holiday_calendar', 'notification_template', 'notification_rule', 'assignment_rule', 'escalation_rule', 'approval_workflow', 'custom_field', 'ci_type', 'ci_relationship_type', 'system_settings', 'priority_matrix', 'integration'];
const ACTION_COLOR: Record<string, string> = { create: 'green', update: 'blue', delete: 'red', deactivate: 'amber', login: 'slate', clone: 'violet' };

export default function AuditPage() {
  const { state, set, page, pageSize, setPage } = useListState({ pageSize: '50' });
  const customers = useCustomersLookup();
  const [open, setOpen] = useState<string | null>(null);
  const query = { ...state, page, pageSize };
  const q = useQuery({ queryKey: ['audit', query], queryFn: () => get<{ items: AuditRow[]; total: number }>('/audit', query), retry: false });
  const unavailable = q.isError && isNotFound(q.error);

  async function exportCsv() {
    try {
      await download(`/audit/export${buildQuery({ ...state, format: 'csv' })}`, 'audit-log.csv');
    } catch (err) {
      toast.error(isNotFound(err) ? 'Audit export is not available yet' : errorMessage(err));
    }
  }

  const fmtVal = (v: unknown) => (v === null || v === undefined || v === '' ? <span className="text-subtle">empty</span> : typeof v === 'object' ? <code className="font-mono text-[11.5px]">{JSON.stringify(v)}</code> : String(v));

  return (
    <div>
      <SectionHeader title="Audit log" description="Who changed what, when and from where. Every write across the platform is recorded in the same transaction as the change." actions={<Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={unavailable}>Export CSV</Button>} />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-default">
          <SearchInput value={state.q ?? ''} onChange={(v) => set({ q: v })} className="w-56" placeholder="Label, user, action…" />
          <Select value={state.entityType ?? ''} onChange={(e) => set({ entityType: e.target.value })} className="w-44" placeholder="Any entity" options={ENTITY_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} />
          <Input value={state.action ?? ''} onChange={(e) => set({ action: e.target.value })} className="w-32" placeholder="Action" />
          <Select value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} className="w-44" placeholder="Any customer" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          <Input value={state.userId ?? ''} onChange={(e) => set({ userId: e.target.value })} className="w-40" placeholder="User id / email" />
          <Input type="date" value={state.from ?? ''} onChange={(e) => set({ from: e.target.value })} className="w-36" title="From" />
          <Input type="date" value={state.to ?? ''} onChange={(e) => set({ to: e.target.value })} className="w-36" title="To" />
        </div>
        {q.isLoading ? (
          <LoadingBlock />
        ) : unavailable ? (
          <EmptyState title="Audit log viewer not available yet" description="The audit API (GET /audit) is provided by the audit module. Entries are being recorded; they will appear here once that module is deployed." />
        ) : q.error ? (
          <ErrorBlock error={q.error} retry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState title="No audit entries" description="Try widening the filters." />
        ) : (
          <div className="overflow-auto">
            <table className="table [&_td]:py-1.5">
              <thead>
                <tr>
                  <th className="w-6" />
                  <th>When</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Customer</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((r) => {
                  const expanded = open === r.id;
                  const changeKeys = Object.keys(r.changes ?? {});
                  const hasDetails = changeKeys.length > 0 || Object.keys(r.metadata ?? {}).length > 0;
                  return (
                    <Fragment key={r.id}>
                      <tr className={cn(hasDetails && 'clickable')} onClick={() => hasDetails && setOpen(expanded ? null : r.id)}>
                        <td className="text-subtle">{hasDetails && (expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />)}</td>
                        <td className="whitespace-nowrap text-[12.5px]">{fmtDateTime(r.occurredAt)}</td>
                        <td>{r.userName ?? <span className="text-subtle">system</span>}</td>
                        <td><Badge color={ACTION_COLOR[r.action.split('.').pop() ?? ''] ?? 'slate'}>{r.action}</Badge></td>
                        <td>
                          <span className="text-muted text-[12px]">{titleCase(r.entityType)}</span> {r.entityLabel && <span className="font-medium">{r.entityLabel}</span>}
                        </td>
                        <td className="text-muted text-[12.5px]">{r.customerName ?? (r.customerId ? customers.data?.items.find((c) => c.id === r.customerId)?.name ?? '…' : '—')}</td>
                        <td className="text-muted text-[12px]">{r.source}{r.ip ? ` · ${r.ip}` : ''}</td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td />
                          <td colSpan={6} className="bg-surface-2/40">
                            {changeKeys.length > 0 && (
                              <table className="text-[12.5px] mb-2">
                                <thead>
                                  <tr className="text-subtle text-[11px] uppercase tracking-wide">
                                    <th className="bg-transparent border-0 py-1 pr-6 text-left">Field</th>
                                    <th className="bg-transparent border-0 py-1 pr-6 text-left">Before</th>
                                    <th className="bg-transparent border-0 py-1 text-left">After</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {changeKeys.map((k) => (
                                    <tr key={k}>
                                      <td className="border-0 py-0.5 pr-6 font-mono text-[11.5px]">{k}</td>
                                      <td className="border-0 py-0.5 pr-6 text-red-700 dark:text-red-300">{fmtVal(r.changes[k].old)}</td>
                                      <td className="border-0 py-0.5 text-emerald-700 dark:text-emerald-300">{fmtVal(r.changes[k].new)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                            {Object.keys(r.metadata ?? {}).length > 0 && <div className="text-[12px] text-muted font-mono">{JSON.stringify(r.metadata)}</div>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {q.data && <Pagination page={page} pageSize={pageSize} total={q.data.total ?? 0} onPage={setPage} />}
      </div>
    </div>
  );
}
