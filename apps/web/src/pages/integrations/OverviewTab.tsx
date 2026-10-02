import { useQuery } from '@tanstack/react-query';
import { get } from '@/api/client';
import { StatTile, Card, Select, LoadingBlock, Badge } from '@/components/ui';
import { useListState } from '@/hooks/useListState';
import { useCustomersLookup } from '@/hooks/useLookups';
import { SEVERITY_LABELS } from '@/components/integrations/SeverityBadge';
import { PROCESSING_COLORS, PROCESSING_LABELS } from '@/components/integrations/ProcessingBadge';
import { colorClass } from '@/lib/utils';
import { SEVERITIES, typeLabel, type Stats } from '@/components/integrations/types';

const BAR: Record<string, string> = { critical: 'bg-red-500', high: 'bg-orange-500', medium: 'bg-amber-400', low: 'bg-blue-400', info: 'bg-slate-400', unknown: 'bg-slate-300' };

/** Chart-free overview: stat tiles, stacked daily bars by severity and simple breakdown bars. */
export function OverviewTab({ onShowEvents }: { onShowEvents: (filter: Record<string, string | undefined>) => void }) {
  const { state, set } = useListState({ days: '7' });
  const customers = useCustomersLookup();
  const days = Number(state.days ?? 7) || 7;
  const q = useQuery({ queryKey: ['integrations', 'stats', days, state.customerId ?? ''], queryFn: () => get<Stats>('/integrations/stats', { days, customerId: state.customerId || undefined }), refetchInterval: 30_000 });
  const s = q.data;
  const max = Math.max(1, ...(s?.byDay.map((d) => d.total) ?? [1]));
  const typeTotal = Math.max(1, ...Object.values(s?.byType ?? {}));
  const sevTotal = Math.max(1, ...Object.values(s?.bySeverity ?? {}));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-40" value={String(days)} onChange={(e) => set({ days: e.target.value }, false)} options={[{ value: '1', label: 'Last 24 hours' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }]} />
        <Select className="w-52" value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value }, false)} placeholder="All customers" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))} />
      </div>
      {q.isLoading && <LoadingBlock />}
      {s && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatTile label="Events" value={s.total} hint={`${s.activeIntegrations} active integration${s.activeIntegrations === 1 ? '' : 's'}`} onClick={() => onShowEvents({})} />
            <StatTile label="Tickets created" value={s.ticketsCreated} hint={`${s.openTickets} still open`} tone={s.openTickets > 0 ? 'warn' : 'default'} onClick={() => onShowEvents({ processingStatus: 'ticket_created' })} />
            <StatTile label="Deduplicated" value={s.deduplicated} hint={`${s.dedupRate}% of alarm events`} tone="good" onClick={() => onShowEvents({ processingStatus: 'deduplicated' })} />
            <StatTile label="Needs customer" value={s.unresolvedCustomer} hint="unmapped events to review" tone={s.unresolvedCustomer > 0 ? 'bad' : 'default'} onClick={() => onShowEvents({ unresolvedOnly: 'true' })} />
            <StatTile label="Errors" value={s.errors} hint="parse / processing errors" tone={s.errors > 0 ? 'warn' : 'default'} onClick={() => onShowEvents({ processingStatus: 'error' })} />
            <StatTile label="Queued" value={s.pending} hint="waiting for the worker" tone={s.pending > 50 ? 'warn' : 'default'} onClick={() => onShowEvents({ processingStatus: 'received' })} />
          </div>

          <Card title={`Events per day (${days === 1 ? 'today' : `last ${days} days`})`}>
            {s.total === 0 ? (
              <div className="text-[13px] text-muted py-6 text-center">No events in this period.</div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-end gap-1 h-40">
                  {s.byDay.map((d) => (
                    <div key={d.day} className="flex-1 flex flex-col justify-end items-stretch gap-px min-w-0 group" title={`${d.day}: ${d.total} events, ${d.ticketsCreated} tickets`}>
                      {SEVERITIES.filter((sev) => d.bySeverity[sev]).map((sev) => (
                        <div key={sev} className={`${BAR[sev]} rounded-sm`} style={{ height: `${(d.bySeverity[sev] / max) * 100}%`, minHeight: 2 }} />
                      ))}
                      {d.bySeverity.unknown ? <div className={`${BAR.unknown} rounded-sm`} style={{ height: `${(d.bySeverity.unknown / max) * 100}%`, minHeight: 2 }} /> : null}
                    </div>
                  ))}
                </div>
                <div className="flex gap-1 text-[10px] text-subtle">
                  {s.byDay.map((d, i) => (
                    <div key={d.day} className="flex-1 text-center truncate">{s.byDay.length <= 10 || i % Math.ceil(s.byDay.length / 10) === 0 ? d.day.slice(5) : ''}</div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 text-[11px] text-muted">
                  {SEVERITIES.map((sev) => (
                    <span key={sev} className="inline-flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${BAR[sev]}`} />{SEVERITY_LABELS[sev]}</span>
                  ))}
                </div>
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <Card title="By source">
              <Bars rows={Object.entries(s.byType).map(([k, v]) => ({ key: k, label: typeLabel(k), value: v, pct: (v / typeTotal) * 100, color: 'bg-brand-500' }))} onClick={(k) => onShowEvents({ integrationType: k })} />
            </Card>
            <Card title="By severity">
              <Bars rows={[...SEVERITIES, 'unknown'].filter((k) => s.bySeverity[k]).map((k) => ({ key: k, label: SEVERITY_LABELS[k] ?? 'Unknown', value: s.bySeverity[k], pct: (s.bySeverity[k] / sevTotal) * 100, color: BAR[k] }))} onClick={(k) => onShowEvents({ severity: k === 'unknown' ? undefined : k })} />
            </Card>
            <Card title="By processing outcome">
              <div className="flex flex-col gap-1.5">
                {Object.entries(s.byStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <button key={k} type="button" className="flex items-center justify-between gap-2 text-[13px] hover:bg-surface-2 rounded px-1 -mx-1" onClick={() => onShowEvents({ processingStatus: k })}>
                    <Badge color={PROCESSING_COLORS[k]}>{PROCESSING_LABELS[k] ?? k}</Badge>
                    <span className="font-medium">{v}</span>
                  </button>
                ))}
                {Object.keys(s.byStatus).length === 0 && <div className="text-[13px] text-muted">—</div>}
              </div>
            </Card>
          </div>
          {s.unresolvedCustomer > 0 && (
            <div className={`rounded-lg border border-amber-300/60 p-3 text-[13px] flex items-center justify-between gap-3 ${colorClass('amber')}`}>
              <span>{s.unresolvedCustomer} event{s.unresolvedCustomer === 1 ? '' : 's'} could not be assigned to a customer. Add a customer mapping rule, create the CI in the CMDB, or assign the customer manually from the event list.</span>
              <button type="button" className="underline font-medium whitespace-nowrap" onClick={() => onShowEvents({ unresolvedOnly: 'true' })}>Review now</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Bars({ rows, onClick }: { rows: { key: string; label: string; value: number; pct: number; color: string }[]; onClick: (key: string) => void }) {
  if (!rows.length) return <div className="text-[13px] text-muted">—</div>;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <button key={r.key} type="button" className="text-left hover:bg-surface-2 rounded px-1 -mx-1" onClick={() => onClick(r.key)}>
          <div className="flex items-center justify-between text-[12.5px]"><span>{r.label}</span><span className="font-medium">{r.value}</span></div>
          <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden mt-0.5"><div className={`h-full rounded-full ${r.color}`} style={{ width: `${Math.max(2, r.pct)}%` }} /></div>
        </button>
      ))}
    </div>
  );
}

