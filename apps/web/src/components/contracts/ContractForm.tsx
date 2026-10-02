import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Field, Input, Select, Textarea, Card } from '@/components/ui';
import { get } from '@/api/client';
import { useLookups, useEngineers, useCustomersLookup } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import type { ContractDetail, ServiceCoverageInput } from './types';
import type { Site } from '@/components/customers/types';

const nz = (s: string) => (s.trim() === '' ? null : s.trim());
const num = (s: string) => (s.trim() === '' ? null : Number(s));

export interface ContractPayload {
  customerId: string;
  name: string;
  number?: string;
  typeId: string | null;
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  noticePeriodDays: number | null;
  autoRenew: boolean;
  slaPolicyId: string | null;
  supportHoursCalendarId: string | null;
  holidayCalendarId: string | null;
  ownerUserId: string | null;
  description: string | null;
  responseCommitment: string | null;
  resolutionCommitment: string | null;
  exclusions: string | null;
  value?: number | null;
  currency?: string | null;
  billingCycle?: string | null;
  poNumber?: string | null;
  signedAt?: string | null;
  services?: ServiceCoverageInput[];
  siteIds?: string[];
}

/** Checklist of catalog services with per-service SLA policy / team / support hours overrides. */
export function ServiceCoverageEditor({ value, onChange, compact }: { value: ServiceCoverageInput[]; onChange: (v: ServiceCoverageInput[]) => void; compact?: boolean }) {
  const { lookups } = useLookups();
  const services = lookups?.services ?? [];
  const policies = lookups?.slaPolicies ?? [];
  const teams = lookups?.teams ?? [];
  const calendars = lookups?.calendars ?? [];
  const byId = new Map(value.map((v) => [v.serviceId, v]));
  const toggle = (id: string) => (byId.has(id) ? onChange(value.filter((v) => v.serviceId !== id)) : onChange([...value, { serviceId: id }]));
  const patch = (id: string, p: Partial<ServiceCoverageInput>) => onChange(value.map((v) => (v.serviceId === id ? { ...v, ...p } : v)));
  if (!services.length) return <div className="text-[13px] text-muted">No services in the catalog yet.</div>;
  return (
    <div className="border border-default rounded-lg divide-y divide-[var(--border)] max-h-[360px] overflow-y-auto">
      {services.map((s) => {
        const sel = byId.get(s.id);
        return (
          <div key={s.id} className="px-3 py-2">
            <Checkbox checked={!!sel} onChange={() => toggle(s.id)} label={<span>{s.name} <span className="text-subtle text-[11px] uppercase ml-1">{s.domain}</span></span>} />
            {sel && !compact && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2 pl-6">
                <Select value={sel.slaPolicyId ?? ''} onChange={(e) => patch(s.id, { slaPolicyId: e.target.value || null })} placeholder="SLA: contract default" options={policies.map((p) => ({ value: p.id, label: `SLA: ${p.name}` }))} />
                <Select value={sel.teamId ?? ''} onChange={(e) => patch(s.id, { teamId: e.target.value || null })} placeholder="Team: service default" options={teams.map((t) => ({ value: t.id, label: `Team: ${t.name}` }))} />
                <Select value={sel.supportHoursCalendarId ?? ''} onChange={(e) => patch(s.id, { supportHoursCalendarId: e.target.value || null })} placeholder="Hours: contract default" options={calendars.map((c) => ({ value: c.id, label: `Hours: ${c.name}` }))} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Multi-select of a customer's sites; empty selection = all sites covered. */
export function SiteMultiSelect({ customerId, value, onChange }: { customerId: string | null; value: string[]; onChange: (v: string[]) => void }) {
  const sites = useQuery({ queryKey: ['customers', customerId, 'sites'], queryFn: () => get<Site[]>(`/customers/${customerId}/sites`), enabled: !!customerId });
  if (!customerId) return <div className="text-[13px] text-muted">Select a customer first.</div>;
  const list = sites.data ?? [];
  if (!list.length) return <div className="text-[13px] text-muted">This customer has no sites; the contract covers all sites.</div>;
  return (
    <div className="border border-default rounded-lg max-h-[220px] overflow-y-auto">
      <div className="px-3 py-1.5 text-[11.5px] text-subtle border-b border-default">{value.length === 0 ? 'No selection = all sites are covered' : `${value.length} of ${list.length} sites covered`}</div>
      {list.map((s) => (
        <div key={s.id} className="px-3 py-1.5">
          <Checkbox checked={value.includes(s.id)} onChange={(e) => onChange(e.target.checked ? [...value, s.id] : value.filter((x) => x !== s.id))} label={<span>{s.name} <span className="text-subtle">({s.code})</span>{s.isPrimary && <span className="text-[10.5px] uppercase ml-1 text-brand-600">primary</span>}</span>} />
        </div>
      ))}
    </div>
  );
}

export function ContractForm({ initial, customerId, onSubmit, onCancel, submitting, mode }: { initial?: Partial<ContractDetail>; customerId?: string; onSubmit: (body: ContractPayload) => void; onCancel: () => void; submitting?: boolean; mode: 'create' | 'edit' }) {
  const { options, lookups } = useLookups();
  const engineers = useEngineers();
  const customers = useCustomersLookup();
  const can = useAuthStore((s) => s.can);
  const canCommercial = can('contracts:commercial') && (mode === 'create' || initial?.canViewCommercial !== false);
  const [f, setF] = useState({
    customerId: initial?.customerId ?? customerId ?? '',
    name: initial?.name ?? '',
    number: initial?.number ?? '',
    typeId: initial?.typeId ?? (options('contract_type').find((o) => o.isDefault)?.id ?? ''),
    startDate: initial?.startDate ?? new Date().toISOString().slice(0, 10),
    endDate: initial?.endDate ?? new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10),
    renewalDate: initial?.renewalDate ?? '',
    noticePeriodDays: initial?.noticePeriodDays != null ? String(initial.noticePeriodDays) : '',
    autoRenew: initial?.autoRenew ?? false,
    slaPolicyId: initial?.slaPolicyId ?? '',
    supportHoursCalendarId: initial?.supportHoursCalendarId ?? '',
    holidayCalendarId: initial?.holidayCalendarId ?? '',
    ownerUserId: initial?.ownerUserId ?? '',
    description: initial?.description ?? '',
    responseCommitment: initial?.responseCommitment ?? '',
    resolutionCommitment: initial?.resolutionCommitment ?? '',
    exclusions: initial?.exclusions ?? '',
    value: initial?.value != null ? String(initial.value) : '',
    currency: initial?.currency ?? 'INR',
    billingCycle: initial?.billingCycle ?? '',
    poNumber: initial?.poNumber ?? '',
    signedAt: initial?.signedAt ?? '',
    services: (initial?.services ?? []).map((s) => ({ serviceId: s.serviceId, slaPolicyId: s.slaPolicyId, teamId: s.teamId, supportHoursCalendarId: s.supportHoursCalendarId })) as ServiceCoverageInput[],
    siteIds: (initial?.sites ?? []).map((s) => s.id),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const [showCommitments, setShowCommitments] = useState(mode === 'edit');
  const holidayCalendars = useQuery({ queryKey: ['config', 'holiday-calendars'], queryFn: () => get<{ id: string; name: string }[]>('/config/holiday-calendars'), staleTime: 300_000 });

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: ContractPayload = {
      customerId: f.customerId,
      name: f.name.trim(),
      number: f.number.trim() || undefined,
      typeId: f.typeId || null,
      startDate: f.startDate,
      endDate: f.endDate,
      renewalDate: f.renewalDate || null,
      noticePeriodDays: num(f.noticePeriodDays),
      autoRenew: f.autoRenew,
      slaPolicyId: f.slaPolicyId || null,
      supportHoursCalendarId: f.supportHoursCalendarId || null,
      holidayCalendarId: f.holidayCalendarId || null,
      ownerUserId: f.ownerUserId || null,
      description: nz(f.description),
      responseCommitment: nz(f.responseCommitment),
      resolutionCommitment: nz(f.resolutionCommitment),
      exclusions: nz(f.exclusions),
    };
    if (canCommercial) Object.assign(body, { value: num(f.value), currency: nz(f.currency), billingCycle: nz(f.billingCycle), poNumber: nz(f.poNumber), signedAt: f.signedAt || null });
    if (mode === 'create') Object.assign(body, { services: f.services, siteIds: f.siteIds });
    onSubmit(body);
  }

  const dateError = f.endDate < f.startDate ? 'End date must be after the start date' : undefined;
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Customer" required className="sm:col-span-2">
          <Select value={f.customerId} onChange={(e) => { set('customerId', e.target.value); set('siteIds', []); }} disabled={mode === 'edit' || !!customerId} placeholder="Select customer" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} required />
        </Field>
        <Field label="Name" required>
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} required placeholder="AMC 2026-27" autoFocus={mode === 'create'} />
        </Field>
        <Field label="Number" hint={mode === 'create' ? 'Blank = CTR-YYYY-NNNN' : undefined}>
          <Input value={f.number} onChange={(e) => set('number', e.target.value)} placeholder="CTR-2026-0001" />
        </Field>
        <Field label="Type">
          <Select value={f.typeId} onChange={(e) => set('typeId', e.target.value)} placeholder="—" options={options('contract_type').map((o) => ({ value: o.id, label: o.label }))} />
        </Field>
        <Field label="Owner">
          <Select value={f.ownerUserId} onChange={(e) => set('ownerUserId', e.target.value)} placeholder="Unassigned" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />
        </Field>
        <Field label="Start date" required>
          <Input type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} required />
        </Field>
        <Field label="End date" required error={dateError}>
          <Input type="date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} required />
        </Field>
        <Field label="Renewal date">
          <Input type="date" value={f.renewalDate} onChange={(e) => set('renewalDate', e.target.value)} />
        </Field>
        <Field label="Notice period (days)">
          <Input type="number" min={0} value={f.noticePeriodDays} onChange={(e) => set('noticePeriodDays', e.target.value)} placeholder="60" />
        </Field>
        <Field label="SLA policy">
          <Select value={f.slaPolicyId} onChange={(e) => set('slaPolicyId', e.target.value)} placeholder="Platform default" options={(lookups?.slaPolicies ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        </Field>
        <Field label="Support hours">
          <Select value={f.supportHoursCalendarId} onChange={(e) => set('supportHoursCalendarId', e.target.value)} placeholder="Policy calendar" options={(lookups?.calendars ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <Field label="Holiday calendar">
          <Select value={f.holidayCalendarId} onChange={(e) => set('holidayCalendarId', e.target.value)} placeholder="—" options={(holidayCalendars.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox label="Auto-renew" checked={f.autoRenew} onChange={(e) => set('autoRenew', e.target.checked)} />
        </div>
      </div>

      {mode === 'create' && (
        <>
          <Field label="Covered services" hint="Per-service SLA policy, team and support hours override the contract defaults">
            <ServiceCoverageEditor value={f.services} onChange={(v) => set('services', v)} />
          </Field>
          <Field label="Covered sites">
            <SiteMultiSelect customerId={f.customerId || null} value={f.siteIds} onChange={(v) => set('siteIds', v)} />
          </Field>
        </>
      )}

      {canCommercial && (
        <Card title="Commercial" className="bg-surface-2/40">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field label="Contract value">
              <Input type="number" min={0} step="0.01" value={f.value} onChange={(e) => set('value', e.target.value)} />
            </Field>
            <Field label="Currency">
              <Input value={f.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={8} />
            </Field>
            <Field label="Billing cycle">
              <Select value={f.billingCycle} onChange={(e) => set('billingCycle', e.target.value)} placeholder="—" options={['monthly', 'quarterly', 'half_yearly', 'yearly', 'one_time'].map((v) => ({ value: v, label: v.replace('_', ' ') }))} />
            </Field>
            <Field label="PO number">
              <Input value={f.poNumber} onChange={(e) => set('poNumber', e.target.value)} />
            </Field>
            <Field label="Signed on">
              <Input type="date" value={f.signedAt} onChange={(e) => set('signedAt', e.target.value)} />
            </Field>
          </div>
        </Card>
      )}

      <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => setShowCommitments((v) => !v)}>
        {showCommitments ? 'Hide' : 'Show'} commitments, exclusions and description
      </button>
      {showCommitments && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Response commitment">
            <Textarea value={f.responseCommitment} onChange={(e) => set('responseCommitment', e.target.value)} rows={2} />
          </Field>
          <Field label="Resolution commitment">
            <Textarea value={f.resolutionCommitment} onChange={(e) => set('resolutionCommitment', e.target.value)} rows={2} />
          </Field>
          <Field label="Exclusions" className="sm:col-span-2">
            <Textarea value={f.exclusions} onChange={(e) => set('exclusions', e.target.value)} rows={2} />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea value={f.description} onChange={(e) => set('description', e.target.value)} rows={3} />
          </Field>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting} disabled={!f.name.trim() || !f.customerId || !!dateError}>
          {mode === 'create' ? 'Create contract' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
