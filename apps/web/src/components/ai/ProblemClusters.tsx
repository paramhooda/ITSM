import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Layers, Copy, Plus, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button, Badge, Select, EmptyState, LoadingBlock, ErrorBlock } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { aiApi, aiQk } from './api';

/**
 * Reusable incident-clustering view (problem management candidates).
 * Mount it on a dashboard or the problems list; it needs no props.
 */
export function ProblemClusters({ customerId, defaultDays = 30, compact = false }: { customerId?: string; defaultDays?: number; compact?: boolean }) {
  const [days, setDays] = useState(defaultDays);
  const [minCount, setMinCount] = useState(3);
  const params = { days, minCount, customerId };
  const q = useQuery({ queryKey: aiQk.clusters(params), queryFn: () => aiApi.problemClusters(params), staleTime: 5 * 60_000, retry: false });

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-default flex-wrap">
        <div className="font-semibold text-[13px] inline-flex items-center gap-2"><Layers className="h-4 w-4 text-brand-600" /> Problem candidates</div>
        <div className="flex items-center gap-2">
          {q.data && !q.data.aiGenerated && <span className="text-[10.5px] text-subtle inline-flex items-center gap-1" title="Cluster titles are generated from common terms; configure an AI provider for better names"><AlertTriangle className="h-3 w-3" /> rule-based titles</span>}
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="h-7 py-0 text-[12px] w-28" options={[7, 14, 30, 60, 90].map((d) => ({ value: String(d), label: `Last ${d} days` }))} />
          <Select value={String(minCount)} onChange={(e) => setMinCount(Number(e.target.value))} className="h-7 py-0 text-[12px] w-24" options={[2, 3, 5, 10].map((n) => ({ value: String(n), label: `≥ ${n}` }))} />
          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={q.isFetching} onClick={() => q.refetch()}>Refresh</Button>
        </div>
      </div>
      <div className={compact ? 'p-3' : 'p-4'}>
        {q.isLoading ? (
          <LoadingBlock label="Clustering incidents…" />
        ) : q.isError ? (
          <ErrorBlock error={q.error} retry={() => q.refetch()} />
        ) : !q.data?.clusters.length ? (
          <EmptyState title="No recurring incident clusters" description={`${q.data?.totalIncidents ?? 0} incidents without a problem record in the last ${days} days; none repeat at least ${minCount} times.`} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {q.data.clusters.map((c) => (
              <div key={c.key} className="rounded-lg border border-default p-3 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium leading-snug">{c.suggestedTitle}</div>
                    <div className="text-[11.5px] text-muted truncate">{c.customerName}{c.categoryLabel ? ` · ${c.categoryLabel}` : ''}{c.ciName ? ` · ${c.ciName}` : ''}{c.serviceName ? ` · ${c.serviceName}` : ''}</div>
                  </div>
                  <Badge color={c.count >= 10 ? 'red' : c.count >= 5 ? 'amber' : 'slate'} className="shrink-0">{c.count} incidents</Badge>
                </div>
                <div className="text-[11.5px] text-subtle">{c.openCount} open · first {relativeTime(c.firstAt)} · last {relativeTime(c.lastAt)}{c.commonTerms.length ? ` · terms: ${c.commonTerms.join(', ')}` : ''}</div>
                <ul className="text-[12px] space-y-0.5">
                  {c.sampleTickets.map((t) => (
                    <li key={t.id} className="flex items-center gap-2">
                      <Link to={t.link} className="font-mono text-brand-700 dark:text-brand-300 hover:underline shrink-0">{t.number}</Link>
                      <span className="truncate" title={t.title}>{t.title}</span>
                      <span className="ml-auto text-subtle shrink-0">{t.status}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center gap-1.5 mt-auto">
                  <Link to={`/tickets/new?type=problem&customerId=${c.customerId}`}>
                    <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />}>Create problem</Button>
                  </Link>
                  <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => navigator.clipboard?.writeText(`${c.suggestedTitle}\n\nRelated incidents: ${c.sampleTickets.map((t) => t.number).join(', ')}`).then(() => toast.success('Title and incident list copied'))}>Copy</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
