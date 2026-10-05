import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button, ConfirmDialog, Textarea } from '@/components/ui';
import { ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { aiApi, aiQk } from '@/components/ai/api';
import { reportsApi } from '../api';
import type { DefinitionInput, SuggestResult } from '../types';

/**
 * "Describe it": one sentence becomes a draft definition through the assistant
 * (or a basic layout when the assistant is off). Shown only to people who may
 * use the assistant while the report_builder feature is on.
 */
export function DescribeBox({ entity, dirty, onFill }: { entity?: string; dirty: boolean; onFill: (def: Partial<DefinitionInput>, ai: boolean) => void }) {
  const can = useAuthStore((s) => s.can);
  const status = useQuery({ queryKey: aiQk.status, queryFn: aiApi.status, staleTime: 60_000, retry: false, enabled: can('ai:use') });
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState<SuggestResult | null>(null);
  const suggest = useMutation({
    mutationFn: () => reportsApi.suggest({ prompt: prompt.trim(), ...(entity ? { entity } : {}) }),
    onSuccess: (r) => {
      if (dirty) setPending(r);
      else apply(r);
    },
    onError: (e: ApiError) => toast.error(e.message),
  });
  const apply = (r: SuggestResult) => {
    onFill(r.definition, r.ai);
    setPending(null);
    toast.success(r.ai ? 'Filled from your description' : 'Filled with a basic layout (assistant unavailable)');
  };
  if (!can('ai:use') || !status.data?.enabled || !status.data.features.includes('report_builder')) return null;
  return (
    <div className="card p-3 flex flex-col sm:flex-row gap-2 sm:items-end" data-describe-box>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-secondary mb-1 inline-flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5 text-brand-600" /> Describe it</div>
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={600} placeholder="P1 and P2 incidents by customer for the last quarter" className="min-h-[44px]" aria-label="Describe the report" />
      </div>
      <Button variant="outline" loading={suggest.isPending} disabled={prompt.trim().length < 3} onClick={() => suggest.mutate()}>Suggest</Button>
      <ConfirmDialog open={!!pending} onClose={() => setPending(null)} onConfirm={() => pending && apply(pending)} title="Replace the current configuration?" description="The suggestion replaces the entity, columns, filters, grouping and period you have set so far. Nothing is saved until you press Save." confirmLabel="Replace" />
    </div>
  );
}
