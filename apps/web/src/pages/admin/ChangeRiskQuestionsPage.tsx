import { useQuery } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { Button, Badge, Input, type Column } from '@/components/ui';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MonoCell, MutedCell } from '@/components/admin/ConfigTable';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useAdminMutation } from '@/components/admin/api';
import { useLookups } from '@/hooks/useLookups';
import { changesApi, changeKeys, type RiskQuestion, type RiskOption } from '@/components/changes/api';

type Values = Record<string, unknown>;

/** Options editor: a key, a label and a score per answer. */
function OptionsEditor({ value, onChange, disabled }: { value: RiskOption[]; onChange: (v: RiskOption[]) => void; disabled: boolean }) {
  const set = (i: number, patch: Partial<RiskOption>) => onChange(value.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((o, i) => (
        <div key={i} className="grid grid-cols-[1fr_120px_80px_auto] gap-2 items-center">
          <Input value={o.label} disabled={disabled} placeholder="Answer" onChange={(e) => set(i, { label: e.target.value, key: o.key || slug(e.target.value) })} />
          <Input value={o.key} disabled={disabled} placeholder="key" className="font-mono text-[12px]" onChange={(e) => set(i, { key: slug(e.target.value) })} />
          <Input type="number" min={0} max={100} value={o.score} disabled={disabled} onChange={(e) => set(i, { score: Number(e.target.value) })} />
          <Button size="sm" variant="ghost" className="px-2" disabled={disabled || value.length <= 2} icon={<Trash2 className="h-3.5 w-3.5" />} aria-label="Remove option" onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div><Button size="sm" variant="outline" disabled={disabled || value.length >= 10} icon={<Plus className="h-3.5 w-3.5" />} onClick={() => onChange([...value, { key: '', label: '', score: 0 }])}>Add answer</Button></div>
      <div className="text-[11.5px] text-subtle">Scores run 0 (no risk) to 100; the question's weight multiplies the chosen score.</div>
    </div>
  );
}

/** The change risk questionnaire: weighted questions whose answers score a change low, medium or high. */
export default function ChangeRiskQuestionsPage() {
  const q = useQuery({ queryKey: changeKeys.questions, queryFn: () => changesApi.questions(true) });
  const editor = useEditor<RiskQuestion>();
  const lookups = useLookups();
  const thresholds = (lookups.lookups?.settings?.['changes.risk_thresholds'] as { medium?: number; high?: number } | undefined) ?? { medium: 35, high: 65 };
  const invalidate = [['changes']];
  const create = useAdminMutation((body: Values) => changesApi.createQuestion(body), { invalidate, success: 'Question added' });
  const update = useAdminMutation(({ id, ...body }: Values & { id: string }) => changesApi.updateQuestion(id, body), { invalidate });
  const remove = useAdminMutation((id: string) => changesApi.deleteQuestion(id), { invalidate, success: 'Question deleted' });
  const rows = q.data?.items ?? [];
  const move = (r: RiskQuestion, dir: -1 | 1) => {
    const i = rows.findIndex((x) => x.id === r.id);
    const other = rows[i + dir];
    if (!other) return;
    void update.mutateAsync({ id: r.id, sortOrder: other.sortOrder === r.sortOrder ? other.sortOrder + dir : other.sortOrder });
    void update.mutateAsync({ id: other.id, sortOrder: r.sortOrder });
  };

  const fields: FieldSpec<Values>[] = [
    { key: 'question', label: 'Question', type: 'text', required: true, span: 2, placeholder: 'How many users are affected?' },
    { key: 'key', label: 'Key', type: 'key', required: true, disabled: (v) => !!v.id },
    { key: 'weight', label: 'Weight', type: 'number', min: 0, max: 10, hint: '0 to 10; multiplies the chosen score' },
    { key: 'hint', label: 'Hint', type: 'text', span: 2, placeholder: 'Shown under the question' },
    { key: 'options', label: 'Answers', type: 'custom', span: 2, render: ({ value, onChange, disabled }) => <OptionsEditor value={(value as RiskOption[]) ?? []} onChange={(v) => onChange(v)} disabled={disabled} /> },
    { key: 'isActive', label: 'Active', type: 'boolean' },
  ];
  const initial: Values = editor.row ? { ...editor.row } : { question: '', key: '', weight: 1, hint: '', options: [{ key: 'low', label: 'Low', score: 1 }, { key: 'medium', label: 'Medium', score: 3 }, { key: 'high', label: 'High', score: 5 }], isActive: true };
  async function submit(v: Values) {
    const options = ((v.options as RiskOption[]) ?? []).filter((o) => o.label.trim()).map((o) => ({ key: o.key || o.label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label: o.label.trim(), score: Number(o.score) || 0 }));
    if (options.length < 2) throw new Error('At least two answers are needed');
    const body = { question: v.question, key: v.key, weight: Number(v.weight ?? 1), hint: (v.hint as string) || null, options, isActive: !!v.isActive };
    if (editor.row) await update.mutateAsync({ id: editor.row.id, ...body });
    else await create.mutateAsync({ ...body, sortOrder: rows.length });
  }
  const columns: Column<RiskQuestion>[] = [
    { key: 'order', header: '', width: '70px', render: (r) => (
      <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" className="px-1" icon={<ArrowUp className="h-3.5 w-3.5" />} aria-label="Move up" onClick={() => move(r, -1)} />
        <Button size="sm" variant="ghost" className="px-1" icon={<ArrowDown className="h-3.5 w-3.5" />} aria-label="Move down" onClick={() => move(r, 1)} />
      </span>
    ) },
    { key: 'question', header: 'Question', render: (r) => <div><div className="font-medium">{r.question}</div><MonoCell>{r.key}</MonoCell></div> },
    { key: 'weight', header: 'Weight', width: '90px', render: (r) => <Badge color="slate">×{r.weight}</Badge> },
    { key: 'options', header: 'Answers', render: (r) => <MutedCell>{r.options.map((o) => `${o.label} (${o.score})`).join(' · ')}</MutedCell> },
    { key: 'isActive', header: 'Status', width: '90px', render: (r) => <ActiveDot active={r.isActive} /> },
  ];
  return (
    <div>
      <SectionHeader title="Change risk questions" description={`Each answer's score times the question's weight adds up and is scaled to 0–100: medium from ${thresholds.medium ?? 35}, high from ${thresholds.high ?? 65} (changes.risk_thresholds in Settings). The level also sets the change's Risk field.`} actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New question</Button>} />
      <ConfigTable<RiskQuestion>
        columns={columns}
        rows={rows}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle="No risk questions yet"
        emptyDescription="Add the questions an implementer answers before a change is approved."
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete "${r.question}"?`, description: 'Existing assessments keep their score.', confirmLabel: 'Delete' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit question' : 'New risk question'} fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" />
    </div>
  );
}
