import { useMemo, useState } from 'react';
import { Field, Select, Input, Textarea, Checkbox, Toggle, Button } from '@/components/ui';
import { useCustomersLookup, useEngineers } from '@/hooks/useLookups';
import { ParameterForm } from './ParameterForm';
import { DATE_PRESETS, FREQUENCIES, SCHEDULE_FORMATS, type ReportDefinition, type Schedule } from './types';

export interface SchedulePayload {
  name: string;
  reportKey: string;
  customerId: string | null;
  recipients: string[];
  recipientUserIds: string[];
  frequency: string;
  cronExpression: string | null;
  timezone: string;
  dateRange: string;
  filters: Record<string, unknown>;
  format: string;
  delivery: string;
  isActive: boolean;
}

const browserTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export function ScheduleForm({ definitions, initial, onSubmit, onCancel, saving, pdf = true }: { definitions: ReportDefinition[]; initial?: Partial<Schedule> & { filters?: Record<string, unknown> }; onSubmit: (p: SchedulePayload) => void; onCancel: () => void; saving?: boolean; pdf?: boolean }) {
  const customers = useCustomersLookup();
  const engineers = useEngineers();
  const [name, setName] = useState(initial?.name ?? '');
  const [reportKey, setReportKey] = useState(initial?.reportKey ?? definitions[0]?.key ?? '');
  const [customerId, setCustomerId] = useState(initial?.customerId ?? '');
  const [perCustomer, setPerCustomer] = useState(initial?.filters?.perCustomer === true);
  const [customerContacts, setCustomerContacts] = useState(initial?.filters?.customerContacts === true);
  const [emails, setEmails] = useState((initial?.recipients ?? []).join('\n'));
  const [userIds, setUserIds] = useState<string[]>(initial?.recipientUserIds ?? []);
  const [frequency, setFrequency] = useState(initial?.frequency ?? 'weekly');
  const [cron, setCron] = useState(initial?.cronExpression ?? '');
  const [timezone, setTimezone] = useState(initial?.timezone ?? browserTz());
  const [dateRange, setDateRange] = useState(initial?.dateRange ?? 'last_7_days');
  const [format, setFormat] = useState(initial?.format ?? 'html');
  const [delivery, setDelivery] = useState(initial?.delivery ?? 'email');
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [filters, setFilters] = useState<Record<string, unknown>>(() => {
    const { customerContacts: _c, perCustomer: _p, ...rest } = initial?.filters ?? {};
    return rest;
  });
  const def = useMemo(() => definitions.find((d) => d.key === reportKey), [definitions, reportKey]);
  const submit = () => {
    onSubmit({
      name: name.trim() || def?.name || 'Scheduled report',
      reportKey,
      customerId: customerId || null,
      recipients: emails.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
      recipientUserIds: userIds,
      frequency,
      cronExpression: frequency === 'cron' ? cron.trim() || null : null,
      timezone: timezone.trim() || 'UTC',
      dateRange,
      filters: { ...filters, ...(customerContacts ? { customerContacts: true } : {}), ...(perCustomer && !customerId ? { perCustomer: true } : {}) },
      format,
      delivery,
      isActive,
    });
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={def ? `${def.name} – weekly` : ''} /></Field>
        <Field label="Report" required><Select value={reportKey} onChange={(e) => { setReportKey(e.target.value); setFilters({}); }} options={definitions.map((d) => ({ value: d.key, label: d.name }))} /></Field>
        <Field label="Customer" hint={customerId ? undefined : 'Empty = one MSP-wide run, or one run per active customer'}>
          <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} />
        </Field>
        {!customerId && <Field label="Fan-out"><Checkbox checked={perCustomer} onChange={(e) => setPerCustomer(e.target.checked)} label="One report per active customer" /></Field>}
      </div>
      {def && def.parameters.some((p) => p.type !== 'customer' && p.type !== 'daterange') && (
        <div>
          <div className="text-[12.5px] font-medium text-muted mb-1.5">Report filters</div>
          <ParameterForm definition={def} value={filters} onChange={setFilters} hide={['customer', 'daterange']} />
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Frequency" required><Select value={frequency} onChange={(e) => setFrequency(e.target.value)} options={FREQUENCIES} /></Field>
        {frequency === 'cron' ? <Field label="Cron expression" required hint="minute hour day month weekday (at most hourly)"><Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 6 * * 1-5" className="font-mono" /></Field> : <div />}
        <Field label="Timezone" required hint="IANA name, e.g. Asia/Kolkata"><Input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></Field>
        <Field label="Period covered" required><Select value={dateRange} onChange={(e) => setDateRange(e.target.value)} options={DATE_PRESETS.filter((p) => p.value !== 'custom')} /></Field>
        <Field label="Format" required><Select value={format} onChange={(e) => setFormat(e.target.value)} options={SCHEDULE_FORMATS(pdf)} /></Field>
        <Field label="Delivery" required hint="Portal makes the run visible to the customer's portal users"><Select value={delivery} onChange={(e) => setDelivery(e.target.value)} options={[{ value: 'email', label: 'Email' }, { value: 'portal', label: 'Customer portal' }, { value: 'both', label: 'Email + portal' }]} /></Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Email recipients" hint="One address per line"><Textarea value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="ops@example.com" /></Field>
        <div className="flex flex-col gap-2">
          <Field label="Users">
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
              {(engineers.data ?? []).map((u) => {
                const on = userIds.includes(u.id);
                return (
                  <button key={u.id} type="button" title={u.email} onClick={() => setUserIds(on ? userIds.filter((x) => x !== u.id) : [...userIds, u.id])} className={`rounded-md border px-2 py-0.5 text-[12px] ${on ? 'bg-brand-600 border-brand-600 text-white' : 'border-default text-muted hover:bg-surface-2'}`}>
                    {u.name}
                  </button>
                );
              })}
            </div>
          </Field>
          <Checkbox checked={customerContacts} onChange={(e) => setCustomerContacts(e.target.checked)} label="Send to the customer's primary and escalation contacts" />
          <Toggle checked={isActive} onChange={setIsActive} label="Active" />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2 border-t border-default">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button onClick={submit} loading={saving} disabled={!reportKey}>{initial?.id ? 'Save schedule' : 'Create schedule'}</Button>
      </div>
    </div>
  );
}
