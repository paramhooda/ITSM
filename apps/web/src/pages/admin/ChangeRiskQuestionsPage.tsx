import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, ArrowUp, ArrowDown, Gauge, Save } from 'lucide-react';
import { Button, Badge, Input, Card, Field, type Column } from '@/components/ui';
import { SectionHeader } from '@/components/admin/AdminLayout';
import { ConfigTable, ActiveDot, MonoCell, MutedCell } from '@/components/admin/ConfigTable';
import { ConfigToolbar } from '@/components/admin/ConfigToolbar';
import { FormDialog, useEditor, type FieldSpec } from '@/components/admin/FormDialog';
import { useAdminMutation } from '@/components/admin/api';
import { moveBeside } from '@/lib/configFilter';
import { useLookups } from '@/hooks/useLookups';
import { useConfigFilter } from '@/hooks/useConfigFilter';
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

/** Where the 0–100 score turns medium and high; saved with `admin:config`, read back from the lookups. */
function ThresholdsCard({ current, onSave, saving }: { current: { medium: number; high: number }; onSave: (t: { medium: number; high: number }) => void; saving: boolean }) {
  const [medium, setMedium] = useState(String(current.medium));
  const [high, setHigh] = useState(String(current.high));
  useEffect(() => {
    setMedium(String(current.medium));
    setHigh(String(current.high));
  }, [current.medium, current.high]);
  const m = Number(medium);
  const h = Number(high);
  const valid = Number.isInteger(m) && Number.isInteger(h) && m >= 1 && m <= 99 && h >= 2 && h <= 100 && h > m;
  const dirty = m !== current.medium || h !== current.high;
  return (
    <Card className="mb-4" title={<span className="inline-flex items-center gap-2"><Gauge className="h-4 w-4 text-subtle" /> Thresholds</span>} actions={<Button size="sm" icon={<Save className="h-3.5 w-3.5" />} disabled={!valid || !dirty} loading={saving} onClick={() => onSave({ medium: m, high: h })} data-testid="thresholds-save">Save</Button>} data-testid="thresholds-card">
      <div className="grid grid-cols-1 sm:grid-cols-[160px_160px_1fr] gap-3 items-end">
        <Field label="Medium from" hint="score 0–100">
          <Input type="number" min={1} max={99} value={medium} onChange={(e) => setMedium(e.target.value)} aria-label="Medium from" />
        </Field>
        <Field label="High from" hint="above medium">
          <Input type="number" min={2} max={100} value={high} onChange={(e) => setHigh(e.target.value)} aria-label="High from" />
        </Field>
        <div className="text-[12.5px] text-muted pb-1.5">
          Each answer's score times the question's weight adds up and is scaled to 0–100: below {valid ? m : current.medium} is <Badge color="green">low</Badge>, from {valid ? m : current.medium} <Badge color="amber">medium</Badge>, from {valid ? h : current.high} <Badge color="red">high</Badge>. The level also sets the change's Risk field.
          {!valid && <span className="text-red-700"> High must be above medium, both within 1–100.</span>}
        </div>
      </div>
    </Card>
  );
}

/** The change risk questionnaire: weighted questions whose answers score a change low, medium or high; the search and include-inactive filters live in the URL (`q`, `inactive`). */
export default function ChangeRiskQuestionsPage() {
  const q = useQuery({ queryKey: changeKeys.questions, queryFn: () => changesApi.questions(true) });
  const editor = useEditor<RiskQuestion>();
  const lookups = useLookups();
  const stored = lookups.lookups?.settings?.['changes.risk_thresholds'] as { medium?: number; high?: number } | undefined;
  const thresholds = { medium: Number(stored?.medium ?? 35), high: Number(stored?.high ?? 65) };
  const invalidate = [['changes']];
  const saveThresholds = useAdminMutation((body: { medium: number; high: number }) => changesApi.updateThresholds(body), { invalidate: [['changes'], ['lookups']], success: 'Thresholds saved' });
  const reorder = useAdminMutation((ids: string[]) => changesApi.reorderQuestions(ids), { invalidate });
  const create = useAdminMutation((body: Values) => changesApi.createQuestion(body), { invalidate, success: 'Question added' });
  const update = useAdminMutation(({ id, ...body }: Values & { id: string }) => changesApi.updateQuestion(id, body), { invalidate });
  const remove = useAdminMutation((id: string) => changesApi.deleteQuestion(id), { invalidate, success: 'Question deleted' });
  const rows = useMemo(() => q.data?.items ?? [], [q.data]);
  const f = useConfigFilter(rows, {
    search: [(r) => r.question, (r) => r.key, (r) => r.hint, (r) => r.options.map((o) => o.label)],
    active: (r) => r.isActive,
    noun: ['question', 'questions'],
    searchPlaceholder: 'Search questions, answers',
  });
  // One call with the whole order: the server writes sort_order = position for every id. The
  // row moves past the row shown next to it, so an inactive question hidden from the view keeps its place.
  const move = (r: RiskQuestion, dir: -1 | 1) => {
    const neighbour = f.matching[f.matching.findIndex((x) => x.id === r.id) + dir];
    if (!neighbour) return;
    reorder.mutate(moveBeside(rows.map((x) => x.id), r.id, neighbour.id, dir));
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
    // The arrows wait while a search or a pill narrows the view; Include inactive alone keeps them.
    { key: 'order', header: '', width: '70px', render: (r) => (
      <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" className="px-1" icon={<ArrowUp className="h-3.5 w-3.5" />} aria-label="Move up" disabled={f.narrowed || f.matching[0]?.id === r.id} onClick={() => move(r, -1)} />
        <Button size="sm" variant="ghost" className="px-1" icon={<ArrowDown className="h-3.5 w-3.5" />} aria-label="Move down" disabled={f.narrowed || f.matching[f.matching.length - 1]?.id === r.id} onClick={() => move(r, 1)} />
      </span>
    ) },
    { key: 'question', header: 'Question', render: (r) => <div><div className="font-medium">{r.question}</div><MonoCell>{r.key}</MonoCell></div> },
    { key: 'weight', header: 'Weight', width: '90px', render: (r) => <Badge color="slate">×{r.weight}</Badge> },
    { key: 'options', header: 'Answers', render: (r) => <MutedCell>{r.options.map((o) => `${o.label} (${o.score})`).join(' · ')}</MutedCell> },
    { key: 'isActive', header: 'Status', width: '90px', render: (r) => <ActiveDot active={r.isActive} /> },
  ];
  return (
    <div>
      <SectionHeader title="Change risk questions" description="Weighted questions an implementer answers on the change plan; the answers score the change low, medium or high against the thresholds below. A fresh installation ships six." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={editor.create}>New question</Button>} />
      <ThresholdsCard current={thresholds} onSave={(t) => saveThresholds.mutate(t)} saving={saveThresholds.isPending} />
      <ConfigToolbar {...f.toolbar} />
      <ConfigTable<RiskQuestion>
        columns={columns}
        rows={f.rows}
        pager={f.pager}
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
        onRowClick={editor.edit}
        emptyTitle={f.filtered ? 'No questions match' : 'No risk questions yet'}
        emptyDescription={f.filtered ? 'Try another search, or clear the conditions in the breadcrumb above.' : 'Add the questions an implementer answers before a change is approved.'}
        actions={[
          { label: 'Edit', icon: <Pencil className="h-4 w-4" />, inline: true, onClick: editor.edit },
          { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, danger: true, confirm: (r) => ({ title: `Delete "${r.question}"?`, description: 'Existing assessments keep their score.', confirmLabel: 'Delete' }), onClick: (r) => remove.mutate(r.id) },
        ]}
      />
      <FormDialog<Values> open={editor.open} onClose={editor.close} title={editor.row ? 'Edit question' : 'New risk question'} fields={fields} initial={initial} onSubmit={submit} variant="drawer" width="max-w-2xl" />
    </div>
  );
}
