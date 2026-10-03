import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, RefreshCw, Settings2, ChevronDown, ChevronUp } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { briefingsApi, briefingKeys } from '@/components/briefings/api';

const md = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (href?.startsWith('/') ? <Link to={href} className="text-brand-700 hover:underline">{children}</Link> : <a href={href} className="text-brand-700 hover:underline" target="_blank" rel="noreferrer">{children}</a>),
  h2: ({ children }: { children?: ReactNode }) => <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mt-4 mb-1">{children}</div>,
  ul: ({ children }: { children?: ReactNode }) => <ul className="flex flex-col gap-1 pl-4 list-disc">{children}</ul>,
  li: ({ children }: { children?: ReactNode }) => <li className="text-[13px] leading-relaxed">{children}</li>,
  p: ({ children }: { children?: ReactNode }) => <p className="text-[13px] leading-relaxed my-1">{children}</p>,
};

/**
 * The morning briefing on the staff home: today's text when it exists, a one-click
 * generation otherwise, and a nudge to turn on the daily delivery.
 */
export function BriefingCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: briefingKeys.today, queryFn: briefingsApi.today, staleTime: 60_000 });
  const [expanded, setExpanded] = useState(false);
  const generate = useMutation({
    mutationFn: () => briefingsApi.generate(),
    onSuccess: (b) => {
      qc.setQueryData(briefingKeys.today, (prev: Awaited<ReturnType<typeof briefingsApi.today>> | undefined) => (prev ? { ...prev, briefing: b } : prev));
      void qc.invalidateQueries({ queryKey: briefingKeys.today });
      setExpanded(true);
      toast.success(b.ai ? 'Grady wrote your briefing' : 'Your briefing is ready');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (q.isError || q.isPending) return null;
  const { briefing, prefs, day } = q.data;
  if (!briefing) {
    return (
      <div className="card p-4 mb-4 flex flex-wrap items-center gap-3" data-testid="briefing-card">
        <Sparkles className="h-4 w-4 text-brand-600 shrink-0" />
        <div className="min-w-0 flex-1 text-[13px]">
          <span className="font-medium">No briefing yet for {day}.</span>{' '}
          <span className="text-muted">{prefs.enabled ? `It arrives at ${prefs.time} in your timezone; you can also have it now.` : 'Get what matters for your role each morning: turn on the daily briefing in your profile, or read one now.'}</span>
        </div>
        <Button size="sm" variant="outline" icon={<Sparkles className="h-3.5 w-3.5" />} loading={generate.isPending} onClick={() => generate.mutate()}>Brief me now</Button>
        {!prefs.enabled && <Link to="/profile" className="text-[12.5px] text-brand-700 hover:underline inline-flex items-center gap-1"><Settings2 className="h-3.5 w-3.5" /> Daily delivery</Link>}
      </div>
    );
  }
  const lines = briefing.text.split('\n');
  const cut = lines.findIndex((l, i) => i > 0 && l.startsWith('## '));
  const shown = expanded || cut === -1 ? briefing.text : lines.slice(0, cut).join('\n');
  return (
    <div className="card p-4 mb-4" data-testid="briefing-card">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <Sparkles className="h-4 w-4 text-brand-600" />
        <span className="font-semibold text-[14px]">Your {briefing.roleLabel.toLowerCase()} briefing</span>
        <span className="text-[12px] text-subtle">· {briefing.day} · generated {relativeTime(briefing.generatedAt)}</span>
        <Badge color={briefing.ai ? 'violet' : 'slate'}>{briefing.ai ? 'Grady' : 'from the facts'}</Badge>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={generate.isPending} onClick={() => generate.mutate()}>Refresh</Button>
          <Link to="/profile" className="text-[12.5px] text-brand-700 hover:underline inline-flex items-center gap-1"><Settings2 className="h-3.5 w-3.5" /> {prefs.enabled ? `Daily at ${prefs.time}` : 'Daily delivery'}</Link>
        </div>
      </div>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{shown}</ReactMarkdown>
      {cut !== -1 && (
        <button type="button" className="mt-2 inline-flex items-center gap-1 text-[12.5px] text-brand-700 hover:underline" onClick={() => setExpanded((v) => !v)}>
          {expanded ? <><ChevronUp className="h-3.5 w-3.5" /> Show less</> : <><ChevronDown className="h-3.5 w-3.5" /> Read the whole briefing</>}
        </button>
      )}
    </div>
  );
}
