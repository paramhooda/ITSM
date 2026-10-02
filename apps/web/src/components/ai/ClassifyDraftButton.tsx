import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles, Check, X } from 'lucide-react';
import { Button, ProgressBar } from '@/components/ui';
import { aiApi, type DraftClassification } from './api';

/**
 * "Suggest category & priority" for the ticket create form. Calls
 * POST /ai/classify-draft with the typed title/description and offers to
 * apply the proposal; nothing is applied automatically.
 */
export function ClassifyDraftButton({ title, description, customerId, type, onApply }: { title: string; description: string; customerId?: string; type?: string; onApply: (r: DraftClassification) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const suggest = useMutation({
    mutationFn: () => aiApi.classifyDraft({ title: title.trim(), description: description.trim() || null, customerId: customerId || undefined, type }),
    onSuccess: () => setOpen(true),
    onError: (e: Error) => toast.error(e.message),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const r = suggest.data;
  const rows: [string, string | null][] = r ? [['Category', r.labels.category], ['Subcategory', r.labels.subcategory], ['Impact', r.labels.impact], ['Urgency', r.labels.urgency], ['Priority', r.labels.priority]] : [];

  return (
    <div className="relative" ref={ref}>
      <Button size="sm" variant="ghost" icon={<Sparkles className="h-3.5 w-3.5" />} loading={suggest.isPending} disabled={title.trim().length < 3} title={title.trim().length < 3 ? 'Enter a title first' : 'Suggest category, impact, urgency and priority from the title and description'} onClick={() => (r && !open ? setOpen(true) : suggest.mutate())}>
        Suggest category & priority
      </Button>
      {open && r && (
        <div className="absolute right-0 top-9 z-30 w-80 rounded-lg border border-default bg-surface shadow-lg p-3 text-[12.5px] space-y-2">
          <div className="grid grid-cols-[88px_1fr] gap-x-2 gap-y-1">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <span className="text-[11px] uppercase tracking-wide text-subtle font-medium">{label}</span>
                <span className={value ? '' : 'text-subtle'}>{value ?? '—'}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 text-[11.5px] text-muted">
            <span>Confidence</span>
            <div className="flex-1"><ProgressBar pct={r.confidence} tone={r.confidence >= 70 ? 'good' : r.confidence >= 40 ? 'warn' : 'bad'} /></div>
            <span>{r.confidence}%</span>
          </div>
          <div className="text-[12px] text-muted">{r.rationale}</div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-subtle">{r.aiGenerated ? 'AI suggestion' : 'Rule-based suggestion'}</span>
            <div className="flex items-center gap-1.5">
              <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} onClick={() => { onApply(r); setOpen(false); toast.success('Classification applied to the form'); }}>Apply</Button>
              <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => setOpen(false)}>Dismiss</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
