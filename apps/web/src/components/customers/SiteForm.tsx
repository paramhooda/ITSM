import { useState, type FormEvent } from 'react';
import { Button, Checkbox, Field, Input, Select, Textarea } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { ADDRESS_FIELDS, TIMEZONES, type Site } from './types';

export interface SitePayload {
  name: string;
  code?: string;
  typeId: string | null;
  address: Record<string, string>;
  timezone: string | null;
  phone: string | null;
  isPrimary: boolean;
  isActive?: boolean;
  notes: string | null;
}

export function SiteForm({ initial, onSubmit, onCancel, submitting }: { initial?: Partial<Site>; onSubmit: (body: SitePayload) => void; onCancel: () => void; submitting?: boolean }) {
  const { options, lookups } = useLookups();
  const [f, setF] = useState({
    name: initial?.name ?? '',
    code: initial?.code ?? '',
    typeId: initial?.typeId ?? (options('site_type').find((o) => o.isDefault)?.id ?? ''),
    address: { ...(initial?.address ?? {}) } as Record<string, string>,
    timezone: initial?.timezone ?? '',
    phone: initial?.phone ?? '',
    isPrimary: initial?.isPrimary ?? false,
    isActive: initial?.isActive ?? true,
    businessHoursCalendarId: initial?.businessHoursCalendarId ?? '',
    notes: initial?.notes ?? '',
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({
      name: f.name.trim(),
      code: f.code.trim() || undefined,
      typeId: f.typeId || null,
      address: Object.fromEntries(Object.entries(f.address).filter(([, v]) => v && v.trim())),
      timezone: f.timezone || null,
      phone: f.phone.trim() || null,
      isPrimary: f.isPrimary,
      isActive: f.isActive,
      notes: f.notes.trim() || null,
    });
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name" required className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} required autoFocus />
        </Field>
        <Field label="Code" hint="Unique per customer; generated from the name when blank">
          <Input value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} />
        </Field>
        <Field label="Type">
          <Select value={f.typeId} onChange={(e) => set('typeId', e.target.value)} placeholder="—" options={options('site_type').map((o) => ({ value: o.id, label: o.label }))} />
        </Field>
        <Field label="Timezone">
          <Select value={f.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="Customer default" options={[...new Set([f.timezone, ...TIMEZONES].filter(Boolean))].map((t) => ({ value: t, label: t }))} />
        </Field>
        <Field label="Phone">
          <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Business hours calendar" className="sm:col-span-2">
          <Select value={f.businessHoursCalendarId} onChange={(e) => set('businessHoursCalendarId', e.target.value)} placeholder="—" options={(lookups?.calendars ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {ADDRESS_FIELDS.map((a) => (
          <Field key={a.key} label={a.label} className={a.span === 2 ? 'sm:col-span-2' : undefined}>
            <Input value={f.address[a.key] ?? ''} onChange={(e) => set('address', { ...f.address, [a.key]: e.target.value })} />
          </Field>
        ))}
      </div>
      <div className="flex items-center gap-5">
        <Checkbox label="Primary site" checked={f.isPrimary} onChange={(e) => set('isPrimary', e.target.checked)} />
        {initial?.id && <Checkbox label="Active" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} />}
      </div>
      <Field label="Notes">
        <Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting} disabled={!f.name.trim()}>
          {initial?.id ? 'Save site' : 'Add site'}
        </Button>
      </div>
    </form>
  );
}
