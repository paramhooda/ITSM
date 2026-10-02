import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { post, patch } from '@/api/client';
import { Button, Drawer, Field, Input, Select, Textarea } from '@/components/ui';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { AttributeFields } from './AttributeFields';
import { CI_STATUSES, CRITICALITIES, ENVIRONMENTS } from './CiTypeBadge';
import { useSites, errorMessage } from './hooks';

export interface CiRecord {
  id: string;
  customerId: string;
  siteId?: string | null;
  typeId: string;
  name: string;
  hostname?: string | null;
  fqdn?: string | null;
  ipAddress?: string | null;
  macAddress?: string | null;
  serialNumber?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  firmwareVersion?: string | null;
  environment: string;
  criticality: string;
  status: string;
  description?: string | null;
  ownerTeamId?: string | null;
  monitoringRef?: string | null;
  siemRef?: string | null;
  attributes: Record<string, unknown>;
  tags?: string[];
}

const TEXT_FIELDS = ['name', 'hostname', 'fqdn', 'ipAddress', 'macAddress', 'serialNumber', 'manufacturer', 'model', 'osName', 'osVersion', 'firmwareVersion', 'description', 'monitoringRef', 'siemRef'] as const;

function toForm(ci?: CiRecord | null): Record<string, string> {
  const f: Record<string, string> = { environment: 'production', criticality: 'medium', status: 'active' };
  if (!ci) return f;
  for (const k of [...TEXT_FIELDS, 'siteId', 'typeId', 'environment', 'criticality', 'status', 'ownerTeamId'] as const) {
    const v = (ci as unknown as Record<string, unknown>)[k];
    f[k] = v === null || v === undefined ? '' : String(v);
  }
  f.tags = (ci.tags ?? []).join(', ');
  return f;
}

/** Create / edit CI drawer with dynamic attributes from the selected type's schema. */
export function CiForm({ open, onClose, ci, defaultCustomerId, onSaved }: { open: boolean; onClose: () => void; ci?: CiRecord | null; defaultCustomerId?: string; onSaved?: (ci: CiRecord) => void }) {
  const qc = useQueryClient();
  const { lookups } = useLookups();
  const customers = useCustomersLookup();
  const [customerId, setCustomerId] = useState(ci?.customerId ?? defaultCustomerId ?? '');
  const [form, setForm] = useState(toForm(ci));
  const [attributes, setAttributes] = useState<Record<string, unknown>>(ci?.attributes ?? {});
  const sites = useSites(customerId);
  useEffect(() => {
    if (open) {
      setForm(toForm(ci));
      setAttributes(ci?.attributes ?? {});
      setCustomerId(ci?.customerId ?? defaultCustomerId ?? '');
    }
  }, [open, ci, defaultCustomerId]);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const type = useMemo(() => lookups?.ciTypes.find((t) => t.id === form.typeId), [lookups, form.typeId]);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { typeId: form.typeId, environment: form.environment, criticality: form.criticality, status: form.status, attributes };
      for (const k of TEXT_FIELDS) body[k] = k === 'name' ? form.name : form[k] ? form[k] : null;
      body.siteId = form.siteId || null;
      body.ownerTeamId = form.ownerTeamId || null;
      body.tags = (form.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      return ci ? patch<CiRecord>(`/cmdb/cis/${ci.id}`, body) : post<CiRecord>('/cmdb/cis', { ...body, customerId });
    },
    onSuccess: (r) => {
      toast.success(ci ? 'CI updated' : 'CI created');
      qc.invalidateQueries({ queryKey: ['cmdb'] });
      onSaved?.(r);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const text = (k: string, label: string, props: Record<string, unknown> = {}) => (
    <Field label={label} key={k}>
      <Input value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...props} />
    </Field>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={ci ? `Edit ${ci.name}` : 'New configuration item'}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!form.name || !form.typeId || !customerId}>{ci ? 'Save changes' : 'Create CI'}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Customer" required>
            <Select value={customerId} disabled={!!ci} onChange={(e) => { setCustomerId(e.target.value); set('siteId', ''); }} placeholder="Select customer…" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} />
          </Field>
          <Field label="Site">
            <Select value={form.siteId ?? ''} onChange={(e) => set('siteId', e.target.value)} placeholder="—" options={(sites.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))} />
          </Field>
          <Field label="Type" required>
            <Select value={form.typeId ?? ''} onChange={(e) => set('typeId', e.target.value)} placeholder="Select type…" options={(lookups?.ciTypes ?? []).map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
          <Field label="Name" required>
            <Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} />
          </Field>
          {text('hostname', 'Hostname')}
          {text('fqdn', 'FQDN')}
          {text('ipAddress', 'IP address')}
          {text('macAddress', 'MAC address')}
          {text('serialNumber', 'Serial number')}
          {text('manufacturer', 'Manufacturer')}
          {text('model', 'Model')}
          {text('osName', 'OS')}
          {text('osVersion', 'OS version')}
          {text('firmwareVersion', 'Firmware')}
          <Field label="Environment">
            <Select value={form.environment} onChange={(e) => set('environment', e.target.value)} options={ENVIRONMENTS.map((v) => ({ value: v, label: v }))} />
          </Field>
          <Field label="Criticality">
            <Select value={form.criticality} onChange={(e) => set('criticality', e.target.value)} options={CRITICALITIES.map((v) => ({ value: v, label: v }))} />
          </Field>
          <Field label="Status">
            <Select value={form.status} onChange={(e) => set('status', e.target.value)} options={CI_STATUSES.map((v) => ({ value: v, label: v }))} />
          </Field>
          <Field label="Owner team">
            <Select value={form.ownerTeamId ?? ''} onChange={(e) => set('ownerTeamId', e.target.value)} placeholder="—" options={(lookups?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
          {text('monitoringRef', 'Monitoring reference', { placeholder: 'PRTG device id / sensor' })}
          {text('siemRef', 'SIEM reference')}
          <Field label="Tags" hint="Comma separated" className="sm:col-span-2">
            <Input value={form.tags ?? ''} onChange={(e) => set('tags', e.target.value)} />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} />
          </Field>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mb-2 mt-2">{type ? `${type.name} attributes` : 'Attributes'}</div>
          {type ? <AttributeFields schema={type.attributeSchema as never} value={attributes} onChange={setAttributes} /> : <div className="text-[13px] text-subtle">Select a type to see its attributes.</div>}
        </div>
      </div>
    </Drawer>
  );
}
