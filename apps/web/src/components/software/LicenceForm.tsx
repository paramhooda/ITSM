import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LICENCE_METRICS, LICENCE_TERMS } from '@itsm/shared';
import { Button, Dialog, Field, Input, Select, Textarea, Checkbox } from '@/components/ui';
import { useCustomersLookup, useEngineers } from '@/hooks/useLookups';
import { useContracts, errorMessage } from '@/components/cmdb/hooks';
import { fmtDate } from '@/lib/format';
import { softwareApi, softwareKeys, LICENCE_METRIC_LABELS, LICENCE_TERM_LABELS, titleOf, shiftDate, todayIso, type SoftwareLicenceDetail, type SoftwareLicence } from './api';

export type LicenceFormMode = 'create' | 'edit' | 'renew';
type FormState = Record<string, string>;
const FIELDS = ['productId', 'contractId', 'name', 'metric', 'term', 'quantity', 'startDate', 'endDate', 'renewalDate', 'cost', 'currency', 'vendor', 'poNumber', 'invoiceNumber', 'licenceKey', 'ownerUserId', 'notes'] as const;

/** The metric and term a title's licence model implies (mirrors the API defaults). */
const defaultMetric = (model?: string | null) => (model === 'subscription' ? 'per_user' : model === 'perpetual' ? 'per_device' : model && LICENCE_METRICS.includes(model as never) ? model : 'per_device');
const defaultTerm = (model?: string | null) => (model === 'subscription' ? 'subscription' : 'perpetual');

function toForm(l?: Partial<SoftwareLicence> | null): FormState {
  const f: FormState = { metric: 'per_device', term: 'perpetual', currency: 'INR', autoRenew: 'false' };
  if (!l) return f;
  for (const k of FIELDS) {
    const v = (l as Record<string, unknown>)[k];
    f[k] = v === null || v === undefined ? '' : String(v);
  }
  f.autoRenew = l.autoRenew ? 'true' : 'false';
  return f;
}

/** The next term prefilled from the licence being renewed: starts the day after it ends (today when it never ends), one year long. */
function renewalForm(l: SoftwareLicenceDetail): FormState {
  const start = l.endDate ? shiftDate(l.endDate, 1) : todayIso();
  return { ...toForm(l), startDate: start, endDate: shiftDate(start, 365), renewalDate: '', poNumber: '', invoiceNumber: '', licenceKey: '', notes: '' };
}

/**
 * Create or edit a licence, or record its renewal. In renew mode only the term,
 * seats, cost and name are asked; contract, owner, vendor and currency carry over
 * and the paperwork fields start empty for the new term.
 */
export function LicenceForm({ open, onClose, mode = 'create', licence, defaultCustomerId, defaultProductId, onSaved }: { open: boolean; onClose: () => void; mode?: LicenceFormMode; licence?: SoftwareLicenceDetail | null; defaultCustomerId?: string; defaultProductId?: string; onSaved?: (l: SoftwareLicenceDetail) => void }) {
  const qc = useQueryClient();
  const customers = useCustomersLookup();
  const engineers = useEngineers();
  const [customerId, setCustomerId] = useState(licence?.customerId ?? defaultCustomerId ?? '');
  const [form, setForm] = useState<FormState>(() => (mode === 'renew' && licence ? renewalForm(licence) : toForm(licence)));
  const contracts = useContracts(customerId);
  const products = useQuery({ queryKey: softwareKeys.products({ fields: 'min', pageSize: 500 }), queryFn: () => softwareApi.productsMin({ pageSize: 500, sort: 'publisher' }), enabled: open, staleTime: 60_000 });
  useEffect(() => {
    if (!open) return;
    setCustomerId(licence?.customerId ?? defaultCustomerId ?? '');
    if (mode === 'renew' && licence) setForm(renewalForm(licence));
    else setForm({ ...toForm(licence), ...(!licence && defaultProductId ? { productId: defaultProductId } : {}) });
  }, [open, mode, licence, defaultCustomerId, defaultProductId]);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const pickProduct = (id: string) => {
    const p = products.data?.items.find((x) => x.id === id);
    setForm((f) => ({ ...f, productId: id, metric: p && !licence ? defaultMetric(p.licenceModel) : f.metric, term: p && !licence ? defaultTerm(p.licenceModel) : f.term }));
  };
  // When a title is preselected (from the title record), apply its defaults once the catalogue arrives.
  useEffect(() => {
    if (open && !licence && defaultProductId && products.data) pickProduct(defaultProductId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, products.data]);

  const isSite = form.metric === 'site';
  const datesOk = !form.startDate || !form.endDate || form.endDate >= form.startDate;
  const valid = !!customerId && !!form.productId && !!form.name?.trim() && (isSite || Number(form.quantity) > 0) && datesOk;

  const save = useMutation({
    mutationFn: () => {
      const num = (v: string) => (v === '' || v === undefined ? null : Number(v));
      if (mode === 'renew' && licence) {
        return softwareApi.renewLicence(licence.id, { name: form.name?.trim() || undefined, quantity: form.quantity ? Number(form.quantity) : undefined, startDate: form.startDate || undefined, endDate: form.endDate || undefined, renewalDate: form.renewalDate || null, cost: num(form.cost) });
      }
      const body: Record<string, unknown> = {
        productId: form.productId,
        contractId: form.contractId || null,
        name: form.name.trim(),
        metric: form.metric,
        term: form.term,
        quantity: isSite ? 0 : Number(form.quantity),
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        renewalDate: form.renewalDate || null,
        autoRenew: form.autoRenew === 'true',
        cost: num(form.cost),
        currency: form.currency?.trim() || null,
        vendor: form.vendor?.trim() || null,
        poNumber: form.poNumber?.trim() || null,
        invoiceNumber: form.invoiceNumber?.trim() || null,
        licenceKey: form.licenceKey?.trim() || null,
        ownerUserId: form.ownerUserId || null,
        notes: form.notes?.trim() || null,
      };
      return licence && mode === 'edit' ? softwareApi.updateLicence(licence.id, body) : softwareApi.createLicence({ ...body, customerId });
    },
    onSuccess: (l) => {
      toast.success(mode === 'renew' ? `Renewal recorded: ${l.name}` : mode === 'edit' ? 'Licence updated' : `Licence ${l.name} created`);
      qc.invalidateQueries({ queryKey: softwareKeys.all });
      qc.invalidateQueries({ queryKey: ['overview', 'software'] });
      onSaved?.(l);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const title = mode === 'renew' && licence ? `Renew ${licence.name}` : mode === 'edit' && licence ? `Edit ${licence.name}` : 'New licence';
  const productOptions = (products.data?.items ?? []).filter((p) => p.isActive || p.id === form.productId).map((p) => ({ value: p.id, label: titleOf(p) }));
  const quantityField = (
    <Field label={isSite ? 'Seats (site licence)' : 'Seats'} required={!isSite} hint={isSite ? 'A site licence is unlimited.' : form.metric === 'per_core' ? 'Licensed cores' : form.metric === 'per_user' ? 'Named users' : 'Devices'}>
      <Input type="number" min={0} step="1" value={isSite ? '' : form.quantity ?? ''} disabled={isSite} onChange={(e) => set('quantity', e.target.value)} />
    </Field>
  );

  return (
    <Dialog open={open} onClose={onClose} title={title} width="max-w-2xl" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>{mode === 'renew' ? 'Record renewal' : mode === 'edit' ? 'Save changes' : 'Create licence'}</Button></>}>
      {mode === 'renew' && licence ? (
        <div className="flex flex-col gap-3">
          <div className="text-[13px] text-muted">
            {titleOf(licence)} for {licence.customerName ?? 'the customer'} · {licence.quantity} seats{licence.endDate ? `, current term ends ${fmtDate(licence.endDate)}` : ''}. The current licence stays in force until its own end date; the new term is recorded as a separate licence linked to this one. Contract, owner, vendor and currency carry over; purchase order, invoice and key start empty.
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Licence name" required className="sm:col-span-2"><Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
            {quantityField}
            <Field label="Cost"><Input type="number" min={0} step="0.01" value={form.cost ?? ''} onChange={(e) => set('cost', e.target.value)} /></Field>
            <Field label="Term starts" required><Input type="date" value={form.startDate ?? ''} onChange={(e) => set('startDate', e.target.value)} /></Field>
            <Field label="Term ends" required error={datesOk ? undefined : 'The licence must end after it starts'}><Input type="date" value={form.endDate ?? ''} onChange={(e) => set('endDate', e.target.value)} /></Field>
            <Field label="Renewal date" hint="When the next renewal decision is due."><Input type="date" value={form.renewalDate ?? ''} onChange={(e) => set('renewalDate', e.target.value)} /></Field>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Customer" required>
            <Select value={customerId} disabled={!!licence} onChange={(e) => { setCustomerId(e.target.value); set('contractId', ''); }} placeholder="Select customer…" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} />
          </Field>
          <Field label="Title" required>
            <Select value={form.productId ?? ''} onChange={(e) => pickProduct(e.target.value)} placeholder="Select title…" options={productOptions} />
          </Field>
          <Field label="Licence name" required className="sm:col-span-2"><Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="Microsoft 365 E3 annual (250)" /></Field>
          <Field label="Metric"><Select value={form.metric ?? 'per_device'} onChange={(e) => set('metric', e.target.value)} options={LICENCE_METRICS.map((m) => ({ value: m, label: LICENCE_METRIC_LABELS[m] ?? m }))} /></Field>
          <Field label="Term"><Select value={form.term ?? 'perpetual'} onChange={(e) => set('term', e.target.value)} options={LICENCE_TERMS.map((t) => ({ value: t, label: LICENCE_TERM_LABELS[t] ?? t }))} /></Field>
          {quantityField}
          <Field label="Contract" hint={customerId ? undefined : 'Choose a customer first'}>
            <Select value={form.contractId ?? ''} disabled={!customerId} onChange={(e) => set('contractId', e.target.value)} placeholder="—" options={(contracts.data ?? []).map((c) => ({ value: c.id, label: `${c.number} · ${c.name}` }))} />
          </Field>
          <Field label="Term starts"><Input type="date" value={form.startDate ?? ''} onChange={(e) => set('startDate', e.target.value)} /></Field>
          <Field label="Term ends" hint="Leave empty for a perpetual licence." error={datesOk ? undefined : 'The licence must end after it starts'}><Input type="date" value={form.endDate ?? ''} onChange={(e) => set('endDate', e.target.value)} /></Field>
          <Field label="Renewal date"><Input type="date" value={form.renewalDate ?? ''} onChange={(e) => set('renewalDate', e.target.value)} /></Field>
          <div className="flex items-end pb-2"><Checkbox label="Renews automatically" checked={form.autoRenew === 'true'} onChange={(e) => set('autoRenew', e.target.checked ? 'true' : 'false')} /></div>
          <Field label="Cost"><Input type="number" min={0} step="0.01" value={form.cost ?? ''} onChange={(e) => set('cost', e.target.value)} /></Field>
          <Field label="Currency"><Input value={form.currency ?? ''} onChange={(e) => set('currency', e.target.value)} maxLength={8} /></Field>
          <Field label="Vendor"><Input value={form.vendor ?? ''} onChange={(e) => set('vendor', e.target.value)} /></Field>
          <Field label="Owner"><Select value={form.ownerUserId ?? ''} onChange={(e) => set('ownerUserId', e.target.value)} placeholder="—" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} /></Field>
          <Field label="PO number"><Input value={form.poNumber ?? ''} onChange={(e) => set('poNumber', e.target.value)} /></Field>
          <Field label="Invoice number"><Input value={form.invoiceNumber ?? ''} onChange={(e) => set('invoiceNumber', e.target.value)} /></Field>
          <Field label="Licence key" className="sm:col-span-2"><Input value={form.licenceKey ?? ''} onChange={(e) => set('licenceKey', e.target.value)} /></Field>
          <Field label="Notes" className="sm:col-span-2"><Textarea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
        </div>
      )}
    </Dialog>
  );
}
