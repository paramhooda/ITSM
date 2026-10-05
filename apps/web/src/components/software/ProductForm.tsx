import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LICENCE_MODELS } from '@itsm/shared';
import { Button, Dialog, Field, Input, Select, Textarea, Checkbox } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { errorMessage } from '@/components/cmdb/hooks';
import { softwareApi, softwareKeys, LICENCE_MODEL_LABELS, type SoftwareProductDetail } from './api';

type FormState = Record<string, string>;
const FIELDS = ['publisher', 'name', 'versionFamily', 'categoryId', 'licenceModel', 'website', 'eolDate', 'description', 'tags'] as const;

function toForm(p?: Partial<SoftwareProductDetail> | null): FormState {
  const f: FormState = { licenceModel: 'per_device', isActive: 'true' };
  if (!p) return f;
  for (const k of FIELDS) {
    const v = (p as Record<string, unknown>)[k];
    f[k] = Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v);
  }
  f.isActive = p.isActive === false ? 'false' : 'true';
  return f;
}

/** Create / edit a catalogue title (shared across customers). */
export function ProductForm({ open, onClose, product, onSaved }: { open: boolean; onClose: () => void; product?: SoftwareProductDetail | null; onSaved?: (p: SoftwareProductDetail) => void }) {
  const qc = useQueryClient();
  const { options } = useLookups();
  const [form, setForm] = useState<FormState>(toForm(product));
  useEffect(() => {
    if (open) setForm(toForm(product));
  }, [open, product]);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        publisher: form.publisher.trim(),
        name: form.name.trim(),
        versionFamily: form.versionFamily?.trim() || null,
        categoryId: form.categoryId || null,
        licenceModel: form.licenceModel || 'per_device',
        website: form.website?.trim() || null,
        eolDate: form.eolDate || null,
        description: form.description?.trim() || null,
        tags: (form.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        ...(product ? { isActive: form.isActive !== 'false' } : {}),
      };
      return product ? softwareApi.updateProduct(product.id, body) : softwareApi.createProduct(body);
    },
    onSuccess: (p) => {
      toast.success(product ? 'Title updated' : `${p.publisher} ${p.name} added to the catalogue`);
      qc.invalidateQueries({ queryKey: softwareKeys.all });
      qc.invalidateQueries({ queryKey: ['overview', 'software'] });
      onSaved?.(p);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const categories = options('software_category');
  return (
    <Dialog open={open} onClose={onClose} title={product ? `Edit ${product.publisher} ${product.name}` : 'New software title'} width="max-w-2xl" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!form.publisher?.trim() || !form.name?.trim()} onClick={() => save.mutate()}>{product ? 'Save changes' : 'Add title'}</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Publisher" required><Input value={form.publisher ?? ''} onChange={(e) => set('publisher', e.target.value)} placeholder="Microsoft" autoFocus /></Field>
        <Field label="Product" required><Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="Office LTSC" /></Field>
        <Field label="Version family" hint="2021, 8, 19c… leave empty for evergreen subscriptions."><Input value={form.versionFamily ?? ''} onChange={(e) => set('versionFamily', e.target.value)} /></Field>
        <Field label="Category"><Select value={form.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value)} placeholder="—" options={categories.map((o) => ({ value: o.id, label: o.label }))} /></Field>
        <Field label="Licence model" hint="How the publisher sells it; new licences default to the matching metric and term."><Select value={form.licenceModel ?? 'per_device'} onChange={(e) => set('licenceModel', e.target.value)} options={LICENCE_MODELS.map((m) => ({ value: m, label: LICENCE_MODEL_LABELS[m] ?? m }))} /></Field>
        <Field label="End of life"><Input type="date" value={form.eolDate ?? ''} onChange={(e) => set('eolDate', e.target.value)} /></Field>
        <Field label="Website"><Input value={form.website ?? ''} onChange={(e) => set('website', e.target.value)} placeholder="https://" /></Field>
        <Field label="Tags" hint="Comma separated"><Input value={form.tags ?? ''} onChange={(e) => set('tags', e.target.value)} /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
        {product && <Checkbox label="Active (inactive titles cannot receive new licences)" checked={form.isActive !== 'false'} onChange={(e) => set('isActive', e.target.checked ? 'true' : 'false')} />}
      </div>
    </Dialog>
  );
}
