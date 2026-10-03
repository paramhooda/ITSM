import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, RefreshCw, Sparkles } from 'lucide-react';
import { Dialog, Button, LoadingBlock, ErrorBlock } from '@/components/ui';
import { aiApi, type SummaryResult } from './api';

/** A handover summary of the ticket (summary, key facts, next steps) ready to copy into a note or a message. */
export function HandoverSummaryDialog({ open, onClose, ticketId, ticketNumber }: { open: boolean; onClose: () => void; ticketId: string; ticketNumber: string }) {
  const [result, setResult] = useState<SummaryResult | null>(null);
  const run = useMutation({ mutationFn: () => aiApi.summarize(ticketId), onSuccess: (r) => setResult(r) });
  useEffect(() => {
    if (open) {
      setResult(null);
      run.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ticketId]);
  const text = result ? [`${ticketNumber} handover`, '', result.summary, '', 'Key facts:', ...result.keyFacts.map((f) => `- ${f}`), '', 'Next steps:', ...result.nextSteps.map((s) => `- ${s}`)].join('\n') : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy; select the text instead');
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Handover summary for ${ticketNumber}`} width="max-w-2xl" footer={<><Button variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => run.mutate()} loading={run.isPending}>Regenerate</Button><Button variant="outline" onClick={onClose}>Close</Button><Button icon={<Copy className="h-3.5 w-3.5" />} onClick={copy} disabled={!result}>Copy</Button></>}>
      {run.isPending && !result && <LoadingBlock label="Reading the ticket…" />}
      {run.isError && <ErrorBlock error={run.error} retry={() => run.mutate()} />}
      {result && (
        <div className="flex flex-col gap-3 text-[13px]">
          <p className="leading-relaxed">{result.summary}</p>
          {result.keyFacts.length > 0 && (
            <div>
              <div className="text-[11.5px] font-semibold uppercase tracking-wide text-subtle mb-1">Key facts</div>
              <ul className="list-disc pl-5 flex flex-col gap-0.5">{result.keyFacts.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </div>
          )}
          {result.nextSteps.length > 0 && (
            <div>
              <div className="text-[11.5px] font-semibold uppercase tracking-wide text-subtle mb-1">Next steps</div>
              <ul className="list-disc pl-5 flex flex-col gap-0.5">{result.nextSteps.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
          <p className="text-[12px] text-subtle inline-flex items-center gap-1"><Sparkles className="h-3 w-3" /> {result.aiGenerated ? 'Written by Grady from the ticket and its timeline; check it before you hand over.' : 'Assembled from the ticket fields (the AI provider is not configured).'}</p>
        </div>
      )}
    </Dialog>
  );
}
