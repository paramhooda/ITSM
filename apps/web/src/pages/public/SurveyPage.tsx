import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MessageSquareHeart, Link2Off, Clock, CheckCircle2 } from 'lucide-react';
import { PageHeader, EmptyState, LoadingBlock } from '@/components/ui';
import { BrandLogo } from '@/layouts/AppShell';
import { fmtDate } from '@/lib/format';
import { fetchPublicSurvey, submitPublicRating, submitPublicComment, type PublicSurvey } from '@/components/surveys/api';
import { SurveyCard } from '@/components/surveys/SurveyCard';
import { RatingStars } from '@/components/surveys/RatingStars';

/**
 * The satisfaction survey behind the email link: no sign-in, the respondent's own ticket number and title only.
 * `?rating=N` from a one-click button is recorded by a POST once the page has loaded, so link scanners that
 * merely fetch the page never record a rating. Rendered outside both shells.
 */
export default function SurveyPage() {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const preset = Number(params.get('rating'));
  const initialRating = preset >= 1 && preset <= 5 ? preset : null;
  const q = useQuery({ queryKey: ['public', 'survey', token], queryFn: () => fetchPublicSurvey(token), retry: false, enabled: !!token, staleTime: Infinity });
  const [view, setView] = useState<PublicSurvey | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // The one-click link's automatic post: the card waits for it, and is released again when it fails.
  const [autoBusy, setAutoBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const autoSent = useRef(false);
  const d = view === undefined ? q.data : view;

  const apply = (outcome: Awaited<ReturnType<typeof submitPublicRating>>, base: PublicSurvey, comment?: boolean) => {
    if (outcome.ok) {
      setView({ ...base, status: 'answered', rating: outcome.rating ?? base.rating, hasComment: outcome.hasComment || !!comment, answeredAt: base.answeredAt ?? new Date().toISOString() });
      setNotice({ tone: 'good', text: comment ? 'Thank you, your comment was sent to the service desk.' : 'Thanks, your rating is saved.' });
    } else if (outcome.error === 'retry') {
      // A transient failure: the survey is still open, so the card keeps its state and the person can try again.
      setNotice({ tone: 'bad', text: outcome.message });
    } else {
      setView({ ...base, status: outcome.error === 'gone' ? 'expired' : outcome.error === 'conflict' ? 'answered' : 'cancelled' });
      setNotice({ tone: 'bad', text: outcome.message });
    }
  };
  const rate = async (rating: number, comment: string | null) => {
    if (!d) return;
    setBusy(true);
    try {
      const out = await submitPublicRating(token, rating);
      if (out.ok && comment) {
        const c = await submitPublicComment(token, comment);
        apply(c.ok ? { ...out, hasComment: true } : out, d, c.ok);
      } else apply(out, d);
    } finally {
      setBusy(false);
    }
  };
  const addComment = async (comment: string) => {
    if (!d) return;
    setBusy(true);
    try {
      apply(await submitPublicComment(token, comment), d, true);
    } finally {
      setBusy(false);
    }
  };

  // The one-click link: record the preset rating once the survey is known to be open.
  useEffect(() => {
    if (!initialRating || autoSent.current || !q.data || q.data.status !== 'pending') return;
    autoSent.current = true;
    setAutoBusy(true);
    rate(initialRating, null)
      .catch(() => setNotice({ tone: 'bad', text: 'Your rating could not be saved just now. Pick a star and press Send to try again.' }))
      .finally(() => setAutoBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRating, q.data]);

  return (
    <div className="min-h-full bg-app">
      <header className="h-14 flex items-center gap-3 px-4 md:px-6 border-b border-default bg-surface">
        <BrandLogo />
        <span className="text-[13px] text-muted inline-flex items-center gap-1"><MessageSquareHeart className="h-3.5 w-3.5" /> Customer satisfaction</span>
      </header>
      <main className="p-5 md:p-7 max-w-[720px] mx-auto flex flex-col gap-5">
        {q.isLoading && <LoadingBlock label="Opening your survey…" />}
        {!q.isLoading && !d && (
          <>
            <PageHeader title="Satisfaction survey" />
            <EmptyState icon={<Link2Off className="h-5 w-5" />} title="This link is not valid" description="The survey link may have been withdrawn or mistyped. If you still want to rate the ticket, open it in the portal or reply to the service desk." />
          </>
        )}
        {d && (
          <>
            <PageHeader title={d.status === 'answered' ? 'Thank you' : 'How did we do?'} subtitle={`${d.ticket.number} · ${d.ticket.title}`} />
            {notice && (
              <div className={notice.tone === 'good' ? 'rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-3 text-[13px] inline-flex items-center gap-2' : 'rounded-xl border border-amber-200 bg-amber-50 text-amber-900 px-4 py-3 text-[13px] inline-flex items-center gap-2'} role="status">
                {notice.tone === 'good' ? <CheckCircle2 className="h-4 w-4" /> : <Clock className="h-4 w-4" />} {notice.text}
              </div>
            )}
            {d.status === 'answered' && !notice && (
              <div className="card p-5 flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <RatingStars value={d.rating} size="lg" readOnly />
                  <div className="text-[14px]">This ticket was rated {d.rating}/5{d.answeredAt ? ` on ${fmtDate(d.answeredAt)}` : ''}.</div>
                </div>
                <div className="text-[13px] text-muted">A ticket can be rated once. Thank you for telling us how we did.</div>
              </div>
            )}
            {(d.status !== 'answered' || notice) && (
              <SurveyCard
                title={d.status === 'answered' ? 'Your rating' : 'How did we do?'}
                question={d.question}
                commentPrompt={d.commentPrompt}
                state={{ status: d.status, rating: d.rating, hasComment: d.hasComment, answeredAt: d.answeredAt, expiresAt: d.expiresAt }}
                onRate={rate}
                onComment={addComment}
                busy={busy || autoBusy}
                initialRating={initialRating}
                footer={d.status === 'pending' ? 'One answer per ticket. Nothing on this page identifies anyone but you.' : undefined}
              />
            )}
            {d.hasPortal && d.portalLink && (
              <div className="text-[13px] text-muted">
                Signed in users can also <a href={d.portalLink} className="text-brand-700 hover:underline">open the ticket in the portal</a>.
              </div>
            )}
            <div className="text-[11.5px] text-subtle text-center">Sent by your service desk. For anything else, reply to the ticket.</div>
          </>
        )}
      </main>
    </div>
  );
}
