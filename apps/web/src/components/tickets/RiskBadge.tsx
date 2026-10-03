import { Frown, Angry, Meh, Smile, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { BREACH_RISK_COLORS, SENTIMENT_COLORS } from '@/lib/statusColors';
import type { BreachRisk, Sentiment } from './types';

export const RISK_LABELS: Record<string, string> = { high: 'Likely to breach', medium: 'Medium risk', low: 'Low risk' };
export const SENTIMENT_LABELS: Record<Sentiment, string> = { angry: 'Angry', negative: 'Unhappy', neutral: 'Neutral', positive: 'Happy' };
const SENTIMENT_ICONS: Record<Sentiment, LucideIcon> = { angry: Angry, negative: Frown, neutral: Meh, positive: Smile };
export const isUnhappy = (s: Sentiment | null | undefined) => s === 'negative' || s === 'angry';

/**
 * Breach forecast chip (staff only). `compact` shows the level alone for list cells and keeps the
 * score and the reason in the tooltip; `quiet` hides a low risk so calm rows stay calm.
 */
export function RiskBadge({ risk, className, compact, quiet }: { risk: BreachRisk | null | undefined; className?: string; compact?: boolean; quiet?: boolean }) {
  if (!risk) return compact ? null : <span className="text-subtle text-xs">—</span>;
  if (quiet && risk.level === 'low') return null;
  const title = `${RISK_LABELS[risk.level]} · score ${risk.score}/100${risk.reason ? ` · ${risk.reason}` : ''}`;
  return (
    <Badge color={BREACH_RISK_COLORS[risk.level]} className={className} title={title}>
      {compact ? (risk.level === 'high' ? 'High' : risk.level === 'medium' ? 'Medium' : 'Low') : RISK_LABELS[risk.level]}
    </Badge>
  );
}

/** The customer's last mood (staff only). `compact` renders the icon alone with the label in the tooltip. */
export function SentimentBadge({ sentiment, className, compact }: { sentiment: Sentiment | null | undefined; className?: string; compact?: boolean }) {
  if (!sentiment) return compact ? null : <span className="text-subtle text-xs">—</span>;
  const Icon = SENTIMENT_ICONS[sentiment];
  const title = `Customer sounded ${SENTIMENT_LABELS[sentiment].toLowerCase()} in the last comment`;
  if (compact) {
    const tone = sentiment === 'angry' ? 'text-red-600' : sentiment === 'negative' ? 'text-amber-600' : sentiment === 'positive' ? 'text-emerald-600' : 'text-subtle';
    return (
      <span className={cn('inline-flex', className)} title={title} aria-label={title}>
        <Icon className={cn('h-3.5 w-3.5', tone)} />
      </span>
    );
  }
  return (
    <Badge color={SENTIMENT_COLORS[sentiment]} className={className} title={title}>
      <Icon className="h-3 w-3" /> {SENTIMENT_LABELS[sentiment]}
    </Badge>
  );
}
