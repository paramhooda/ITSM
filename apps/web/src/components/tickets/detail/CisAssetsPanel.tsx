import { useEffect, useState } from 'react';
import { Panel } from '../Panel';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Server, Boxes, Pencil, Check } from 'lucide-react';
import { Button } from '@/components/ui';
import { get } from '@/api/client';
import { ticketsApi, itemsOf } from '../api';
import { EntityPicker, type PickerItem } from '../EntityPicker';
import type { TicketDetail } from '../types';

/** Affected CIs and assets as chips; edit mode replaces the full set. */
export function CisAssetsPanel({ ticket, canEdit }: { ticket: TicketDetail; canEdit: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [cis, setCis] = useState<PickerItem[]>([]);
  const [assets, setAssets] = useState<PickerItem[]>([]);
  useEffect(() => {
    setCis(ticket.cis.map((c) => ({ id: c.id, label: c.name, sublabel: [c.hostname, c.ipAddress].filter(Boolean).join(' · ') || null })));
    setAssets(ticket.assets.map((a) => ({ id: a.id, label: `${a.tag} · ${a.name}`, sublabel: a.serialNumber })));
  }, [ticket.cis, ticket.assets]);
  const save = useMutation({
    mutationFn: async () => {
      await ticketsApi.setCis(ticket.id, cis.map((c) => c.id));
      await ticketsApi.setAssets(ticket.id, assets.map((a) => a.id));
    },
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['tickets', ticket.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!ticket.cis.length && !ticket.assets.length && !canEdit) return null;
  return (
    <Panel
      title={<span className="inline-flex items-center gap-2"><Server className="h-4 w-4 text-subtle" /> Affected CIs & assets</span>}
      actions={canEdit ? editing ? <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} onClick={() => save.mutate()} loading={save.isPending}>Save</Button> : <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(true)}>Edit</Button> : undefined}
    >
      {editing ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <EntityPicker multiple queryKey={`cis-${ticket.customerId}`} placeholder="Add CI…" value={cis} onChange={setCis} search={async (q) => itemsOf<{ id: string; name: string; hostname?: string | null; ipAddress?: string | null }>(await get<unknown>('/cmdb/cis', { customerId: ticket.customerId, q, pageSize: 20 })).map((c) => ({ id: c.id, label: c.name, sublabel: [c.hostname, c.ipAddress].filter(Boolean).join(' · ') || null }))} />
          <EntityPicker multiple queryKey={`assets-${ticket.customerId}`} placeholder="Add asset…" value={assets} onChange={setAssets} search={async (q) => itemsOf<{ id: string; tag: string; name: string; serialNumber?: string | null }>(await get<unknown>('/assets', { customerId: ticket.customerId, q, pageSize: 20 })).map((a) => ({ id: a.id, label: `${a.tag} · ${a.name}`, sublabel: a.serialNumber ?? null }))} />
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {ticket.cis.map((c) => (
            <Link key={c.id} to={`/cmdb/cis/${c.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-default bg-surface-2 px-2 py-0.5 text-[12.5px] hover:border-brand-400" title={[c.hostname, c.ipAddress].filter(Boolean).join(' · ')}>
              <Server className="h-3 w-3 text-subtle" /> {c.name}
              {c.id === ticket.primaryCiId && <span className="text-[10px] uppercase text-subtle">primary</span>}
            </Link>
          ))}
          {ticket.assets.map((a) => (
            <Link key={a.id} to={`/assets/${a.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-default bg-surface-2 px-2 py-0.5 text-[12.5px] hover:border-brand-400" title={a.serialNumber ?? ''}>
              <Boxes className="h-3 w-3 text-subtle" /> {a.tag} · {a.name}
            </Link>
          ))}
          {!ticket.cis.length && !ticket.assets.length && <span className="text-[12.5px] text-muted">None recorded.</span>}
        </div>
      )}
    </Panel>
  );
}
