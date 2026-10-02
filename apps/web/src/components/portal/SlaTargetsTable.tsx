import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui';
import { fmtDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { SlaTarget } from './api';

const METRICS: { key: string; label: string; hint: string }[] = [
  { key: 'acknowledgement', label: 'Acknowledged', hint: 'An engineer has picked the ticket up' },
  { key: 'response', label: 'First response', hint: 'You hear back from us' },
  { key: 'restoration', label: 'Service restored', hint: 'Service is working again (workaround allowed)' },
  { key: 'resolution', label: 'Resolved', hint: 'Fully fixed' },
];

/** SLA targets per priority (rows) × metric (columns) for incidents / requests. */
export function SlaTargetsTable({ targets, calendarName, className }: { targets: SlaTarget[]; calendarName?: string | null; className?: string }) {
  const types = useMemo(() => [...new Set(targets.map((t) => t.ticketType))].filter((t) => t === 'incident' || t === 'request'), [targets]);
  const [type, setType] = useState<string>(types[0] ?? 'incident');
  const rows = useMemo(() => {
    const mine = targets.filter((t) => t.ticketType === type);
    const byPriority = new Map<string, { label: string; level: number; color: string | null; metrics: Record<string, SlaTarget> }>();
    for (const t of mine) {
      const key = t.priorityId ?? 'any';
      const row = byPriority.get(key) ?? { label: t.priorityLabel ?? 'Any priority', level: t.priorityLevel ?? 99, color: t.priorityColor, metrics: {} };
      row.metrics[t.metric] = t;
      byPriority.set(key, row);
    }
    return [...byPriority.values()].sort((a, b) => a.level - b.level);
  }, [targets, type]);
  const metrics = METRICS.filter((m) => rows.some((r) => r.metrics[m.key]));
  if (!targets.length) return <div className="text-[12.5px] text-muted">No service level targets are configured for this contract.</div>;
  return (
    <div className={className}>
      {types.length > 1 && (
        <div className="flex items-center gap-1 mb-2">
          {types.map((t) => (
            <button key={t} onClick={() => setType(t)} className={cn('rounded-md px-2.5 py-1 text-[12.5px] font-medium', type === t ? 'bg-brand-600/10 text-brand-700 dark:text-brand-300' : 'text-muted hover:bg-surface-2')}>
              {t === 'incident' ? 'Incidents' : 'Service requests'}
            </button>
          ))}
        </div>
      )}
      <div className="overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Priority</th>
              {metrics.map((m) => (
                <th key={m.key} title={m.hint}>
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>
                  <Badge color={r.color ?? 'slate'}>{r.label}</Badge>
                </td>
                {metrics.map((m) => {
                  const t = r.metrics[m.key];
                  return (
                    <td key={m.key} className="tabular-nums text-[13px]">
                      {t ? (
                        <span title={t.calendarTime ? 'Measured around the clock' : `Measured during support hours${calendarName ? ` (${calendarName})` : ''}`}>
                          {fmtDuration(t.minutes)}
                          <span className="text-subtle text-[11px] ml-1">{t.calendarTime ? '24x7' : 'support hrs'}</span>
                        </span>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[11.5px] text-subtle mt-2">Targets count from the moment the ticket is raised. Clocks pause while we wait for information from you.</div>
    </div>
  );
}
