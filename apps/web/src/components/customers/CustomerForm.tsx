import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useLookups, useEngineers } from '@/hooks/useLookups';
import { ADDRESS_FIELDS, TIMEZONES, type CustomerDetail } from './types';

export interface CustomerPayload {
  name: string;
  code?: string;
  legalName: string | null;
  typeId: string | null;
  industryId: string | null;
  statusId: string | null;
  accountManagerId: string | null;
  timezone: string;
  website: string | null;
  phone: string | null;
  email: string | null;
  address: Record<string, string>;
  tags: string[];
  notes: string | null;
}

const nz = (s: string) => (s.trim() === '' ? null : s.trim());

export function CustomerForm({ initial, onSubmit, onCancel, submitting, mode }: { initial?: Partial<CustomerDetail>; onSubmit: (body: CustomerPayload) => void; onCancel: () => void; submitting?: boolean; mode: 'create' | 'edit' }) {
  const { options } = useLookups();
  const engineers = useEngineers();
  const [f, setF] = useState({
    name: initial?.name ?? '',
    code: initial?.code ?? '',
    legalName: initial?.legalName ?? '',
    typeId: initial?.typeId ?? (options('customer_type').find((o) => o.isDefault)?.id ?? ''),
    industryId: initial?.industryId ?? '',
    statusId: initial?.statusId ?? (options('customer_status').find((o) => o.isDefault)?.id ?? ''),
    accountManagerId: initial?.accountManagerId ?? '',
    timezone: initial?.timezone ?? 'Asia/Kolkata',
    website: initial?.website ?? '',
    phone: initial?.phone ?? '',
    email: initial?.email ?? '',
    address: { ...(initial?.address ?? {}) } as Record<string, string>,
    tags: (initial?.tags ?? []).join(', '),
    notes: initial?.notes ?? '',
  });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const setAddr = (k: string, v: string) => setF((s) => ({ ...s, address: { ...s.address, [k]: v } }));

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({
      name: f.name.trim(),
      code: f.code.trim() || undefined,
      legalName: nz(f.legalName),
      typeId: f.typeId || null,
      industryId: f.industryId || null,
      statusId: f.statusId || null,
      accountManagerId: f.accountManagerId || null,
      timezone: f.timezone,
      website: nz(f.website),
      phone: nz(f.phone),
      email: nz(f.email),
      address: Object.fromEntries(Object.entries(f.address).filter(([, v]) => v && v.trim())),
      tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
      notes: nz(f.notes),
    });
  }

  const opt = (type: string) => options(type).map((o) => ({ value: o.id, label: o.label }));
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name" required className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} required autoFocus placeholder="Customer name" />
        </Field>
        <Field label="Code" hint={mode === 'create' ? 'Leave blank to generate CUST-NNNN' : undefined}>
          <Input value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="CUST-0001" />
        </Field>
        <Field label="Legal name">
          <Input value={f.legalName} onChange={(e) => set('legalName', e.target.value)} />
        </Field>
        <Field label="Type">
          <Select value={f.typeId} onChange={(e) => set('typeId', e.target.value)} placeholder="—" options={opt('customer_type')} />
        </Field>
        <Field label="Industry">
          <Select value={f.industryId} onChange={(e) => set('industryId', e.target.value)} placeholder="—" options={opt('customer_industry')} />
        </Field>
        <Field label="Status">
          <Select value={f.statusId} onChange={(e) => set('statusId', e.target.value)} placeholder="—" options={opt('customer_status')} />
        </Field>
        <Field label="Account manager">
          <Select value={f.accountManagerId} onChange={(e) => set('accountManagerId', e.target.value)} placeholder="Unassigned" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />
        </Field>
        <Field label="Timezone">
          <Select value={f.timezone} onChange={(e) => set('timezone', e.target.value)} options={[...new Set([f.timezone, ...TIMEZONES])].map((t) => ({ value: t, label: t }))} />
        </Field>
        <Field label="Website">
          <Input value={f.website} onChange={(e) => set('website', e.target.value)} placeholder="https://" />
        </Field>
        <Field label="Phone">
          <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
      </div>
      <div>
        <div className="text-[12px] font-semibold text-muted uppercase tracking-wide mb-2">Address</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {ADDRESS_FIELDS.map((a) => (
            <Field key={a.key} label={a.label} className={a.span === 2 ? 'sm:col-span-2' : undefined}>
              <Input value={f.address[a.key] ?? ''} onChange={(e) => setAddr(a.key, e.target.value)} />
            </Field>
          ))}
        </div>
      </div>
      <Field label="Tags" hint="Comma separated">
        <Input value={f.tags} onChange={(e) => set('tags', e.target.value)} placeholder="strategic, amc" />
      </Field>
      <Field label="Notes">
        <Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={3} />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting} disabled={!f.name.trim()}>
          {mode === 'create' ? 'Create customer' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
