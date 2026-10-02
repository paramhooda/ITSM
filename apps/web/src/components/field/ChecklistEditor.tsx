import { Plus, Trash2, GripVertical } from 'lucide-react';
import { Button, Checkbox, Input } from '@/components/ui';

export interface ChecklistDraft {
  item: string;
  required?: boolean;
}

/** Compact editor for checklist definitions (visit templates and PM programs): item text + required flag. */
export function ChecklistEditor({ value, onChange, placeholder = 'Checklist item' }: { value: ChecklistDraft[]; onChange: (v: ChecklistDraft[]) => void; placeholder?: string }) {
  const update = (i: number, patch: Partial<ChecklistDraft>) => onChange(value.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const add = () => onChange([...value, { item: '', required: false }]);
  return (
    <div className="flex flex-col gap-1.5">
      {value.length === 0 && <div className="text-[12.5px] text-subtle">No checklist items yet.</div>}
      {value.map((it, i) => (
        <div key={i} className="flex items-center gap-2">
          <GripVertical className="h-3.5 w-3.5 text-subtle shrink-0" />
          <Input
            value={it.item}
            placeholder={placeholder}
            className="h-8 py-0 text-[13px]"
            onChange={(e) => update(i, { item: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <Checkbox checked={!!it.required} onChange={(e) => update(i, { required: e.target.checked })} label={<span className="text-[12px] text-muted whitespace-nowrap">Required</span>} />
          <button type="button" onClick={() => remove(i)} className="text-subtle hover:text-red-600" aria-label="Remove item">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div>
        <Button type="button" variant="ghost" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={add}>
          Add item
        </Button>
      </div>
    </div>
  );
}
