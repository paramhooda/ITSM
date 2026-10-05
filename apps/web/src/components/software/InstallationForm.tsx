import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { INSTALL_SOURCES } from '@itsm/shared';
import { get } from '@/api/client';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import { useCustomersLookup } from '@/hooks/useLookups';
import { CiPicker, type CiMin } from '@/components/cmdb/CiPicker';
import { errorMessage } from '@/components/cmdb/hooks';
import { softwareApi, softwareKeys, SOURCE_LABELS, titleOf, type SoftwareInstallation } from './api';

type FormState = Record<string, string>;
const FIELDS = ['productId', 'hostName', 'assignedUser', 'version', 'edition', 'cores', 'installPath', 'installedAt', 'source', 'notes'] as const;

function toForm(i?: SoftwareInstallation | null): FormState {
  const f: FormState = { source: 'manual' };
  if (!i) return f;
  for (const k of FIELDS) {
    const v = (i as unknown as Record<string, unknown>)[k];
    f[k] = v === null || v === undefined ? '' : String(v);
  }
  return f;
}

/** Picks one of the customer's assets by tag, name or serial (the asset list's `fields=min` projection). */
function AssetPicker({ customerId, value, onChange }: { customerId: string; value: { id: string; tag: string } | null; onChange: (a: { id: string; tag: string } | null) => void }) {
  const [q, setQ] = useState('');
  const search = useQuery({ queryKey: ['assets', 'picker', 'software', customerId, q], queryFn: () => get<{ items: { id: string; tag: string; name: string; serialNumber?: string | null }[] }>('/assets', { fields: 'min', customerId, q: q || undefined, pageSize: 10 }), enabled: !!customerId && q.length >= 2 });
  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 input">
        <span className="font-mono text-[12.5px]">{value.tag}</span>
        <button type="button" className="text-[12px] text-muted hover:text-default" onClick={() => onChange(null)}>Clear</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={customerId ? 'Search tag, name or serial…' : 'Choose a customer first'} disabled={!customerId} />
      {q.length >= 2 && search.data && (
        <div className="absolute z-10 mt-1 w-full card max-h-56 overflow-y-auto">
          {search.data.items.map((a) => (
            <button key={a.id} type="button" className="w-full text-left px-2 py-1.5 text-[13px] hover:bg-surface-2" onClick={() => { onChange({ id: a.id, tag: a.tag }); setQ(''); }}>
              <span className="font-mono text-xs mr-2">{a.tag}</span>{a.name}{a.serialNumber && <span className="text-subtle text-xs ml-2">{a.serialNumber}</span>}
            </button>
          ))}
          {!search.data.items.length && <div className="px-2 py-2 text-[12.5px] text-subtle">No assets match.</div>}
        </div>
      )}
    </div>
  );
}

/** Record or edit one installation: the title, the host (CI, asset, host name) or the user it is for. */
export function InstallationForm({ open, onClose, installation, defaultCustomerId, defaultProductId, onSaved }: { open: boolean; onClose: () => void; installation?: SoftwareInstallation | null; defaultCustomerId?: string; defaultProductId?: string; onSaved?: (i: SoftwareInstallation) => void }) {
  const qc = useQueryClient();
  const customers = useCustomersLookup();
  const [customerId, setCustomerId] = useState(installation?.customerId ?? defaultCustomerId ?? '');
  const [form, setForm] = useState<FormState>(toForm(installation));
  const [ci, setCi] = useState<CiMin | null>(null);
  const [asset, setAsset] = useState<{ id: string; tag: string } | null>(null);
  const products = useQuery({ queryKey: softwareKeys.products({ fields: 'min', pageSize: 500 }), queryFn: () => softwareApi.productsMin({ pageSize: 500, sort: 'publisher' }), enabled: open, staleTime: 60_000 });
  useEffect(() => {
    if (!open) return;
    setForm({ ...toForm(installation), ...(!installation && defaultProductId ? { productId: defaultProductId } : {}) });
    setCustomerId(installation?.customerId ?? defaultCustomerId ?? '');
    setCi(installation?.ciId ? { id: installation.ciId, name: installation.ciName ?? installation.ciHostname ?? 'CI', hostname: installation.ciHostname, typeKey: '', status: installation.ciStatus ?? 'active', customerId: installation.customerId } : null);
    setAsset(installation?.assetId ? { id: installation.assetId, tag: installation.assetTag ?? 'asset' } : null);
  }, [open, installation, defaultCustomerId, defaultProductId]);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const hasHost = !!(ci || asset || form.hostName?.trim() || form.assignedUser?.trim());

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        ciId: ci?.id ?? null,
        assetId: asset?.id ?? null,
        hostName: form.hostName?.trim() || null,
        assignedUser: form.assignedUser?.trim() || null,
        version: form.version?.trim() || null,
        edition: form.edition?.trim() || null,
        cores: form.cores ? Number(form.cores) : null,
        installPath: form.installPath?.trim() || null,
        installedAt: form.installedAt || null,
        source: form.source || 'manual',
        notes: form.notes?.trim() || null,
      };
      return installation ? softwareApi.updateInstallation(installation.id, body) : softwareApi.createInstallation({ ...body, customerId, productId: form.productId });
    },
    onSuccess: (i) => {
      toast.success(installation ? 'Installation updated' : `${titleOf(i)} recorded`);
      qc.invalidateQueries({ queryKey: softwareKeys.all });
      qc.invalidateQueries({ queryKey: ['overview', 'software'] });
      onSaved?.(i);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={open} onClose={onClose} title={installation ? `Edit installation · ${titleOf(installation)}` : 'Record installation'} width="max-w-2xl" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!customerId || !form.productId || !hasHost} onClick={() => save.mutate()}>{installation ? 'Save changes' : 'Record'}</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Customer" required>
          <Select value={customerId} disabled={!!installation} onChange={(e) => { setCustomerId(e.target.value); setCi(null); setAsset(null); }} placeholder="Select customer…" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))} />
        </Field>
        <Field label="Title" required>
          <Select value={form.productId ?? ''} disabled={!!installation} onChange={(e) => set('productId', e.target.value)} placeholder="Select title…" options={(products.data?.items ?? []).filter((p) => p.isActive || p.id === form.productId).map((p) => ({ value: p.id, label: titleOf(p) }))} />
        </Field>
        <Field label="Configuration item" hint="Only CIs of the customer; the linked asset is filled in automatically." className="sm:col-span-2">
          {customerId ? <CiPicker customerId={customerId} value={ci} onChange={setCi} /> : <Input disabled placeholder="Choose a customer first" />}
        </Field>
        <Field label="Asset" hint="When there is no CI, pick the asset by tag."><AssetPicker customerId={customerId} value={asset} onChange={setAsset} /></Field>
        <Field label="Host name" hint="For hosts not in the CMDB yet."><Input value={form.hostName ?? ''} onChange={(e) => set('hostName', e.target.value)} placeholder="hq-lt01" /></Field>
        <Field label="User" hint="Named-user licences count distinct users."><Input value={form.assignedUser ?? ''} onChange={(e) => set('assignedUser', e.target.value)} placeholder="jane.doe@example.com" /></Field>
        <Field label="Source"><Select value={form.source ?? 'manual'} onChange={(e) => set('source', e.target.value)} options={INSTALL_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s] ?? s }))} /></Field>
        <Field label="Version"><Input value={form.version ?? ''} onChange={(e) => set('version', e.target.value)} /></Field>
        <Field label="Edition"><Input value={form.edition ?? ''} onChange={(e) => set('edition', e.target.value)} /></Field>
        <Field label="Cores" hint="Per-core licences sum the cores of every host."><Input type="number" min={1} max={4096} value={form.cores ?? ''} onChange={(e) => set('cores', e.target.value)} /></Field>
        <Field label="Installed on"><Input type="date" value={form.installedAt ?? ''} onChange={(e) => set('installedAt', e.target.value)} /></Field>
        <Field label="Install path" className="sm:col-span-2"><Input value={form.installPath ?? ''} onChange={(e) => set('installPath', e.target.value)} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
        {!hasHost && <div className="sm:col-span-2 text-[12.5px] text-amber-700">An installation needs a CI, an asset, a host name or a user.</div>}
      </div>
    </Dialog>
  );
}
