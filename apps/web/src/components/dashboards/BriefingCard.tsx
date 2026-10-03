import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, RefreshCw, Settings2, BookOpen } from 'lucide-react';
import { Badge, Button, Dialog } from '@/components/ui';
import { relativeTime, fmtDateTime } from '@/lib/format';
import { briefingsApi, briefingKeys, type Briefing, type BriefingUsage } from '@/components/briefings/api';

const md = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (href?.startsWith('/') ? <Link to={href} className="text-brand-700 hover:underline">{children}</Link> : <a href={href} className="text-brand-700 hover:underline" target="_blank" rel="noreferrer">{children}</a>),
  h2: ({ children }: { children?: ReactNode }) => <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mt-4 mb-1">{children}</div>,
  ul: ({ children }: { children?: ReactNode }) => <ul className="flex flex-col gap-1 pl-4 list-disc">{children}</ul>,
  li: ({ children }: { children?: ReactNode }) => <li className="text-[13px] leading-relaxed">{children}</li>,
  p: ({ children }: { children?: ReactNode }) => <p className="text-[13px] leading-relaxed my-1">{children}</p>,
};

/** Why the refresh button is off, in words: the daily cap or the cooldown. */
export function refreshHint(usage: BriefingUsage | undefined): string | null {
  if (!usage) return null;
  if (usage.exhausted) return `You have used today's ${usage.maxPerDay} briefing${usage.maxPerDay === 1 ? '' : 's'}; the next one comes tomorrow.`;
  if (usage.cooling && usage.nextAllowedAt) return `Refresh again from ${fmtDateTime(usage.nextAllowedAt)}${usage.remaining !== null ? ` (${usage.remaining} left today)` : ''}.`;
  return usage.remaining !== null ? `${usage.remaining} refresh${usage.remaining === 1 ? '' : 'es'} left today.` : null;
}

/**
 * The morning briefing on the staff home: a one-line card that opens the briefing in a dialog,
 * generates one on request, and keeps the daily cap and the cooldown visible.
 */
export function BriefingCard() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: briefingKeys.today, queryFn: briefingsApi.today, staleTime: 60_000 });
  const [open, setOpen] = useState(false);
  // the email link lands on /?briefing=<day>: open the dialog once
  useEffect(() => {
    if (params.get('briefing') && q.data?.briefing) {
      setOpen(true);
      params.delete('briefing');
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.briefing?.id]);
  const generate = useMutation({
    mutationFn: () => briefingsApi.generate(),
    onSuccess: (res) => {
      qc.setQueryData(briefingKeys.today, (prev: Awaited<ReturnType<typeof briefingsApi.today>> | undefined) => (prev ? { ...prev, briefing: res.briefing, usage: res.usage } : prev));
      void qc.invalidateQueries({ queryKey: briefingKeys.today });
      setOpen(true);
      if (res.reused) toast.message(res.reason === 'limit' ? `Today's briefing cap is reached; showing the one from ${relativeTime(res.briefing.generatedAt)}` : `Your briefing from ${relativeTime(res.briefing.generatedAt)} is still fresh`);
      else toast.success(res.briefing.ai ? 'Grady wrote your briefing' : 'Your briefing is ready');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (q.isError || q.isPending) return null;
  const { briefing, prefs, day, usage } = q.data;
  const hint = refreshHint(usage);
  const blocked = usage.exhausted;
  const headline = briefing?.facts?.headline[0] ?? briefing?.text.split('\n').find((l) => l.startsWith('- '))?.replace(/^- /, '') ?? null;
  return (
    <>
      <div className="card p-4 mb-4 flex flex-wrap items-center gap-3" data-testid="briefing-card">
        <Sparkles className="h-4 w-4 text-brand-600 shrink-0" />
        <div className="min-w-0 flex-1 text-[13px]">
          {briefing ? (
            <>
              <span className="font-medium">Your {briefing.roleLabel.toLowerCase()} briefing for {day}</span>
              <span className="text-subtle"> · {relativeTime(briefing.generatedAt)}</span>
              {headline && <span className="text-muted"> — {headline}</span>}
            </>
          ) : (
            <>
              <span className="font-medium">No briefing yet for {day}.</span>{' '}
              <span className="text-muted">{prefs.enabled ? `It arrives at ${prefs.time} in your timezone; you can also have it now.` : 'Get what matters for your role each morning: turn on the daily briefing in your profile, or read one now.'}</span>
            </>
          )}
        </div>
        {briefing ? (
          <Button size="sm" icon={<BookOpen className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>Open briefing</Button>
        ) : (
          <Button size="sm" variant="outline" icon={<Sparkles className="h-3.5 w-3.5" />} loading={generate.isPending} disabled={blocked} title={hint ?? undefined} onClick={() => generate.mutate()}>Brief me now</Button>
        )}
        {!prefs.enabled && <Link to="/profile" className="text-[12.5px] text-brand-700 hover:underline inline-flex items-center gap-1"><Settings2 className="h-3.5 w-3.5" /> Daily delivery</Link>}
      </div>
      <BriefingDialog open={open && !!briefing} onClose={() => setOpen(false)} briefing={briefing} usage={usage} prefsLabel={prefs.enabled ? `Daily at ${prefs.time}` : 'Daily delivery'} onRefresh={() => generate.mutate()} refreshing={generate.isPending} />
    </>
  );
}

function BriefingDialog({ open, onClose, briefing, usage, prefsLabel, onRefresh, refreshing }: { open: boolean; onClose: () => void; briefing: Briefing | null; usage: BriefingUsage; prefsLabel: string; onRefresh: () => void; refreshing: boolean }) {
  const hint = refreshHint(usage);
  const blocked = usage.exhausted || usage.cooling;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={
        briefing ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand-600" />
            <span>Your {briefing.roleLabel.toLowerCase()} briefing</span>
            <span className="text-[12px] font-normal text-subtle">· {briefing.day} · generated {relativeTime(briefing.generatedAt)}</span>
            <Badge color={briefing.ai ? 'violet' : 'slate'}>{briefing.ai ? 'Grady' : 'from the facts'}</Badge>
          </span>
        ) : null
      }
      footer={
        <div className="flex flex-wrap items-center gap-2 w-full">
          <span className="text-[12px] text-subtle">{hint}</span>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/profile" className="text-[12.5px] text-brand-700 hover:underline inline-flex items-center gap-1"><Settings2 className="h-3.5 w-3.5" /> {prefsLabel}</Link>
            <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={refreshing} disabled={blocked} title={hint ?? undefined} onClick={onRefresh}>Refresh</Button>
            <Button size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
      }
    >
      {briefing && (
        <div className="max-h-[65vh] overflow-y-auto pr-1" data-testid="briefing-dialog">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{briefing.text}</ReactMarkdown>
        </div>
      )}
    </Dialog>
  );
}
