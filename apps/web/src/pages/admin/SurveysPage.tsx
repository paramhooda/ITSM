import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { TICKET_TYPES } from '@itsm/shared';
import { Button, Badge, Card, KeyValue, type Column } from '@/components/ui';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useAdminMutation } from '@/components/admin/api';
import { useCustomersLookup } from '@/hooks/useLookups';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { useAuthStore } from '@/stores/auth';
import { get } from '@/api/client';
import { fmtDateTime, titleCase } from '@/lib/format';
import { itemsOf } from '@/components/tickets/api';
import { surveysApi, surveyKeys, SEND_ON_LABELS, type SurveyConfig, type SurveyConfigInput } from '@/components/surveys/api';

type Values = Record<string, unknown>;
const INHERIT = { value: '', label: 'Inherit' };
const toStr = (v: unknown) => (v === null || v === undefined ? '' : v === true ? 'true' : v === false ? 'false' : String(v));
const toBool = (v: unknown) => (v === 'true' ? true : v === 'false' ? false : null);
const toInt = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
const toText = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const TYPE_OPTIONS = TICKET_TYPES.map((t) => ({ value: t, label: titleCase(t) }));

/** Survey policies: the global defaults from the settings and the overrides per customer or contract, with the search, scope and surveys filters in the URL (`q`, `scope`, `enabled`). */
export default function SurveysPage() {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const policy = useQuery({ queryKey: surveyKeys.policy({}), queryFn: () => surveysApi.policy() });
  const q = useQuery({ queryKey: surveyKeys.configs, queryFn: () => surveysApi.configs() });
  const editor = useEditor<SurveyConfig>();
  const customers = useCustomersLookup();
  const customerOpts = itemsOf<{ id: string; name: string }>(customers.data).map((c) => ({ value: c.id, label: c.name }));
  const canContracts = can('contracts:read');
  const invalidate = [['surveys']];
  const create = useAdminMutation((body: SurveyConfigInput) => surveysApi.createConfig(body), { invalidate, success: 'Survey override created' });
  const update = useAdminMutation(({ id, ...body }: Partial<SurveyConfigInput> & { id: string }) => surveysApi.updateConfig(id, body), { invalidate, success: 'Survey override updated' });
  const remove = useAdminMutation((id: string) => surveysApi.deleteConfig(id), { invalidate, success: 'Survey override deleted' });
  const p = policy.data;
  const all = useMemo(() => q.data?.items ?? [], [q.data]);
  const f = useConfigFilter(all, {
    search: [(r) => r.customerName, (r) => r.contractNumber, (r) => r.contractName, (r) => r.question, (r) => r.notes],
    selects: [
      { key: 'scope', label: 'Scope', options: [{ value: 'customer', label: 'Whole customer' }, { value: 'contract', label: 'One contract' }], predicate: (r, v) => (r.contractId ? 'contract' : 'customer') === v },
      { key: 'enabled', label: 'Surveys', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }, { value: 'inherit', label: 'Inherit' }], predicate: (r, v) => (r.enabled === null ? 'inherit' : r.enabled ? 'on' : 'off') === v },
    ],
    noun: ['override', 'overrides'],
    searchPlaceholder: 'Search customers, contracts',
  });

  const fields: FieldSpec<Values>[] = [
    { key: 'customerId', label: 'Customer', type: 'select', options: customerOpts, required: true, disabled: () => !!editor.row, span: canContracts ? 1 : 2 },
    ...(canContracts ? [{ key: 'contractId', label: 'Contract', type: 'custom' as const, span: 1 as const, hint: 'Empty = the whole customer', disabled: (v: Values) => !v.customerId || !!editor.row, render: ({ value, onChange, values, disabled }: { value: unknown; onChange: (v: unknown) => void; values: Values; disabled: boolean }) => <ContractSelect customerId={String(values.customerId ?? '')} value={String(value ?? '')} onChange={onChange} disabled={disabled} /> }] : []),
    { key: 'enabled', label: 'Surveys', type: 'select', options: [INHERIT, { value: 'true', label: 'On' }, { value: 'false', label: 'Off' }], section: 'Policy' },
    { key: 'sendOn', label: 'Send when the ticket is', type: 'select', options: [INHERIT, { value: 'resolved', label: 'Resolved' }, { value: 'closed', label: 'Closed' }] },
    { key: 'resendOnClose', label: 'Send again on closure', type: 'select', options: [INHERIT, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }], hint: 'When the survey is still unanswered a day after resolution' },
    { key: 'samplingPct', label: 'Sampling (%)', type: 'number', min: 0, max: 100, placeholder: p ? String(p.samplingPct) : 'Inherit', hint: 'Share of eligible tickets that get a survey' },
    { key: 'ticketTypes', label: 'Ticket types', type: 'multiselect', options: TYPE_OPTIONS, hint: 'Empty = inherit' },
    { key: 'lowRatingThreshold', label: 'Low rating at or below', type: 'number', min: 1, max: 4, placeholder: p ? String(p.lowRatingThreshold) : 'Inherit', hint: 'Alerts the account manager, team manager and assignee' },
    { key: 'reminderDays', label: 'Reminder after (days)', type: 'number', min: 0, max: 60, placeholder: p ? String(p.reminderDays) : 'Inherit', section: 'Timing', hint: '0 = no reminder' },
    { key: 'expiryDays', label: 'Link valid for (days)', type: 'number', min: 1, max: 90, placeholder: p ? String(p.expiryDays) : 'Inherit' },
    { key: 'fatigueDays', label: 'At most one survey per requester every (days)', type: 'number', min: 0, max: 365, placeholder: p ? String(p.fatigueDays) : 'Inherit', hint: '0 = no limit' },
    { key: 'question', label: 'Question', type: 'textarea', rows: 2, span: 2, placeholder: p?.question ?? 'Inherit', section: 'Wording' },
    { key: 'commentPrompt', label: 'Comment prompt', type: 'textarea', rows: 2, span: 2, placeholder: p?.commentPrompt || 'Inherit' },
    { key: 'notes', label: 'Notes', type: 'textarea', rows: 2, span: 2, placeholder: 'Why this override exists (internal)' },
  ];
  const initial: Values = editor.row
    ? { customerId: editor.row.customerId, contractId: editor.row.contractId ?? '', enabled: toStr(editor.row.enabled), sendOn: editor.row.sendOn ?? '', resendOnClose: toStr(editor.row.resendOnClose), samplingPct: toStr(editor.row.samplingPct), ticketTypes: editor.row.ticketTypes ?? [], lowRatingThreshold: toStr(editor.row.lowRatingThreshold), reminderDays: toStr(editor.row.reminderDays), expiryDays: toStr(editor.row.expiryDays), fatigueDays: toStr(editor.row.fatigueDays), question: editor.row.question ?? '', commentPrompt: editor.row.commentPrompt ?? '', notes: editor.row.notes ?? '' }
    : { customerId: '', contractId: '', enabled: '', sendOn: '', resendOnClose: '', samplingPct: '', ticketTypes: [], lowRatingThreshold: '', reminderDays: '', expiryDays: '', fatigueDays: '', question: '', commentPrompt: '', notes: '' };
  async function submit(v: Values) {
    const types = Array.isArray(v.ticketTypes) ? (v.ticketTypes as string[]).filter(Boolean) : [];
    const body = {
      enabled: toBool(v.enabled),
      sendOn: (v.sendOn as 'resolved' | 'closed' | '') || null,
      resendOnClose: toBool(v.resendOnClose),
      samplingPct: toInt(v.samplingPct),
      ticketTypes: types.length ? types : null,
      lowRatingThreshold: toInt(v.lowRatingThreshold),
      reminderDays: toInt(v.reminderDays),
      expiryDays: toInt(v.expiryDays),
      fatigueDays: toInt(v.fatigueDays),
      question: toText(v.question),
      commentPrompt: toText(v.commentPrompt),
      notes: toText(v.notes),
    };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync({ customerId: String(v.customerId), contractId: (v.contractId as string) || null, ...body });
    await qc.invalidateQueries({ queryKey: ['surveys'] });
  }

  const inherited = <span className="text-subtle">inherit</span>;
  const columns: Column<SurveyConfig>[] = [
    { key: 'scope', header: 'Scope', width: '230px', render: (r) => <div className="min-w-[180px] max-w-[230px]"><div className="font-medium truncate" title={r.customerName}>{r.customerName}</div><MutedCell>{r.contractNumber ? <span className="block truncate" title={`${r.contractNumber}${r.contractName ? ` · ${r.contractName}` : ''}`}>{r.contractNumber}{r.contractName ? ` · ${r.contractName}` : ''}</span> : 'Whole customer'}</MutedCell></div> },
    { key: 'enabled', header: 'Surveys', width: '90px', render: (r) => (r.enabled === null ? inherited : <ActiveDot active={r.enabled} />) },
    { key: 'sendOn', header: 'Send on', width: '110px', render: (r) => (r.sendOn ? <Badge color={r.sendOn === 'closed' ? 'slate' : 'green'}>{r.sendOn}</Badge> : inherited) },
    { key: 'sampling', header: 'Sampling', width: '90px', className: 'text-right', render: (r) => (r.samplingPct === null ? inherited : <span className="tnum">{r.samplingPct}%</span>) },
    { key: 'timing', header: 'Reminder / expiry', width: '140px', render: (r) => <span className="tnum text-[12.5px]">{r.reminderDays === null ? 'inherit' : `${r.reminderDays} d`} / {r.expiryDays === null ? 'inherit' : `${r.expiryDays} d`}</span> },
    { key: 'question', header: 'Question', render: (r) => <MutedCell>{r.question ? <span className="block max-w-[220px] truncate" title={r.question}>{r.question}</span> : 'inherit'}</MutedCell> },
    // The least load-bearing column: wide screens only, so the table fits its card without a scrollbar.
    { key: 'updated', header: 'Updated', width: '170px', className: 'hidden 2xl:table-cell', render: (r) => <MutedCell><span className="whitespace-nowrap">{fmtDateTime(r.updatedAt)}</span></MutedCell> },
  ];

  return (
    <div>
      <SectionHeader title="Satisfaction surveys" description="The one-question survey customers receive when a ticket is resolved or closed: the defaults below apply everywhere, an override changes them for one customer or one contract." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New override</Button>} />
      <Card title="Defaults" actions={<Link to="/admin/settings" className="text-[12.5px] text-brand-700 hover:underline">Change the defaults under Settings → Customer satisfaction</Link>} className="mb-5">
        {p ? (
          <KeyValue
            columns={3}
            items={[
              { label: 'Surveys', value: <Badge color={p.enabled ? 'green' : 'slate'}>{p.enabled ? 'On' : 'Off'}</Badge> },
              { label: 'Sent', value: `${SEND_ON_LABELS[p.sendOn] ?? p.sendOn}${p.resendOnClose && p.sendOn === 'resolved' ? ', again on closure when unanswered' : ''}` },
              { label: 'Sampling', value: `${p.samplingPct}% of ${p.ticketTypes.map((t) => titleCase(t).toLowerCase()).join(' and ')} tickets` },
              { label: 'Reminder', value: p.reminderDays ? `after ${p.reminderDays} days` : 'none' },
              { label: 'Link valid for', value: `${p.expiryDays} days` },
              { label: 'At most one survey per requester every', value: p.fatigueDays ? `${p.fatigueDays} days` : 'no limit' },
              { label: 'Low rating alert', value: `rating ${p.lowRatingThreshold} or less` },
              { label: 'Counted as satisfied', value: `rating ${p.satisfiedThreshold} or more` },
              { label: 'Question', value: <span className="italic">“{p.question}”</span>, span: 3 },
              { label: 'Comment prompt', value: p.commentPrompt ? <span className="italic">“{p.commentPrompt}”</span> : <span className="text-subtle">none</span>, span: 3 },
            ]}
          />
        ) : (
          <div className="text-[13px] text-muted">Loading the defaults…</div>
        )}
      </Card>
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<SurveyConfig>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No overrides match' : 'No overrides'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Every customer follows the defaults above. Add an override to switch a customer off, change its sampling or its question.'}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete the override for ${r.contractNumber ? `${r.customerName} · ${r.contractNumber}` : r.customerName}?`, description: 'The customer follows the defaults again.', confirmLabel: 'Delete' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? `Override · ${editor.row.contractNumber ? `${editor.row.customerName} · ${editor.row.contractNumber}` : editor.row.customerName}` : 'New survey override'} description="Empty fields inherit the defaults (or the customer override, for a contract)." fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" />
    </div>
  );
}

/** The contracts of the chosen customer; a contract override sits above the customer's own. */
function ContractSelect({ customerId, value, onChange, disabled }: { customerId: string; value: string; onChange: (v: unknown) => void; disabled: boolean }) {
  const q = useQuery({ queryKey: ['contracts', 'customer', customerId], queryFn: () => get<{ items: { id: string; number: string; name: string }[] }>(`/customers/${customerId}/contracts`), enabled: !!customerId && !disabled });
  const items = itemsOf<{ id: string; number: string; name: string }>(q.data);
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || !customerId}>
      <option value="">{customerId ? 'Whole customer' : 'Pick a customer first'}</option>
      {items.map((c) => (
        <option key={c.id} value={c.id}>{c.number} · {c.name}</option>
      ))}
    </select>
  );
}
