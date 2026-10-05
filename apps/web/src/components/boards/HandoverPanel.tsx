import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCheck, Clock, ExternalLink, PenLine } from 'lucide-react';
import { Badge, Button, Card, ErrorBlock, Select, Textarea } from '@/components/ui';
import { Skeleton } from '@/components/dashboards/Panel';
import { Markdown } from '@/components/handover/Markdown';
import { handoverApi } from '@/components/handover/api';
import { fmtDate, fmtDateTime, relativeTime } from '@/lib/format';
import { HANDOVER_STATUS_COLORS } from '@/lib/statusColors';
import { boardKeys, boardsApi } from './api';

const STATUS_LABEL: Record<string, string> = { draft: 'Draft', final: 'Published', acknowledged: 'Acknowledged' };
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The team's current shift handover beside the board: the running shift, the latest
 * published note (its Watch first section), who acknowledged it, and Acknowledge for
 * whoever takes over. Reads and writes go through the handover module's own routes.
 */
export function HandoverPanel({ teamId, teams, onTeamChange }: { teamId?: string; teams: { id: string; name: string }[]; onTeamChange: (id: string) => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const q = useQuery({ queryKey: boardKeys.handover(teamId ?? ''), queryFn: () => boardsApi.handover(teamId!), enabled: !!teamId, refetchInterval: 60_000, placeholderData: (p) => p });
  const ack = useMutation({
    mutationFn: (id: string) => handoverApi.acknowledge(id, note.trim() ? { note: note.trim() } : {}),
    onSuccess: () => {
      toast.success('Handover acknowledged');
      setNote('');
      void qc.invalidateQueries({ queryKey: ['handover'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const p = q.data;
  const latest = p?.latest ?? null;
  const published = latest && latest.status !== 'draft' ? latest : null;
  const writeLink = teamId ? `/operations/handover?team=${teamId}` : '/operations/handover';
  return (
    <Card
      padded={false}
      className="min-w-0"
      title={
        <span className="inline-flex items-center gap-2">
          Handover
          {p && p.unacknowledged > 0 && (
            <Badge color="amber" title={`${p.unacknowledged} published handover${p.unacknowledged === 1 ? '' : 's'} not yet acknowledged`} data-testid="handover-unacknowledged">
              {p.unacknowledged}
            </Badge>
          )}
        </span>
      }
      actions={teams.length > 0 ? <Select aria-label="Handover team" className="h-7 py-0 text-[12px] w-44 max-w-full" value={teamId ?? ''} onChange={(e) => e.target.value && onTeamChange(e.target.value)} options={teams.map((t) => ({ value: t.id, label: t.name }))} /> : undefined}
      data-testid="handover-panel"
    >
      <div className="p-4 flex flex-col gap-3 text-[13px]">
        {!teamId ? (
          <div className="text-subtle text-[12.5px]">You are not in a team, so there is no shift handover to show.</div>
        ) : q.isLoading ? (
          <Skeleton rows={4} />
        ) : q.isError ? (
          <ErrorBlock error={q.error} retry={() => void q.refetch()} />
        ) : p ? (
          <>
            <div className="flex items-start gap-2 text-[12.5px] text-muted" data-testid="handover-shift">
              <Clock className="h-3.5 w-3.5 text-subtle shrink-0 mt-0.5" />
              <span className="min-w-0">
                {p.current ? (
                  <>
                    <span className="font-medium text-default">{p.current.name}</span> · ends {time(p.current.endsAt)}
                    {p.next ? (
                      <>
                        {' '}· next <span className="font-medium text-default">{p.next.name}</span> at {time(p.next.startsAt)}
                      </>
                    ) : null}
                  </>
                ) : p.next ? (
                  <>
                    No shift running · next <span className="font-medium text-default">{p.next.name}</span> at {time(p.next.startsAt)}
                  </>
                ) : (
                  'No shifts configured for this team'
                )}
              </span>
            </div>
            {!published ? (
              <div className="rounded-lg border border-dashed border-default px-3 py-4 text-center" data-testid="handover-empty">
                <div className="text-[13px] font-medium text-default">{latest ? `A draft by ${latest.authorName ?? 'a colleague'} is in progress` : 'No published handover for this shift yet'}</div>
                {p.canWrite && (
                  <Link to={writeLink} className="inline-flex items-center gap-1 mt-2 text-[12.5px] font-medium text-brand-700 hover:underline">
                    <PenLine className="h-3.5 w-3.5" /> {latest ? 'Continue the draft' : 'Write one'}
                  </Link>
                )}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge color={HANDOVER_STATUS_COLORS[published.status] ?? 'slate'} dot data-testid="handover-status">
                    {STATUS_LABEL[published.status] ?? published.status}
                  </Badge>
                  <span className="text-[12.5px] text-muted min-w-0">
                    {published.shiftName ? `${published.shiftName} · ` : ''}
                    {fmtDate(published.shiftDate)} · by {published.authorName ?? '—'}
                    {published.publishedAt ? ` · published ${relativeTime(published.publishedAt)}` : ''}
                  </span>
                </div>
                <div className="rounded-lg bg-surface-2 border border-default px-3 py-2" data-testid="handover-watch-first">
                  <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mb-1">Watch first</div>
                  <Markdown body={published.watchFirst.replace(/^##\s*Watch first\s*/i, '') || '_Nothing flagged._'} />
                </div>
                {published.status === 'acknowledged' && (
                  <div className="flex items-start gap-2 text-[12.5px] text-emerald-700" data-testid="handover-acknowledged">
                    <CheckCheck className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>
                      Acknowledged by <span className="font-medium">{published.acknowledgedByName ?? '—'}</span>
                      {published.acknowledgedAt ? ` · ${relativeTime(published.acknowledgedAt)}` : ''}
                      {published.acknowledgementNote ? <span className="block text-muted">“{published.acknowledgementNote}”</span> : null}
                    </span>
                  </div>
                )}
                {p.canAcknowledge && (
                  <div className="flex flex-col gap-2 pt-1 border-t border-default" data-testid="handover-acknowledge">
                    <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Taken over, watching… (optional)" className="min-h-[56px] text-[12.5px]" aria-label="Acknowledgement note" />
                    <Button size="sm" icon={<CheckCheck className="h-3.5 w-3.5" />} loading={ack.isPending} onClick={() => ack.mutate(published.id)} className="self-start">
                      Acknowledge
                    </Button>
                  </div>
                )}
                <Link to={`${writeLink}&handover=${published.id}`} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-default" title={`Published ${fmtDateTime(published.publishedAt)}`}>
                  Open full note <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              </>
            )}
          </>
        ) : null}
      </div>
    </Card>
  );
}
