import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { post, patch } from '@/api/client';
import { Button, Drawer, Field, Input, Select, Textarea } from '@/components/ui';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useSites, useContracts, errorMessage } from '@/components/cmdb/hooks';
import { ASSET_LIFECYCLE } from '@itsm/shared';

export interface AssetRecord {
  id: string;
  customerId: string;
  siteId?: string | null;
  tag: string;
  name: string;
  categoryId?: string | null;
  statusId?: string | null;
  lifecycleStage: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  partNumber?: string | null;
  description?: string | null;
  location?: string | null;
  rackPosition?: string | null;
  vendor?: string | null;
  purchaseDate?: string | null;
  purchaseCost?: number | string | null;
  currency?: string | null;
  poNumber?: string | null;
  invoiceNumber?: string | null;
  warrantyStart?: string | null;
  warrantyEnd?: string | null;
  warrantyProvider?: string | null;
  amcContractId?: string | null;
  amcStart?: string | null;
  amcEnd?: string | null;
  eolDate?: string | null;
  eosDate?: string | null;
  notes?: string | null;
  tags?: string[];
}

type FormState = Record<string, string>;
const FIELDS = ['siteId', 'tag', 'name', 'categoryId', 'statusId', 'lifecycleStage', 'manufacturer', 'model', 'serialNumber', 'partNumber', 'description', 'location', 'rackPosition', 'vendor', 'purchaseDate', 'purchaseCost', 'currency', 'poNumber', 'invoiceNumber', 'warrantyStart', 'warrantyEnd', 'warrantyProvider', 'amcContractId', 'amcStart', 'amcEnd', 'eolDate', 'eosDate', 'notes', 'tags'] as const;

function toForm(a?: AssetRecord | null): FormState {
  const f: FormState = { lifecycleStage: 'deployed', currency: 'INR' };
  if (!a) return f;
  for (const k of FIELDS) {
    const v = (a as unknown as Record<string, unknown>)[k];
    f[k] = Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v);
  }
  return f;
}

/** Create / edit asset drawer. */
export function AssetForm({ open, onClose, asset, defaultCustomerId, onSaved }: { open: boolean; onClose: () => void; asset?: AssetRecord | null; defaultCustomerId?: string; onSaved?: (asset: AssetRecord) => void }) {
  const qc = useQueryClient();
  const { options } = useLookups();
  const customers = useCustomersLookup();
  const [customerId, setCustomerId] = useState(asset?.customerId ?? defaultCustomerId ?? '');
  const [form, setForm] = useState<FormState>(toForm(asset));
  const sites = useSites(customerId);
  const contracts = useContracts(customerId);
  useEffect(() => {
    if (open) {
      setForm(toForm(asset));
      setCustomerId(asset?.customerId ?? defaultCustomerId ?? '');
    }
  }, [open, asset, defaultCustomerId]);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      for (const k of FIELDS) {
        const v = form[k] ?? '';
        if (k === 'tags') body.tags = v.split(',').map((s) => s.trim()).filter(Boolean);
        else if (k === 'purchaseCost') body.purchaseCost = v === '' ? null : Number(v);
        else if (k === 'tag') {
          if (v) body.tag = v;
        } else if (k === 'name') body.name = v;
        else if (k === 'lifecycleStage') body.lifecycleStage = v || 'deployed';
        else body[k] = v === '' ? null : v;
      }
      return asset ? patch<AssetRecord>(`/assets/${asset.id}`, body) : post<AssetRecord>('/assets', { ...body, customerId });
    },
    onSuccess: (a) => {
      toast.success(asset ? 'Asset updated' : `Asset ${a.tag} created`);
      qc.invalidateQueries({ queryKey: ['assets'] });
      onSaved?.(a);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const text = (k: string, label: string, props: Record<string, unknown> = {}) => (
    <Field label={label} key={k}>
      <Input value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...props} />
    </Field>
  );
  const date = (k: string, label: string) => (
    <Field label={label} key={k}>
      <Input type="date" value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mb-2 mt-2">{title}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
    </div>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={asset ? `Edit ${asset.tag}` : 'New asset'}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!form.name || !customerId}>{asset ? 'Save changes' : 'Create asset'}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Section title="Identity">
          <Field label="Customer" required>
            <Select value={customerId} disabled={!!asset} onChange={(e) => { setCustomerId(e.target.value); set('siteId', ''); set('amcContractId', ''); }} placeholder="Select customer…" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} />
          </Field>
          <Field label="Site">
            <Select value={form.siteId ?? ''} onChange={(e) => set('siteId', e.target.value)} placeholder="—" options={(sites.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))} />
          </Field>
          {text('tag', 'Asset tag', { placeholder: asset ? undefined : 'Auto-generated (AST-000123) if empty' })}
          <Field label="Name" required>
            <Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Category">
            <Select value={form.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value)} placeholder="—" options={options('asset_category').map((o) => ({ value: o.id, label: o.label }))} />
          </Field>
          <Field label="Status">
            <Select value={form.statusId ?? ''} onChange={(e) => set('statusId', e.target.value)} placeholder="Default" options={options('asset_status').map((o) => ({ value: o.id, label: o.label }))} />
          </Field>
          <Field label="Lifecycle stage">
            <Select value={form.lifecycleStage ?? 'deployed'} onChange={(e) => set('lifecycleStage', e.target.value)} options={ASSET_LIFECYCLE.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} />
          </Field>
          {text('manufacturer', 'Manufacturer')}
          {text('model', 'Model')}
          {text('serialNumber', 'Serial number')}
          {text('partNumber', 'Part number')}
          {text('location', 'Location')}
          {text('rackPosition', 'Rack / position')}
        </Section>
        <Section title="Commercial">
          {text('vendor', 'Vendor')}
          {date('purchaseDate', 'Purchase date')}
          {text('purchaseCost', 'Purchase cost', { type: 'number', min: 0, step: '0.01' })}
          {text('currency', 'Currency', { maxLength: 8 })}
          {text('poNumber', 'PO number')}
          {text('invoiceNumber', 'Invoice number')}
        </Section>
        <Section title="Coverage">
          {date('warrantyStart', 'Warranty start')}
          {date('warrantyEnd', 'Warranty end')}
          {text('warrantyProvider', 'Warranty provider')}
          <Field label="AMC contract">
            <Select value={form.amcContractId ?? ''} onChange={(e) => set('amcContractId', e.target.value)} placeholder="—" options={(contracts.data ?? []).map((c) => ({ value: c.id, label: `${c.number} · ${c.name}` }))} />
          </Field>
          {date('amcStart', 'AMC start')}
          {date('amcEnd', 'AMC end')}
          {date('eolDate', 'End of life')}
          {date('eosDate', 'End of support')}
        </Section>
        <Section title="Other">
          <Field label="Tags" hint="Comma separated" className="sm:col-span-2">
            <Input value={form.tags ?? ''} onChange={(e) => set('tags', e.target.value)} />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
          </Field>
        </Section>
      </div>
    </Drawer>
  );
}
