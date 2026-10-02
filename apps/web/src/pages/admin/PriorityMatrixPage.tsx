import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { get, put } from '@/api/client';
import { Button, LoadingBlock, Badge } from '@/components/ui';
import { useLookups } from '@/hooks/useLookups';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { useAdminMutation } from '@/components/admin/api';
import { cn } from '@/lib/utils';

interface Cell {
  impactId: string;
  urgencyId: string;
  priorityId: string;
}

export default function PriorityMatrixPage() {
  const lookups = useLookups();
  const q = useQuery({ queryKey: ['config', 'priority-matrix'], queryFn: () => get<Cell[]>('/config/priority-matrix') });
  const impacts = lookups.options('ticket_impact');
  const urgencies = lookups.options('ticket_urgency');
  const priorities = lookups.options('ticket_priority');
  const [cells, setCells] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (q.data) {
      setCells(Object.fromEntries(q.data.map((c) => [`${c.impactId}|${c.urgencyId}`, c.priorityId])));
      setDirty(false);
    }
  }, [q.data]);
  const save = useAdminMutation((body: { cells: Cell[] }) => put('/config/priority-matrix', body), { invalidate: [['config', 'priority-matrix']], success: 'Priority matrix saved', onSuccess: () => setDirty(false) });
  const missing = useMemo(() => impacts.flatMap((i) => urgencies.map((u) => `${i.id}|${u.id}`)).filter((k) => !cells[k]).length, [impacts, urgencies, cells]);

  if (lookups.isLoading || q.isLoading) return <LoadingBlock />;

  const submit = () => {
    const list: Cell[] = [];
    for (const i of impacts) for (const u of urgencies) if (cells[`${i.id}|${u.id}`]) list.push({ impactId: i.id, urgencyId: u.id, priorityId: cells[`${i.id}|${u.id}`] });
    save.mutate({ cells: list });
  };

  return (
    <div>
      <SectionHeader
        title="Priority matrix"
        description="Impact × urgency determines the suggested priority when a ticket is logged. Engineers can still override it."
        actions={
          <Button icon={<Save className="h-4 w-4" />} onClick={submit} loading={save.isPending} disabled={!dirty}>
            Save
          </Button>
        }
      />
      <div className="card overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="w-48">Impact ↓ / Urgency →</th>
              {urgencies.map((u) => (
                <th key={u.id}>{u.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {impacts.map((i) => (
              <tr key={i.id}>
                <td className="font-medium">{i.label}</td>
                {urgencies.map((u) => {
                  const key = `${i.id}|${u.id}`;
                  const p = priorities.find((x) => x.id === cells[key]);
                  return (
                    <td key={u.id}>
                      <div className="flex items-center gap-2">
                        <select
                          className={cn('input py-1', !cells[key] && 'border-amber-400')}
                          value={cells[key] ?? ''}
                          onChange={(e) => {
                            setCells((c) => ({ ...c, [key]: e.target.value }));
                            setDirty(true);
                          }}
                        >
                          <option value="">— not set —</option>
                          {priorities.map((pr) => (
                            <option key={pr.id} value={pr.id}>
                              {pr.label}
                            </option>
                          ))}
                        </select>
                        {p && <Badge color={p.color ?? undefined} className="shrink-0">{p.key.toUpperCase()}</Badge>}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {missing > 0 && <div className="px-3 py-2 text-[12.5px] text-amber-600 border-t border-default">{missing} combination(s) have no priority yet; tickets with those values fall back to the default priority.</div>}
      </div>
    </div>
  );
}
