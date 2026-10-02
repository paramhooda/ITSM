import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Radar, Check, X, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button, Badge } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { aiApi, aiQk, type ChangeImpactResult } from './api';

const RISK_COLOR: Record<ChangeImpactResult['riskLevel'], string> = { low: 'green', medium: 'amber', high: 'red' };

/** Change impact analysis card (ticket context panel, change records only). */
export function ChangeImpactCard({ ticketId, canManage }: { ticketId: string; canManage: boolean }) {
  const [result, setResult] = useState<ChangeImpactResult | null>(null);
  const [decision, setDecision] = useState<'accepted' | 'rejected' | null>(null);
  const status = useQuery({ queryKey: aiQk.status, queryFn: aiApi.status, staleTime: 60_000, retry: false });
  const analyse = useMutation({
    mutationFn: () => aiApi.changeImpact(ticketId),
    onSuccess: (r) => {
      setResult(r);
      setDecision(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const decide = useMutation({
    mutationFn: (s: 'accepted' | 'rejected') => aiApi.decide(result!.suggestionId, s),
    onSuccess: (_d, s) => setDecision(s),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-default">
        <div className="font-semibold text-[13px] inline-flex items-center gap-2"><Radar className="h-4 w-4 text-brand-600" /> Change impact</div>
        <div className="flex items-center gap-2">
          {status.data && !status.data.enabled && <span className="text-[10.5px] text-amber-700 inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> rule-based</span>}
          {canManage && (
            <Button size="sm" variant={result ? 'ghost' : 'secondary'} icon={<RefreshCw className="h-3.5 w-3.5" />} loading={analyse.isPending} onClick={() => analyse.mutate()}>
              {result ? 'Re-analyse' : 'Analyse'}
            </Button>
          )}
        </div>
      </div>
      <div className="p-4 text-[12.5px] space-y-2">
        {!result && !analyse.isPending && <div className="text-muted">{canManage ? 'Affected CIs, downstream dependencies, open tickets and overlapping changes with a risk summary.' : 'Impact analysis requires the changes:manage permission.'}</div>}
        {result && (
          <>
            <div className="flex items-center gap-2">
              <Badge color={RISK_COLOR[result.riskLevel]} dot>Risk: {result.riskLevel}</Badge>
              <span className="text-[11px] text-subtle">{result.aiGenerated ? `Summary by ${status.data?.provider ?? 'AI'}` : 'Rule-based summary'}</span>
            </div>
            <p className="leading-relaxed">{result.riskSummary}</p>
            {result.recommendations.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-subtle font-medium">Recommendations</div>
                <ul className="list-disc pl-4 space-y-0.5">{result.recommendations.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <div className="rounded-md border border-default p-2">
                <div className="text-[11px] uppercase tracking-wide text-subtle font-medium">Affected CIs ({result.affectedCis.length})</div>
                {result.affectedCis.length === 0 && <div className="text-muted">None linked</div>}
                {result.affectedCis.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2">
                    <Link to={`/cmdb/cis/${c.id}`} className="truncate hover:underline">{c.name}</Link>
                    <span className="text-subtle shrink-0">{c.dependents} dep.</span>
                  </div>
                ))}
              </div>
              <div className="rounded-md border border-default p-2">
                <div className="text-[11px] uppercase tracking-wide text-subtle font-medium">Downstream</div>
                <div>{result.downstream.length} dependent CI(s)</div>
                <div className="text-muted truncate" title={result.businessServices.join(', ')}>{result.businessServices.length ? `Services: ${result.businessServices.join(', ')}` : 'No business services affected'}</div>
              </div>
            </div>
            {result.openTickets.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-subtle font-medium">Open tickets on affected items</div>
                <ul className="space-y-0.5">
                  {result.openTickets.slice(0, 6).map((t) => (
                    <li key={t.number} className="flex items-center gap-2 text-[12px]">
                      <Link to={t.link} className="font-mono text-brand-700 hover:underline">{t.number}</Link>
                      <span className="truncate" title={t.title}>{t.title}</span>
                      <Badge color="slate" className="ml-auto shrink-0 py-0">{t.status}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.otherChanges.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-subtle font-medium">Overlapping changes</div>
                <ul className="space-y-0.5">
                  {result.otherChanges.map((c) => (
                    <li key={c.id} className="flex items-center gap-2 text-[12px]">
                      <Link to={c.link} className="font-mono text-brand-700 hover:underline">{c.number}</Link>
                      <span className="truncate" title={c.title}>{c.title}</span>
                      <span className="ml-auto text-subtle shrink-0">{fmtDateTime(c.scheduledStart)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex items-center justify-end gap-1.5 pt-1">
              {decision ? (
                <span className="text-[11.5px] text-subtle">{decision === 'accepted' ? 'Recorded as reviewed' : 'Dismissed'}</span>
              ) : (
                <>
                  <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} loading={decide.isPending} onClick={() => decide.mutate('accepted')}>Reviewed</Button>
                  <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => decide.mutate('rejected')}>Dismiss</Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
