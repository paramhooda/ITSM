import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, Clock, MessageSquareHeart } from 'lucide-react';
import { Button, Card, Field, Textarea } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { RatingStars } from './RatingStars';
import { RATING_LABELS } from './api';

export interface SurveyCardState {
  status: 'pending' | 'none' | 'answered' | 'expired' | 'cancelled';
  rating: number | null;
  comment?: string | null;
  /** The public page never carries the comment text, only whether one exists. */
  hasComment?: boolean;
  answeredAt: string | null;
  expiresAt?: string | null;
}

/**
 * "How did we do?": the question, five stars, an optional comment and one Send button; then the thank-you
 * state with the recorded rating. The portal ticket and the public token page both render it.
 */
export function SurveyCard({ question, commentPrompt, state, onRate, onComment, busy, compact, initialRating, title = 'How did we do?', footer, className, id }: {
  question: string;
  commentPrompt: string | null;
  state: SurveyCardState;
  /** Records the rating (and the comment typed with it). */
  onRate?: (rating: number, comment: string | null) => Promise<unknown> | void;
  /** Adds a comment to a rating already recorded without one (the public page after a one-click link). */
  onComment?: (comment: string) => Promise<unknown> | void;
  busy?: boolean;
  compact?: boolean;
  /** Preselected star (the one-click email link). */
  initialRating?: number | null;
  title?: ReactNode;
  footer?: ReactNode;
  className?: string;
  id?: string;
}) {
  const [rating, setRating] = useState<number | null>(initialRating ?? null);
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (initialRating) setRating(initialRating);
  }, [initialRating]);
  const starSize = compact ? 'md' : 'lg';
  const answered = state.status === 'answered' && state.rating != null;
  const closed = state.status === 'expired' || state.status === 'cancelled';
  const canRate = !!onRate && (state.status === 'pending' || state.status === 'none');
  const canComment = answered && !!onComment && !state.hasComment && !state.comment;

  let body: ReactNode;
  if (answered) {
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <RatingStars value={state.rating} size={starSize} readOnly />
          <div className="text-[13.5px]">
            <span className="font-medium inline-flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-emerald-600" /> You rated this ticket {state.rating}/5</span>
            <span className="text-muted"> · {RATING_LABELS[state.rating!]}{state.answeredAt ? ` · ${fmtDate(state.answeredAt)}` : ''}</span>
          </div>
        </div>
        {state.comment && <div className="text-[13px] text-default whitespace-pre-wrap border-l-2 border-default pl-3">{state.comment}</div>}
        {canComment && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (comment.trim()) void onComment!(comment.trim());
            }}
          >
            <Field label={commentPrompt || 'Anything we could have done better?'}>
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={4000} rows={3} placeholder="Optional" />
            </Field>
            <div><Button type="submit" size="sm" loading={busy} disabled={!comment.trim()}>Send comment</Button></div>
          </form>
        )}
        {answered && !canComment && (state.hasComment || state.comment) && !state.comment && <div className="text-[12.5px] text-muted">Thank you, your comment was received.</div>}
      </div>
    );
  } else if (closed) {
    body = <div className="text-[13.5px] text-muted inline-flex items-center gap-2"><Clock className="h-4 w-4" /> {state.status === 'expired' ? 'This survey has closed.' : 'This survey was withdrawn.'}</div>;
  } else if (canRate) {
    body = (
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (rating) void onRate!(rating, comment.trim() || null);
        }}
      >
        <div className="text-[14px] text-default">{question}</div>
        <div className={cn('flex flex-col gap-1', compact ? 'sm:flex-row sm:items-center sm:gap-3' : '')}>
          <RatingStars value={rating} onChange={setRating} size={starSize} />
          <div className="text-[12.5px] text-muted min-h-[18px]" aria-live="polite">{rating ? RATING_LABELS[rating] : 'Pick a star: 1 is very dissatisfied, 5 is very satisfied'}</div>
        </div>
        <Field label={commentPrompt || 'Anything we could have done better?'}>
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={4000} rows={compact ? 2 : 3} placeholder="Optional" />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" loading={busy} disabled={!rating}>Send</Button>
          {state.expiresAt && <span className="text-[12px] text-subtle">Open until {fmtDate(state.expiresAt)}</span>}
        </div>
      </form>
    );
  } else {
    body = <div className="text-[13.5px] text-muted">{question}</div>;
  }

  return (
    <Card id={id} className={cn('scroll-mt-20', className)} title={<span className="inline-flex items-center gap-2"><MessageSquareHeart className="h-4 w-4 text-brand-600" /> {title}</span>}>
      {body}
      {footer && <div className="mt-4 pt-3 border-t border-default text-[12.5px] text-muted">{footer}</div>}
    </Card>
  );
}
