import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { get } from '@/api/client';
import { Button, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, Input, Textarea } from '@/components/ui';
import { EntityPicker, type PickerItem } from '@/components/tickets/EntityPicker';
import { errorMessage } from '@/components/cmdb/hooks';
import { fmtMoney, fmtNumber } from '@/lib/format';
import { fieldApi, fieldKeys } from './api';
import type { Part } from './types';

interface Draft {
  name: string;
  partNumber: string;
  serialNumber: string;
  quantity: string;
  unitCost: string;
  asset: PickerItem[];
  billable: boolean;
  notes: string;
}
const emptyDraft = (): Draft => ({ name: '', partNumber: '', serialNumber: '', quantity: '1', unitCost: '', asset: [], billable: false, notes: '' });

/** Parts used on a visit with add / edit / delete (API decides who may edit; `canEdit` only hides the controls). */
export function PartsTable({ visitId, customerId, parts, canEdit }: { visitId: string; customerId: string; parts: Part[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Part | null | 'new'>(null);
  const [confirm, setConfirm] = useState<Part | null>(null);
  const [d, setD] = useState<Draft>(emptyDraft());
  const set = (patch: Partial<Draft>) => setD((s) => ({ ...s, ...patch }));
  useEffect(() => {
    if (editing === 'new') setD(emptyDraft());
    else if (editing) setD({ name: editing.name, partNumber: editing.partNumber ?? '', serialNumber: editing.serialNumber ?? '', quantity: String(editing.quantity), unitCost: editing.unitCost === null ? '' : String(editing.unitCost), asset: editing.assetId ? [{ id: editing.assetId, label: editing.assetTag ?? 'Asset', sublabel: editing.assetName ?? undefined }] : [], billable: editing.billable, notes: editing.notes ?? '' });
  }, [editing]);
  const invalidate = () => qc.invalidateQueries({ queryKey: fieldKeys.detail(visitId) });

  const save = useMutation({
    mutationFn: () => {
      const body = { name: d.name.trim(), partNumber: d.partNumber.trim() || null, serialNumber: d.serialNumber.trim() || null, quantity: Number(d.quantity) || 1, unitCost: d.unitCost === '' ? null : Number(d.unitCost), assetId: d.asset[0]?.id ?? null, billable: d.billable, notes: d.notes.trim() || null };
      return editing && editing !== 'new' ? fieldApi.updatePart(editing.id, body) : fieldApi.addPart(visitId, body);
    },
    onSuccess: () => {
      toast.success('Part saved');
      setEditing(null);
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => fieldApi.deletePart(id),
    onSuccess: () => {
      toast.success('Part removed');
      setConfirm(null);
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const total = parts.reduce((s, p) => s + (p.unitCost ?? 0) * p.quantity, 0);
  return (
    <div>
      {parts.length === 0 ? (
        <EmptyState title="No parts recorded" description="Spares and consumables used on site appear here and on the visit report." action={canEdit ? <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>Add part</Button> : undefined} />
      ) : (
        <>
          <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
            <thead>
              <tr>
                <th>Part</th>
                <th>Part no.</th>
                <th>Serial</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Unit cost</th>
                <th>Billable</th>
                {canEdit && <th className="w-16" />}
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div className="font-medium text-[13px]">{p.name}</div>
                    {(p.assetTag || p.notes) && <div className="text-[11.5px] text-muted">{[p.assetTag && `Asset ${p.assetTag}`, p.notes].filter(Boolean).join(' · ')}</div>}
                  </td>
                  <td className="font-mono text-xs">{p.partNumber ?? '—'}</td>
                  <td className="font-mono text-xs">{p.serialNumber ?? '—'}</td>
                  <td className="text-right tabular-nums">{fmtNumber(p.quantity, 2)}</td>
                  <td className="text-right tabular-nums">{p.unitCost === null ? '—' : fmtMoney(p.unitCost)}</td>
                  <td>{p.billable ? 'Yes' : 'No'}</td>
                  {canEdit && (
                    <td className="text-right whitespace-nowrap">
                      <button className="text-subtle hover:text-default mr-2" onClick={() => setEditing(p)} aria-label="Edit part"><Pencil className="h-3.5 w-3.5" /></button>
                      <button className="text-subtle hover:text-red-600" onClick={() => setConfirm(p)} aria-label="Delete part"><Trash2 className="h-3.5 w-3.5" /></button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            {total > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={4} className="text-right text-[12px] text-muted">Total</td>
                  <td className="text-right font-medium tabular-nums">{fmtMoney(total)}</td>
                  <td colSpan={canEdit ? 2 : 1} />
                </tr>
              </tfoot>
            )}
          </table>
          {canEdit && (
            <div className="px-3 py-2 border-t border-default">
              <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>Add part</Button>
            </div>
          )}
        </>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add part' : 'Edit part'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!d.name.trim()}>Save</Button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Part" required className="sm:col-span-2"><Input autoFocus value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. 48-port switch PSU" /></Field>
          <Field label="Part number"><Input value={d.partNumber} onChange={(e) => set({ partNumber: e.target.value })} /></Field>
          <Field label="Serial number"><Input value={d.serialNumber} onChange={(e) => set({ serialNumber: e.target.value })} /></Field>
          <Field label="Quantity"><Input type="number" min={0.01} step="0.01" value={d.quantity} onChange={(e) => set({ quantity: e.target.value })} /></Field>
          <Field label="Unit cost"><Input type="number" min={0} step="0.01" value={d.unitCost} onChange={(e) => set({ unitCost: e.target.value })} /></Field>
          <Field label="Installed on asset" className="sm:col-span-2">
            <EntityPicker queryKey={`assets-${customerId}`} value={d.asset} onChange={(items) => set({ asset: items.slice(-1) })} placeholder="Search assets by tag, name or serial…" search={async (q) => (await get<{ items: { id: string; tag: string; name: string; serialNumber?: string | null }[] }>('/assets', { fields: 'min', customerId, q: q || undefined, pageSize: 20 })).items.map((a) => ({ id: a.id, label: a.tag, sublabel: [a.name, a.serialNumber].filter(Boolean).join(' · ') }))} />
          </Field>
          <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={d.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Checkbox checked={d.billable} onChange={(e) => set({ billable: e.target.checked })} label="Billable to the customer" /></div>
        </div>
      </Dialog>
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={() => confirm && remove.mutate(confirm.id)} title="Remove part?" description={confirm ? `${confirm.name} will be removed from the visit.` : ''} confirmLabel="Remove" danger loading={remove.isPending} />
    </div>
  );
}
