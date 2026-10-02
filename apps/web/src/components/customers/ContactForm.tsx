import { useState, type FormEvent } from 'react';
import { Button, Checkbox, Field, Input, Select, Textarea } from '@/components/ui';
import type { Contact, Site } from './types';

export interface ContactPayload {
  name: string;
  siteId: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  title: string | null;
  department: string | null;
  isPrimary: boolean;
  isEscalation: boolean;
  escalationLevel: number | null;
  notes: string | null;
  isActive?: boolean;
}

export function ContactForm({ initial, sites, onSubmit, onCancel, submitting }: { initial?: Partial<Contact>; sites: Pick<Site, 'id' | 'name' | 'code'>[]; onSubmit: (body: ContactPayload) => void; onCancel: () => void; submitting?: boolean }) {
  const [f, setF] = useState({
    name: initial?.name ?? '',
    siteId: initial?.siteId ?? '',
    email: initial?.email ?? '',
    phone: initial?.phone ?? '',
    mobile: initial?.mobile ?? '',
    title: initial?.title ?? '',
    department: initial?.department ?? '',
    isPrimary: initial?.isPrimary ?? false,
    isEscalation: initial?.isEscalation ?? false,
    escalationLevel: initial?.escalationLevel ? String(initial.escalationLevel) : '1',
    notes: initial?.notes ?? '',
    isActive: initial?.isActive ?? true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const nz = (s: string) => (s.trim() === '' ? null : s.trim());
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({
      name: f.name.trim(),
      siteId: f.siteId || null,
      email: nz(f.email),
      phone: nz(f.phone),
      mobile: nz(f.mobile),
      title: nz(f.title),
      department: nz(f.department),
      isPrimary: f.isPrimary,
      isEscalation: f.isEscalation,
      escalationLevel: f.isEscalation ? Number(f.escalationLevel) || 1 : null,
      notes: nz(f.notes),
      isActive: f.isActive,
    });
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name" required className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} required autoFocus />
        </Field>
        <Field label="Email">
          <Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Site">
          <Select value={f.siteId} onChange={(e) => set('siteId', e.target.value)} placeholder="Any site" options={sites.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }))} />
        </Field>
        <Field label="Phone">
          <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Mobile">
          <Input value={f.mobile} onChange={(e) => set('mobile', e.target.value)} />
        </Field>
        <Field label="Title">
          <Input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="IT Manager" />
        </Field>
        <Field label="Department">
          <Input value={f.department} onChange={(e) => set('department', e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-5">
        <Checkbox label="Primary contact" checked={f.isPrimary} onChange={(e) => set('isPrimary', e.target.checked)} />
        <Checkbox label="Escalation contact" checked={f.isEscalation} onChange={(e) => set('isEscalation', e.target.checked)} />
        {f.isEscalation && (
          <label className="inline-flex items-center gap-2 text-[13px]">
            Level
            <Input type="number" min={1} max={20} value={f.escalationLevel} onChange={(e) => set('escalationLevel', e.target.value)} className="w-20" />
          </label>
        )}
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
          {initial?.id ? 'Save contact' : 'Add contact'}
        </Button>
      </div>
    </form>
  );
}
