import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowLeft, Trash2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { post, del } from '@/api/client';
import { Button, Dialog, Field, Select, Input, EmptyState, Badge } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { CiPicker, type CiMin } from './CiPicker';
import { CiTypeBadge, CiStatusBadge } from './CiTypeBadge';
import { errorMessage } from './hooks';

export interface Relationship {
  id: string;
  typeId: string;
  typeKey: string;
  typeName: string;
  inverseName: string;
  description?: string | null;
  source: string;
  ci: { id: string; name: string; typeKey: string; typeName: string; typeColor?: string | null; status: string; criticality: string };
}

function Row({ r, direction, onRemove, canManage }: { r: Relationship; direction: 'out' | 'in'; onRemove: (id: string) => void; canManage: boolean }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-default last:border-0">
      <span className="text-[12px] text-muted w-32 shrink-0 inline-flex items-center gap-1">
        {direction === 'out' ? <ArrowRight className="h-3.5 w-3.5" /> : <ArrowLeft className="h-3.5 w-3.5" />}
        {direction === 'out' ? r.typeName : r.inverseName}
      </span>
      <CiTypeBadge typeKey={r.ci.typeKey} name={r.ci.typeName} color={r.ci.typeColor} />
      <Link to={`/cmdb/${r.ci.id}`} className="font-medium hover:underline truncate">
        {r.ci.name}
      </Link>
      <CiStatusBadge status={r.ci.status} />
      {r.description && <span className="text-xs text-subtle truncate">{r.description}</span>}
      {r.source !== 'manual' && <Badge color="sky">{r.source}</Badge>}
      <div className="flex-1" />
      {canManage && (
        <Button variant="ghost" size="icon" onClick={() => onRemove(r.id)} title="Remove relationship">
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

/** Outbound and inbound relationship lists with add/remove. */
export function RelationshipList({ ciId, customerId, outbound, inbound }: { ciId: string; customerId: string; outbound: Relationship[]; inbound: Relationship[] }) {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const canManage = can('cmdb:manage');
  const { lookups } = useLookups();
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState<CiMin | null>(null);
  const [typeId, setTypeId] = useState('');
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [description, setDescription] = useState('');
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cmdb', ciId] });
    qc.invalidateQueries({ queryKey: ['cmdb', 'list'] });
  };
  const add = useMutation({
    mutationFn: () => {
      const source = direction === 'out' ? ciId : other!.id;
      const target = direction === 'out' ? other!.id : ciId;
      return post(`/cmdb/cis/${source}/relationships`, { targetCiId: target, typeId, description: description || null });
    },
    onSuccess: () => {
      toast.success('Relationship added');
      invalidate();
      setOpen(false);
      setOther(null);
      setDescription('');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/cmdb/relationships/${id}`),
    onSuccess: () => {
      toast.success('Relationship removed');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const relType = lookups?.relationshipTypes.find((t) => t.id === typeId);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-[13px] text-muted">{outbound.length + inbound.length} relationship(s)</div>
        {canManage && (
          <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
            Add relationship
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="card p-3">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-subtle mb-1">This CI → others</div>
          {outbound.length ? outbound.map((r) => <Row key={r.id} r={r} direction="out" onRemove={(id) => remove.mutate(id)} canManage={canManage} />) : <EmptyState title="No outbound relationships" />}
        </div>
        <div className="card p-3">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-subtle mb-1">Others → this CI</div>
          {inbound.length ? inbound.map((r) => <Row key={r.id} r={r} direction="in" onRemove={(id) => remove.mutate(id)} canManage={canManage} />) : <EmptyState title="No inbound relationships" />}
        </div>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add relationship"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => add.mutate()} disabled={!other || !typeId} loading={add.isPending}>Add</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Direction">
            <div className="flex gap-2">
              <Button variant={direction === 'out' ? 'primary' : 'outline'} size="sm" onClick={() => setDirection('out')}>This CI {relType ? relType.name.toLowerCase() : '→'} other</Button>
              <Button variant={direction === 'in' ? 'primary' : 'outline'} size="sm" onClick={() => setDirection('in')}>Other {relType ? relType.name.toLowerCase() : '→'} this CI</Button>
            </div>
          </Field>
          <Field label="Relationship type" required>
            <Select value={typeId} onChange={(e) => setTypeId(e.target.value)} placeholder="Select type…" options={(lookups?.relationshipTypes ?? []).map((t) => ({ value: t.id, label: `${t.name} (inverse: ${t.inverseName})` }))} />
          </Field>
          <Field label="Other CI" required hint="Only CIs of the same customer can be related.">
            <CiPicker customerId={customerId} value={other} onChange={setOther} exclude={[ciId]} autoFocus />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. cluster c1, port Gi1/0/1" />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
