import { Send } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import { ProseText } from '@/components/record';
import { fmtDate, fmtDateTime, relativeTime } from '@/lib/format';
import { SURVEY_STATUS_COLORS } from '@/lib/statusColors';
import { RatingStars } from './RatingStars';
import { CHANNEL_LABELS, RATING_LABELS, SKIP_REASON_LABELS, SURVEY_STATUS_LABELS, type SurveyEmbed } from './api';

/**
 * The "Customer rating" block of the staff ticket record: the stars, who answered through which channel and
 * when, the comment as prose; or the state of the survey (awaiting, expired, not sent and why) and the manual send.
 */
export function SurveyPanel({ survey, canSend, onSend, sending }: { survey: SurveyEmbed | null | undefined; canSend?: boolean; onSend?: () => void; sending?: boolean }) {
  const send = canSend && onSend ? (
    <Button size="sm" variant="outline" icon={<Send className="h-3.5 w-3.5" />} onClick={onSend} loading={sending}>
      Send survey
    </Button>
  ) : null;
  if (!survey || survey.status === 'none') {
    const reason = survey && survey.status === 'none' ? survey.reason : null;
    const policy = survey && survey.status === 'none' ? survey.policy : null;
    return (
      <div className="flex flex-wrap items-center gap-3 py-0.5">
        <Badge color={SURVEY_STATUS_COLORS.none}>{SURVEY_STATUS_LABELS.none}</Badge>
        <span className="text-[12.5px] text-muted">
          {reason ? `Not sent: ${SKIP_REASON_LABELS[reason] ?? reason}` : policy && !policy.enabled ? 'Surveys are off for this customer' : policy ? `Sent ${policy.sendOn === 'closed' ? 'on closure' : 'on resolution'}${policy.source !== 'default' ? ` (${policy.source} policy)` : ''}` : 'Nothing recorded yet'}
        </span>
        {send}
      </div>
    );
  }
  if (survey.status === 'answered' && survey.rating != null) {
    const by = survey.answeredBy?.name ?? survey.recipientName ?? 'the customer';
    return (
      <div className="flex flex-col gap-2 py-0.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <RatingStars value={survey.rating} size="sm" readOnly />
          <span className="text-[13px] font-medium tnum">{survey.rating}/5 · {RATING_LABELS[survey.rating]}</span>
          <span className="text-[12.5px] text-muted">by {by}{survey.channel ? ` · ${CHANNEL_LABELS[survey.channel] ?? survey.channel}` : ''}{survey.answeredAt ? ` · ${fmtDate(survey.answeredAt)}` : ''}</span>
          {survey.lowRatingAlertedAt && <Badge color="red">Low rating alert sent</Badge>}
        </div>
        {survey.comment ? <ProseText text={survey.comment} /> : <span className="text-[12.5px] text-subtle">No comment left.</span>}
      </div>
    );
  }
  const pending = survey.status === 'pending';
  const line = pending
    ? `Sent ${fmtDate(survey.requestedAt)}${survey.recipientName ? ` to ${survey.recipientName}` : ''} · awaiting reply${survey.remindedAt ? ` · reminded ${relativeTime(survey.remindedAt)}` : ''}${survey.resentAt ? ` · re-sent on closure` : ''} · open until ${fmtDate(survey.expiresAt)}`
    : survey.status === 'expired'
      ? `Sent ${fmtDate(survey.requestedAt)}${survey.recipientName ? ` to ${survey.recipientName}` : ''} · no reply by ${fmtDate(survey.expiresAt)}`
      : `Withdrawn${survey.requestedAt ? ` · sent ${fmtDate(survey.requestedAt)}` : ''}`;
  return (
    <div className="flex flex-wrap items-center gap-3 py-0.5">
      <Badge color={SURVEY_STATUS_COLORS[survey.status]}>{SURVEY_STATUS_LABELS[survey.status] ?? survey.status}</Badge>
      <span className="text-[12.5px] text-muted" title={survey.recipientEmail ? `${survey.recipientEmail} · ${fmtDateTime(survey.requestedAt)}` : fmtDateTime(survey.requestedAt)}>{line}</span>
      {send}
    </div>
  );
}
