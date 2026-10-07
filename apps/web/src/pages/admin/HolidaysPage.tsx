import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Save, ClipboardPaste, X } from 'lucide-react';
import { get, put } from '@/api/client';
import { Button, Card, Dialog, Textarea, EmptyState, LoadingBlock, type Column } from '@/components/ui';
import { useConfigFilter } from '@/hooks/useConfigFilter';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useConfigKind, useConfigMutations, useAdminMutation } from '@/components/admin/api';
import { cn } from '@/lib/utils';

interface HolidayCalendar {
  id: string;
  name: string;
  description: string | null;
  country: string | null;
}
interface Holiday {
  date: string;
  name: string;
}

type Values = Record<string, unknown>;

/** Holiday calendars: the list (searchable through `q` in the URL) beside the editor of the selected calendar's dates. */
export default function HolidaysPage() {
  const q = useConfigKind<HolidayCalendar>('holiday-calendars');
  const { create, update, remove } = useConfigMutations('holiday-calendars', { label: 'Holiday calendar' });
  const editor = useEditor<HolidayCalendar>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && q.data?.length) setSelectedId(q.data[0].id);
  }, [q.data, selectedId]);
  const selected = q.data?.find((c) => c.id === selectedId) ?? null;
  const all = useMemo(() => q.data ?? [], [q.data]);
  const f = useConfigFilter(all, { search: [(r) => r.name, (r) => r.country, (r) => r.description], noun: ['holiday calendar', 'holiday calendars'], searchPlaceholder: 'Search calendars' });

  const fields: FieldSpec<Values>[] = [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'country', label: 'Country code', type: 'text', placeholder: 'IN', hint: 'ISO 3166-1 alpha-2' },
    { key: 'description', label: 'Description', type: 'text', span: 2 },
  ];
  async function submit(v: Values) {
    const body = { name: v.name, country: (v.country as string)?.toUpperCase() || null, description: v.description || null };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else {
      const created = (await create.mutateAsync(body)) as { id: string };
      setSelectedId(created.id);
    }
  }

  const columns: Column<HolidayCalendar>[] = [
    { key: 'name', header: 'Calendar', render: (r) => <span className={cn('font-medium', r.id === selectedId && 'text-brand-700')}>{r.name}</span> },
    { key: 'country', header: 'Country', render: (r) => <MutedCell>{r.country ?? '—'}</MutedCell> },
  ];

  return (
    <div>
      <SectionHeader title="Holiday calendars" description="Public holidays excluded from business-hours SLA clocks. Link a holiday calendar to business calendars and SLA policies." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New holiday calendar</Button>} />
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-2">
          <ConfigToolbar {...f.toolbar} />
          <ConfigTable<HolidayCalendar>
            columns={columns}
            rows={f.rows}
            pager={f.pager}
            loading={q.isLoading}
            error={q.error}
            retry={() => q.refetch()}
            onRowClick={(r) => setSelectedId(r.id)}
            emptyTitle={f.filtered ? 'No calendars match' : 'No holiday calendars yet'}
            emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Add a calendar of public holidays to exclude from business-hours SLA clocks.'}
            actions={[
              { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
              { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete "${r.name}"?`, description: 'All its holidays are removed. Business calendars and SLA policies linked to it fall back to no holidays.', confirmLabel: 'Delete calendar' }), onClick: (r) => { remove.mutate(r.id); if (selectedId === r.id) setSelectedId(null); } },
            ]}
          />
        </div>
        <div className="lg:col-span-3">{selected ? <HolidayEditor key={selected.id} calendar={selected} /> : <Card><EmptyState title="Select a holiday calendar" description="Pick a calendar on the left to manage its dates." /></Card>}</div>
      </div>
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit holiday calendar' : 'New holiday calendar'} fields={fields} initial={editor.row ? { ...editor.row } : { name: '', country: '', description: '' }} onSubmit={submit} />
    </div>
  );
}

function HolidayEditor({ calendar }: { calendar: HolidayCalendar }) {
  const q = useQuery({ queryKey: ['config', 'holidays', calendar.id], queryFn: () => get<Holiday[]>(`/config/holiday-calendars/${calendar.id}/holidays`) });
  const [items, setItems] = useState<Holiday[]>([]);
  const [dirty, setDirty] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  useEffect(() => {
    if (q.data) {
      setItems(q.data.map((h) => ({ date: h.date, name: h.name })));
      setDirty(false);
    }
  }, [q.data]);
  const save = useAdminMutation((body: { items: Holiday[] }) => put(`/config/holiday-calendars/${calendar.id}/holidays`, body), { invalidate: [['config', 'holidays', calendar.id]], success: 'Holidays saved', onSuccess: () => setDirty(false) });
  const sorted = useMemo(() => [...items].sort((a, b) => a.date.localeCompare(b.date)), [items]);
  const duplicates = useMemo(() => new Set(items.map((i) => i.date).filter((d, i, arr) => d && arr.indexOf(d) !== i)), [items]);
  const years = useMemo(() => [...new Set(items.map((i) => i.date.slice(0, 4)).filter(Boolean))].sort(), [items]);

  const update = (i: number, patch: Partial<Holiday>) => {
    setItems((list) => list.map((h, j) => (j === i ? { ...h, ...patch } : h)));
    setDirty(true);
  };
  const applyPaste = () => {
    const parsed: Holiday[] = [];
    for (const line of pasteText.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d{4}-\d{2}-\d{2})\s*[,;\t]\s*(.+)$/);
      if (m) parsed.push({ date: m[1], name: m[2].trim() });
    }
    if (parsed.length) {
      setItems((list) => {
        const existing = new Set(list.map((h) => h.date));
        return [...list, ...parsed.filter((p) => !existing.has(p.date))];
      });
      setDirty(true);
    }
    setPasteText('');
    setPasteOpen(false);
  };
  const submit = () => {
    const clean = items.filter((h) => h.date && h.name.trim());
    if (duplicates.size) return;
    save.mutate({ items: clean.map((h) => ({ date: h.date, name: h.name.trim() })) });
  };

  return (
    <Card
      title={`${calendar.name} · ${items.length} holidays${years.length ? ` · ${years.join(', ')}` : ''}`}
      padded={false}
      actions={
        <>
          <Button variant="ghost" size="sm" icon={<ClipboardPaste className="h-3.5 w-3.5" />} onClick={() => setPasteOpen(true)}>
            Bulk paste
          </Button>
          <Button variant="outline" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => { setItems((l) => [...l, { date: '', name: '' }]); setDirty(true); }}>
            Add
          </Button>
          <Button size="sm" icon={<Save className="h-3.5 w-3.5" />} onClick={submit} loading={save.isPending} disabled={!dirty || duplicates.size > 0}>
            Save
          </Button>
        </>
      }
    >
      {q.isLoading ? (
        <LoadingBlock />
      ) : items.length === 0 ? (
        <EmptyState title="No holidays yet" description="Add dates one by one or paste a list of YYYY-MM-DD,Name lines." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th className="w-44">Date</th>
              <th>Name</th>
              <th className="w-px" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((h) => {
              const i = items.indexOf(h);
              return (
                <tr key={i}>
                  <td>
                    <input type="date" className={cn('input py-1', duplicates.has(h.date) && 'border-red-500')} value={h.date} onChange={(e) => update(i, { date: e.target.value })} />
                  </td>
                  <td>
                    <input className="input py-1" value={h.name} placeholder="Holiday name" onChange={(e) => update(i, { name: e.target.value })} />
                  </td>
                  <td>
                    <button className="h-7 w-7 inline-flex items-center justify-center rounded-md text-subtle hover:text-red-600 hover:bg-surface-2" title="Remove" onClick={() => { setItems((l) => l.filter((_, j) => j !== i)); setDirty(true); }}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {duplicates.size > 0 && <div className="px-3 py-2 text-[12.5px] text-red-600 border-t border-default">Duplicate dates: {[...duplicates].join(', ')}</div>}
      <Dialog
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        title="Paste holidays"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPasteOpen(false)}>
              Cancel
            </Button>
            <Button onClick={applyPaste}>Add dates</Button>
          </>
        }
      >
        <div className="text-[12.5px] text-muted mb-2">One holiday per line as <code className="font-mono">YYYY-MM-DD,Name</code>. Existing dates are skipped.</div>
        <Textarea rows={10} className="font-mono text-[12.5px]" value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder={'2027-01-26,Republic Day\n2027-08-15,Independence Day'} />
      </Dialog>
    </Card>
  );
}
