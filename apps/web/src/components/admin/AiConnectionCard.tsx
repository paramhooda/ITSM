import { useMutation, useQuery } from '@tanstack/react-query';
import { PlugZap, CheckCircle2, AlertTriangle, Sparkles } from 'lucide-react';
import { Button, Card, Badge } from '@/components/ui';
import { aiApi, aiQk, type AiTestResult } from '@/components/ai/api';
import { errorMessage } from '@/components/admin/api';
import { cn } from '@/lib/utils';

/** The provider connection as the deployment configured it, with a one-line round trip to verify it. */
export function AiConnectionCard({ canTest, embedded }: { canTest: boolean; embedded?: boolean }) {
  const status = useQuery({ queryKey: aiQk.status, queryFn: aiApi.status, staleTime: 60_000, retry: false });
  const test = useMutation({ mutationFn: aiApi.test });
  const c = status.data?.configured;
  const result: AiTestResult | undefined = test.data;
  const body = (
    <div className={cn('flex flex-col gap-3', embedded ? 'px-4 py-3 border-b border-default bg-app' : 'p-5')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium flex items-center gap-2"><Sparkles className="h-4 w-4 text-subtle" /> Assistant connection</div>
          <div className="text-[12px] text-muted mt-0.5">Set in the deployment environment (AI_PROVIDER, AI_MODEL, OPENAI_COMPATIBLE_BASE_URL, keys). Restart the app after changing it.</div>
        </div>
        <Button size="sm" variant="outline" icon={<PlugZap className="h-4 w-4" />} loading={test.isPending} disabled={!canTest} title={canTest ? 'Send a one-line prompt to the provider' : 'Requires admin:system or admin:config'} onClick={() => test.mutate()}>
          Test connection
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-[12.5px]">
        <div><div className="text-muted">Provider</div><div className="font-medium flex items-center gap-1.5 mt-0.5">{c?.provider ?? '…'}{status.data && (status.data.enabled ? <Badge color="green">enabled</Badge> : <Badge color="gray">disabled</Badge>)}</div></div>
        <div><div className="text-muted">Model</div><div className="font-mono mt-0.5">{c?.model ?? '—'}</div></div>
        <div className="min-w-0"><div className="text-muted">Endpoint</div><div className="font-mono mt-0.5 truncate" title={c?.baseUrl ?? undefined}>{c?.baseUrl ?? '—'}</div></div>
        <div><div className="text-muted">Prompt version</div><div className="font-mono mt-0.5">{status.data?.promptVersion ?? '—'}</div></div>
      </div>
      {test.isError && <div className="rounded-lg border border-red-200/70 bg-red-50 text-red-700 px-3 py-2 text-[12.5px]">{errorMessage(test.error)}</div>}
      {result && result.ok && (
        <div className="rounded-lg border border-emerald-200/70 bg-emerald-50 text-emerald-800 px-3 py-2 text-[12.5px] flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 mt-px shrink-0" />
          <div>Connected to <span className="font-mono">{result.model}</span> in {result.latencyMs} ms{result.reply ? <> · reply “{result.reply}”</> : null}{result.usage ? <span className="text-emerald-700/80"> · {result.usage.inputTokens + result.usage.outputTokens} tokens</span> : null}</div>
        </div>
      )}
      {result && !result.ok && result.error && (
        <div className="rounded-lg border border-red-200/70 bg-red-50 text-red-700 px-3 py-2 text-[12.5px] flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-px shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">{result.error.code === 'ai_disabled' ? 'Assistant not configured' : `Provider returned HTTP ${result.error.status}`}{result.latencyMs ? <span className="font-normal text-red-600/80"> · {result.latencyMs} ms</span> : null}</div>
            <div className="mt-0.5 break-words">{result.error.message}</div>
            {result.error.code === 'ai_upstream' && <div className="mt-1 text-red-600/80">Typical fixes: a model id the endpoint serves (AI_MODEL), the API base URL ending in /v1 for OpenAI, or the right key. See docs/OPERATIONS.md → AI assistant troubleshooting.</div>}
          </div>
        </div>
      )}
    </div>
  );
  if (embedded) return body;
  return <Card padded={false}>{body}</Card>;
}
