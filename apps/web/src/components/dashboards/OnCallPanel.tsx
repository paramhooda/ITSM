import { Repeat } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { Panel } from './Panel';

export interface OnCallSummaryTeam {
  teamId: string;
  teamName: string;
  teamType: string;
  rotas: { id: string; name: string; userId: string | null; userName: string | null; until: string | null; override: boolean }[];
}

/** Who is on call right now for the dashboard's teams, one line per rota. */
export function OnCallPanel({ items }: { items: OnCallSummaryTeam[] }) {
  return (
    <Panel title="On call now" subtitle={items.length ? 'Primary rota first; cover is marked' : 'No team has a rota yet'} to="/operations/on-call" toLabel="On-call" padded={false}>
      {items.length === 0 ? (
        <div className="px-5 pb-4 text-[12.5px] text-muted">Set up a rota under Operations → On-call so escalations and pages reach the right person.</div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {items.flatMap((t) =>
            t.rotas.map((r) => (
              <li key={r.id} className="px-5 py-2.5 flex items-center gap-3 text-[13px]">
                <Avatar name={r.userName ?? '?'} size="xs" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{r.userName ?? <span className="text-muted italic">Nobody on call</span>}{r.override && <Repeat className="inline h-3 w-3 ml-1 text-subtle" aria-label="cover" />}</div>
                  <div className="text-[12px] text-muted truncate">{t.teamName} · {r.name}</div>
                </div>
                {r.until && <span className="text-[12px] text-subtle shrink-0">until {relativeTime(r.until)}</span>}
              </li>
            )),
          )}
        </ul>
      )}
    </Panel>
  );
}
