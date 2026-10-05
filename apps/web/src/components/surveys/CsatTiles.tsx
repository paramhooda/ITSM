import { Star, ThumbsUp, Send, MessageSquare, ThumbsDown } from 'lucide-react';
import type { KpiItem } from '@/components/dashboards/KpiGrid';
import { fmtNumber, fmtPct } from '@/lib/format';
import { fmtRating, ratingTone, type CsatFigures } from './api';

/**
 * The five CSAT tiles (average, satisfied, response rate, responses, low ratings) from one figures block.
 * The CSAT page passes `onLow`/`lowActive` so the last tile toggles its "low ratings only" filter in place.
 */
export function csatTiles(f: CsatFigures | undefined, opts: { thresholds?: { satisfied: number; low: number }; onLow?: () => void; lowActive?: boolean; spark?: boolean } = {}): KpiItem[] {
  if (!f) return [];
  const satisfied = opts.thresholds?.satisfied ?? 4;
  const low = opts.thresholds?.low ?? 2;
  const spark = opts.spark ? f.series.map((p) => p.avg) : undefined;
  return [
    { label: 'Average rating', value: fmtRating(f.avg), tone: ratingTone(f.avg), icon: <Star className="h-4 w-4" />, hint: f.responses ? `from ${fmtNumber(f.responses)} ${f.responses === 1 ? 'response' : 'responses'}` : 'no responses yet', spark, sparkLabel: 'Average rating per week' },
    { label: 'Satisfied', value: fmtPct(f.satisfiedPct), tone: f.satisfiedPct == null ? 'default' : f.satisfiedPct >= 80 ? 'good' : f.satisfiedPct >= 60 ? 'warn' : 'bad', icon: <ThumbsUp className="h-4 w-4" />, hint: `rated ${satisfied} or more` },
    { label: 'Response rate', value: fmtPct(f.responseRate), icon: <Send className="h-4 w-4" />, hint: `${fmtNumber(f.sent)} ${f.sent === 1 ? 'survey' : 'surveys'} sent` },
    { label: 'Responses', value: fmtNumber(f.responses), icon: <MessageSquare className="h-4 w-4" />, hint: `${fmtNumber(f.sent)} sent` },
    { label: 'Low ratings', value: fmtNumber(f.low), tone: f.low > 0 ? 'bad' : 'good', icon: <ThumbsDown className="h-4 w-4" />, hint: `rated ${low} or less`, onClick: opts.onLow, active: opts.lowActive, scrollTo: !!opts.onLow },
  ];
}
