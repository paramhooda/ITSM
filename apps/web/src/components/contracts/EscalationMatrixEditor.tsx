import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Input, Select, EmptyState } from '@/components/ui';
import { useEngineers } from '@/hooks/useLookups';
import type { EscalationLevel } from './types';
import type { Contact } from '@/components/customers/types';

type Row = { level: string; name: string; contactId: string; userId: string; afterMinutes: string };

const toRows = (value: EscalationLevel[]): Row[] => value.map((v) => ({ level: String(v.level ?? 1), name: v.name ?? '', contactId: v.contactId ?? '', userId: v.userId ?? '', afterMinutes: v.afterMinutes != null ? String(v.afterMinutes) : '' }));

/** Table editor for the escalation matrix (level, name, customer contact, MSP user, after minutes). */
export function EscalationMatrixEditor({ value, contacts, canEdit, onSave, saving }: { value: EscalationLevel[]; contacts: Pick<Contact, 'id' | 'name' | 'title'>[]; canEdit: boolean; onSave: (levels: EscalationLevel[]) => void; saving?: boolean }) {
  const engineers = useEngineers();
  const [rows, setRows] = useState<Row[]>(toRows(value));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setRows(toRows(value));
    setDirty(false);
  }, [value]);
  const update = (i: number, p: Partial<Row>) => {
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...p } : row)));
    setDirty(true);
  };
  const add = () => {
    setRows((r) => [...r, { level: String(r.length + 1), name: '', contactId: '', userId: '', afterMinutes: '' }]);
    setDirty(true);
  };
  const remove = (i: number) => {
    setRows((r) => r.filter((_, idx) => idx !== i));
    setDirty(true);
  };
  const save = () =>
    onSave(
      rows
        .filter((r) => r.name.trim() || r.contactId || r.userId)
        .map((r) => ({ level: Number(r.level) || 1, name: r.name.trim() || null, contactId: r.contactId || null, userId: r.userId || null, afterMinutes: r.afterMinutes === '' ? null : Number(r.afterMinutes) }))
        .sort((a, b) => a.level - b.level),
    );

  if (!canEdit && !value.length) return <EmptyState title="No escalation matrix" description="Levels, contacts and timings for escalating incidents under this contract." />;
  if (!canEdit) {
    return (
      <table className="table [&_td]:py-1.5 [&_th]:py-1.5">
        <thead>
          <tr>
            <th className="w-16">Level</th>
            <th>Name</th>
            <th>Customer contact</th>
            <th>MSP contact</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {value.map((l, i) => (
            <tr key={i}>
              <td>L{l.level}</td>
              <td>{l.name ?? '—'}</td>
              <td>
                {l.contactName ?? '—'}
                {l.contactPhone && <span className="text-subtle"> · {l.contactPhone}</span>}
              </td>
              <td>
                {l.userName ?? '—'}
                {l.userEmail && <span className="text-subtle"> · {l.userEmail}</span>}
              </td>
              <td>{l.afterMinutes != null ? `${l.afterMinutes} min` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <div className="space-y-2">
      <table className="table [&_td]:py-1 [&_th]:py-1.5">
        <thead>
          <tr>
            <th className="w-16">Level</th>
            <th>Name / role</th>
            <th>Customer contact</th>
            <th>MSP contact</th>
            <th className="w-28">After (min)</th>
            <th className="w-10"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <Input type="number" min={1} value={r.level} onChange={(e) => update(i, { level: e.target.value })} className="w-14" />
              </td>
              <td>
                <Input value={r.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Service desk / Account manager" />
              </td>
              <td>
                <Select value={r.contactId} onChange={(e) => update(i, { contactId: e.target.value })} placeholder="—" options={contacts.map((c) => ({ value: c.id, label: c.title ? `${c.name} (${c.title})` : c.name }))} />
              </td>
              <td>
                <Select value={r.userId} onChange={(e) => update(i, { userId: e.target.value })} placeholder="—" options={(engineers.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />
              </td>
              <td>
                <Input type="number" min={0} value={r.afterMinutes} onChange={(e) => update(i, { afterMinutes: e.target.value })} />
              </td>
              <td>
                <Button variant="ghost" size="icon" onClick={() => remove(i)} title="Remove level">
                  <Trash2 className="h-3.5 w-3.5 text-red-500" />
                </Button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="text-[13px] text-muted">
                No levels defined.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={add}>
          Add level
        </Button>
        <div className="flex-1" />
        <Button size="sm" onClick={save} disabled={!dirty} loading={saving}>
          Save matrix
        </Button>
      </div>
    </div>
  );
}
