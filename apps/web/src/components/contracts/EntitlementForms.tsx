import { useState, type FormEvent } from 'react';
import { Button, Checkbox, Field, Input, Select, Textarea } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { ENTITLEMENT_PERIODS, ENTITLEMENT_UNITS } from '@itsm/shared';
import { PERIOD_LABELS } from './ContractBits';
import type { Entitlement } from './types';

export interface EntitlementPayload {
  typeId: string | null;
  name: string;
  serviceId: string | null;
  quantity: number;
  unit: string;
  period: string;
  warnThresholdPct: number;
  overageAllowed: boolean;
  overageRate: number | null;
  notes: string | null;
}

export function EntitlementForm({ initial, contractServiceIds, onSubmit, onCancel, submitting }: { initial?: Partial<Entitlement>; contractServiceIds?: string[]; onSubmit: (body: EntitlementPayload) => void; onCancel: () => void; submitting?: boolean }) {
  const { options, lookups } = useLookups();
  const types = options('entitlement_type');
  const [f, setF] = useState({
    typeId: initial?.typeId ?? '',
    name: initial?.name ?? '',
    serviceId: initial?.serviceId ?? '',
    quantity: initial?.quantity != null ? String(initial.quantity) : '',
    unit: initial?.unit ?? 'count',
    period: initial?.period ?? 'contract',
    warnThresholdPct: String(initial?.warnThresholdPct ?? Number(lookups?.settings?.['entitlements.default_warn_pct'] ?? 80)),
    overageAllowed: initial?.overageAllowed ?? true,
    overageRate: initial?.overageRate != null ? String(initial.overageRate) : '',
    notes: initial?.notes ?? '',
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const pickType = (id: string) => {
    const t = types.find((o) => o.id === id);
    const unit = typeof t?.metadata?.unit === 'string' ? (t.metadata.unit as string) : f.unit;
    setF((s) => ({ ...s, typeId: id, unit, name: s.name || t?.label || '' }));
  };
  const services = (lookups?.services ?? []).filter((s) => !contractServiceIds?.length || contractServiceIds.includes(s.id));
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({
      typeId: f.typeId || null,
      name: f.name.trim(),
      serviceId: f.serviceId || null,
      quantity: Number(f.quantity),
      unit: f.unit || 'count',
      period: f.period,
      warnThresholdPct: Math.min(100, Math.max(1, Number(f.warnThresholdPct) || 80)),
      overageAllowed: f.overageAllowed,
      overageRate: f.overageRate.trim() === '' ? null : Number(f.overageRate),
      notes: f.notes.trim() || null,
    });
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Type">
          <Select value={f.typeId} onChange={(e) => pickType(e.target.value)} placeholder="—" options={types.map((o) => ({ value: o.id, label: o.label }))} />
        </Field>
        <Field label="Name" required>
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} required placeholder="e.g. Quarterly site visits" />
        </Field>
        <Field label="Service" hint="Optional: restrict to one covered service">
          <Select value={f.serviceId} onChange={(e) => set('serviceId', e.target.value)} placeholder="Any service" options={services.map((s) => ({ value: s.id, label: s.name }))} />
        </Field>
        <Field label="Period">
          <Select value={f.period} onChange={(e) => set('period', e.target.value)} options={ENTITLEMENT_PERIODS.map((p) => ({ value: p, label: PERIOD_LABELS[p] ?? p }))} />
        </Field>
        <Field label="Quantity" required>
          <Input type="number" min={0} step="0.01" value={f.quantity} onChange={(e) => set('quantity', e.target.value)} required />
        </Field>
        <Field label="Unit">
          <Select value={f.unit} onChange={(e) => set('unit', e.target.value)} options={[...new Set([f.unit, ...ENTITLEMENT_UNITS])].map((u) => ({ value: u, label: u }))} />
        </Field>
        <Field label="Warn at (%)">
          <Input type="number" min={1} max={100} value={f.warnThresholdPct} onChange={(e) => set('warnThresholdPct', e.target.value)} />
        </Field>
        <Field label="Overage rate" hint="Per unit beyond the quantity">
          <Input type="number" min={0} step="0.01" value={f.overageRate} onChange={(e) => set('overageRate', e.target.value)} disabled={!f.overageAllowed} />
        </Field>
      </div>
      <Checkbox label="Allow consumption beyond the quantity (overage)" checked={f.overageAllowed} onChange={(e) => set('overageAllowed', e.target.checked)} />
      <Field label="Notes">
        <Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting} disabled={!f.name.trim() || f.quantity === ''}>
          {initial?.id ? 'Save entitlement' : 'Add entitlement'}
        </Button>
      </div>
    </form>
  );
}

export interface ConsumptionPayload {
  quantity: number;
  consumedAt?: string;
  notes: string | null;
}

export function ConsumptionForm({ entitlement, onSubmit, onCancel, submitting }: { entitlement: Entitlement; onSubmit: (body: ConsumptionPayload) => void; onCancel: () => void; submitting?: boolean }) {
  const [quantity, setQuantity] = useState('1');
  const [consumedAt, setConsumedAt] = useState(new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  const [notes, setNotes] = useState('');
  const u = entitlement.utilization;
  const after = u.used + (Number(quantity) || 0);
  const exceeds = after > u.quantity;
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({ quantity: Number(quantity), consumedAt: consumedAt ? new Date(consumedAt).toISOString() : undefined, notes: notes.trim() || null });
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="text-[13px] text-muted">
        <span className="font-medium text-default">{entitlement.name}</span> · {u.used} of {u.quantity} {entitlement.unit} used this period ({u.remaining} remaining)
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Quantity (${entitlement.unit})`} required error={exceeds && !entitlement.overageAllowed ? 'Exceeds the entitlement; overage is not allowed' : undefined} hint={exceeds && entitlement.overageAllowed ? 'This will record overage' : undefined}>
          <Input type="number" min={0.01} step="0.01" value={quantity} onChange={(e) => setQuantity(e.target.value)} required autoFocus />
        </Field>
        <Field label="Consumed at">
          <Input type="datetime-local" value={consumedAt} onChange={(e) => setConsumedAt(e.target.value)} />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Reason, visit reference…" />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting} disabled={!(Number(quantity) > 0) || (exceeds && !entitlement.overageAllowed)}>
          Record consumption
        </Button>
      </div>
    </form>
  );
}
