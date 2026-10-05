import { Card } from '@/components/ui';
import type { Insight, Narrative } from './types';

/**
 * The three lists of a report preview: what went well, what needs attention
 * and next steps, derived from the report's own figures by fixed rules. The
 * on-screen preview is a JSON run, whose narrative always comes from the
 * rules; the HTML and PDF documents may phrase the same lists through the
 * assistant.
 */

function Column({ title, items, rail, evidence, ordered }: { title: string; items: string[]; rail: string; evidence?: (text: string) => string | undefined; ordered?: boolean }) {
  const List = ordered ? 'ol' : 'ul';
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium text-muted uppercase tracking-wide mb-2">{title}</div>
      {items.length ? (
        <List className="flex flex-col gap-2">
          {items.map((t, i) => {
            const ev = evidence?.(t);
            return (
              <li key={i} className={`border-l-2 ${rail} pl-3 text-[13px] text-default leading-snug`}>
                {ordered && <span className="text-subtle mr-1.5 tabular-nums">{i + 1}.</span>}
                {t}
                {ev && <div className="text-[12px] text-muted mt-0.5">{ev}</div>}
              </li>
            );
          })}
        </List>
      ) : (
        <div className="text-[13px] text-subtle">Nothing to flag this period</div>
      )}
    </div>
  );
}

export function InsightsCard({ narrative, insights }: { narrative?: Narrative; insights?: Insight[] }) {
  const wentWell = narrative?.wentWell ?? insights?.filter((i) => i.kind === 'good').map((i) => i.text) ?? [];
  const needsAttention = narrative?.needsAttention ?? insights?.filter((i) => i.kind === 'attention').map((i) => i.text) ?? [];
  const nextSteps = narrative?.nextSteps ?? [];
  const evidenceOf = (text: string) => insights?.find((i) => i.text === text)?.evidence;
  const empty = !wentWell.length && !needsAttention.length && !nextSteps.length;
  return (
    <Card title="Insights">
      {empty ? (
        <div className="text-[13px] text-subtle py-2">No insights for this period</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <Column title="What went well" items={wentWell} rail="border-emerald-500" evidence={evidenceOf} />
          <Column title="What needs attention" items={needsAttention} rail="border-amber-500" evidence={evidenceOf} />
          <Column title="Next steps" items={nextSteps} rail="border-brand-500" ordered />
        </div>
      )}
      <div className="text-[11.5px] text-subtle mt-4 pt-3 border-t border-default">Derived from the report's own figures; the PDF and HTML documents may phrase them through the assistant.</div>
    </Card>
  );
}
