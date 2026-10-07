import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, ChevronRight, ChevronDown } from 'lucide-react';
import { get, download, buildQuery } from '@/api/client';
import { Button, Badge, Input, Pagination, EmptyState, ErrorBlock, LoadingBlock, FilterGroup, FilterDateRange } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { serverToolbar } from '@/hooks/useConfigFilter';
import { fmtDate, fmtDateTime, titleCase } from '@/lib/format';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
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
const SOURCES = [{ value: 'ui', label: 'UI' }, { value: 'api', label: 'API' }, { value: 'ai', label: 'AI' }, { value: 'integration', label: 'Integration' }, { value: 'system', label: 'System' }];
const ACTION_COLOR: Record<string, string> = { create: 'green', update: 'blue', delete: 'red', deactivate: 'amber', login: 'slate', clone: 'violet' };

/**
 * The audit log filters on the server (`q`, `entityType`, `entityId`, `action`,
 * `customerId`, `userId`, `source`, `from`, `to`, `page` in the URL) behind the same
 * toolbar as every configuration page: pills for the entity, the customer and the
 * source, a date-range pill, free text for the action and the user, and every
 * condition in the URL (an entity id from a record's link too) as a breadcrumb chip.
 */
export default function AuditPage() {
  const { state, set, page, pageSize, setPage } = useListState({ pageSize: '50' });
  const customers = useCustomersLookup();
  const [open, setOpen] = useState<string | null>(null);
  const query = { ...state, page, pageSize };
  const q = useQuery({ queryKey: ['audit', query], queryFn: () => get<{ items: AuditRow[]; total: number }>('/audit', query), retry: false });
  // The unfiltered total for the "12 of 1,204" count (one tiny page, refreshed with the list).
  const everyone = useQuery({ queryKey: ['audit', 'total'], queryFn: () => get<{ items: AuditRow[]; total: number }>('/audit', { page: 1, pageSize: 1 }), staleTime: 60_000, retry: false });
  const unavailable = q.isError && isNotFound(q.error);
  const customerOptions = (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }));
  const range = (from?: string, to?: string) => `Date: ${from ? fmtDate(from) : '…'} → ${to ? fmtDate(to) : '…'}`;
  const toolbar = serverToolbar(state, set, {
    selects: [
      { key: 'entityType', label: 'Entity', options: ENTITY_TYPES.map((t) => ({ value: t, label: titleCase(t) })) },
      { key: 'customerId', label: 'Customer', options: customerOptions },
      { key: 'source', label: 'Source', options: SOURCES },
    ],
    extra: [
      { key: 'entityId', label: (v) => `Entity id: ${v}` },
      { key: 'action', label: (v) => `Action: ${v}` },
      { key: 'userId', label: (v) => `User: ${v}` },
      { key: 'from', keys: ['from', 'to'], label: (v, st) => range(v, st.to) },
      { key: 'to', keys: ['from', 'to'], label: (v, st) => (st.from ? null : range(undefined, v)) },
    ],
    searchPlaceholder: 'Label, user, action…',
    noun: ['entry', 'entries'],
    matching: q.data?.total,
    total: everyone.data?.total ?? q.data?.total,
  });

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
      <ConfigToolbar
        {...toolbar}
        extra={
          <>
            <FilterGroup label="Date">
              <FilterDateRange from={state.from} to={state.to} onChange={(r) => set({ from: r.from, to: r.to })} />
            </FilterGroup>
            <Input value={state.action ?? ''} onChange={(e) => set({ action: e.target.value || undefined })} className="w-32 h-8 py-0 text-[12.5px]" placeholder="Action" aria-label="Action" />
            <Input value={state.userId ?? ''} onChange={(e) => set({ userId: e.target.value || undefined })} className="w-40 h-8 py-0 text-[12.5px]" placeholder="User id / email" aria-label="User" />
          </>
        }
      />
      <div className="card overflow-hidden">
        {q.isLoading ? (
          <LoadingBlock />
        ) : unavailable ? (
          <EmptyState title="Audit log viewer not available yet" description="The audit API (GET /audit) is provided by the audit module. Entries are being recorded; they will appear here once that module is deployed." />
        ) : q.error ? (
          <ErrorBlock error={q.error} retry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState title={toolbar.applied.length ? 'No entries match' : 'No audit entries yet'} description={toolbar.applied.length ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Every write across the platform is recorded here as it happens.'} />
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
                                      <td className="border-0 py-0.5 pr-6 text-red-700">{fmtVal(r.changes[k].old)}</td>
                                      <td className="border-0 py-0.5 text-emerald-700">{fmtVal(r.changes[k].new)}</td>
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
        {q.data && q.data.total > pageSize && <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />}
      </div>
    </div>
  );
}
