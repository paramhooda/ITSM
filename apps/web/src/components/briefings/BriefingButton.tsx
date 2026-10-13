import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useUiStore } from '@/stores/ui';
import { GradyAvatar } from '@/components/grady/GradyAvatar';
import { relativeTime } from '@/lib/format';
import { portalApi, pk } from '@/components/portal/api';
import { briefingsApi, briefingKeys, type BriefingToday } from './api';
import { BriefingPanel } from './BriefingPanel';

/**
 * The daily brief's door in the top bar of both shells: the AI mark in the
 * bell's icon-button style, a dot while today's brief has not been opened in
 * this browser, and the panel it opens. Generating on request lives here with
 * its toasts; the email's `/?briefing=<day>` link opens the panel once and
 * strips the key. `audience` says which shell renders it: the portal reads the
 * organisation's name for the panel title.
 */
export function BriefingButton({ audience = 'staff' }: { audience?: 'staff' | 'portal' }) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const seenId = useUiStore((s) => s.briefingSeenId);
  const setSeenId = useUiStore((s) => s.setBriefingSeenId);
  const q = useQuery({ queryKey: briefingKeys.today, queryFn: briefingsApi.today, staleTime: 60_000, refetchInterval: 5 * 60_000 });
  const me = useQuery({ queryKey: pk.me, queryFn: portalApi.me, staleTime: 5 * 60_000, enabled: audience === 'portal' });
  const refetch = q.refetch;
  // opening the panel re-reads today's brief and its usage, so the cap and the cooldown shown are never stale
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);
  // the email link lands on /?briefing=<day>: open the panel once and drop the key from the address
  useEffect(() => {
    if (params.get('briefing') && q.data) {
      setOpen(true);
      params.delete('briefing');
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.day, params.get('briefing')]);
  const generate = useMutation({
    mutationFn: () => briefingsApi.generate(),
    onSuccess: (res) => {
      qc.setQueryData(briefingKeys.today, (prev: BriefingToday | undefined) => (prev ? { ...prev, briefing: res.briefing, usage: res.usage } : prev));
      void qc.invalidateQueries({ queryKey: briefingKeys.today });
      setOpen(true);
      if (res.reused) toast.message(res.reason === 'limit' ? `Today's cap on briefs is reached; showing the one from ${relativeTime(res.briefing.generatedAt)}` : `Your brief from ${relativeTime(res.briefing.generatedAt)} is still fresh`);
      else toast.success(res.briefing.ai ? 'Grady wrote your brief' : 'Your brief is ready');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const briefing = q.data?.briefing ?? null;
  const unseen = !!briefing && seenId !== briefing.id;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative h-9 w-9 rounded-lg text-muted hover:bg-surface-2 hover:text-default flex items-center justify-center"
        title="Your daily brief"
        aria-label="Your daily brief"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="briefing-button"
      >
        <GradyAvatar size={22} decorative />
        {unseen && <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-brand-600 ring-2 ring-white" data-testid="briefing-dot" aria-hidden />}
      </button>
      <BriefingPanel
        open={open}
        onClose={() => setOpen(false)}
        data={q.data}
        error={q.isError ? q.error : undefined}
        retry={() => q.refetch()}
        onGenerate={() => generate.mutate()}
        generating={generate.isPending}
        organisation={audience === 'portal' ? me.data?.customer.name ?? null : null}
        onSeen={setSeenId}
      />
    </>
  );
}
