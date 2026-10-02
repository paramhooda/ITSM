import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { UsersRound, Users, Ticket, AlertTriangle, Star, Mail, Phone, Settings2, Search } from 'lucide-react';
import { get } from '@/api/client';
import { Badge, Button, Card, ErrorBlock, EmptyState, Avatar, LoadingBlock } from '@/components/ui';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { Segmented } from '@/components/dashboards/Panel';
import { useAuthStore } from '@/stores/auth';
import { useLookups } from '@/hooks/useLookups';
import { fmtNumber, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Member {
  id: string;
  name: string;
  email: string;
  title: string | null;
  phone: string | null;
  status: string;
  isLead: boolean;
  lastLoginAt: string | null;
  roles: { key: string; name: string }[];
  otherTeamIds: string[];
  openTickets: number;
  breached: number;
}
interface Team {
  id: string;
  key: string;
  name: string;
  description: string | null;
  teamType: string;
  email: string | null;
  manager: { id: string; name: string | null; email: string | null } | null;
  members: Member[];
  load: { open: number; unassigned: number; breached: number; openedToday: number };
}
interface Directory {
  teams: Team[];
  totals: { teams: number; people: number; multiTeam: number; open: number; unassigned: number; breached: number };
}

const TYPE_COLORS: Record<string, string> = { noc: 'blue', soc: 'red', field: 'amber', service_desk: 'teal', infrastructure: 'indigo', network: 'sky', security: 'rose', cloud: 'violet', general: 'slate' };

/** Who works where: every team with its people and live workload; people can sit in several teams. */
export default function TeamsPage() {
  const can = useAuthStore((s) => s.can);
  const me = useAuthStore((s) => s.user);
  const { byKey } = useLookups();
  const [view, setView] = useState<'teams' | 'people'>('teams');
  const [q, setQ] = useState('');
  const dir = useQuery({ queryKey: ['iam', 'teams', 'directory'], queryFn: () => get<Directory>('/iam/teams/directory'), staleTime: 60_000 });
  const teams = dir.data?.teams ?? [];
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? '';
  const needle = q.trim().toLowerCase();
  const filteredTeams = useMemo(() => (needle ? teams.filter((t) => t.name.toLowerCase().includes(needle) || t.members.some((m) => m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle))) : teams), [teams, needle]);
  const people = useMemo(() => {
    const map = new Map<string, Member & { teams: { id: string; name: string; isLead: boolean }[] }>();
    for (const t of teams) for (const m of t.members) {
      const cur = map.get(m.id) ?? { ...m, teams: [] };
      cur.teams.push({ id: t.id, name: t.name, isLead: m.isLead });
      map.set(m.id, cur);
    }
    return [...map.values()].filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle) || p.teams.some((t) => t.name.toLowerCase().includes(needle))).sort((a, b) => a.name.localeCompare(b.name));
  }, [teams, needle]);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.025em]">Teams</h1>
          <div className="text-[13.5px] text-muted mt-1">Who works in which team, who leads it, and how much open work each team carries.</div>
        </div>
        {can('admin:users') && <Button variant="outline" icon={<Settings2 className="h-4 w-4" />} onClick={() => (window.location.href = '/admin/teams')}>Manage teams</Button>}
      </div>
      {dir.isError && <ErrorBlock error={dir.error} retry={() => dir.refetch()} />}
      {dir.isLoading && <LoadingBlock />}
      {dir.data && (
        <div className="flex flex-col gap-6">
          <KpiGrid
            items={[
              { label: 'Teams', value: fmtNumber(dir.data.totals.teams), hint: `${fmtNumber(dir.data.totals.people)} people · ${fmtNumber(dir.data.totals.multiTeam)} in more than one team`, icon: <UsersRound className="h-4 w-4" /> },
              { label: 'Open work in teams', value: fmtNumber(dir.data.totals.open), hint: 'tickets assigned to a team', icon: <Ticket className="h-4 w-4" />, onClick: () => (window.location.href = '/tickets?open=true') },
              { label: 'Waiting for an owner', value: fmtNumber(dir.data.totals.unassigned), tone: dir.data.totals.unassigned > 0 ? 'warn' : 'good', hint: 'in a team queue, nobody assigned', icon: <Users className="h-4 w-4" />, onClick: () => (window.location.href = '/tickets?open=true&unassigned=true') },
              { label: 'Breached in teams', value: fmtNumber(dir.data.totals.breached), tone: dir.data.totals.breached > 0 ? 'bad' : 'good', hint: 'open tickets past an SLA target', icon: <AlertTriangle className="h-4 w-4" />, onClick: () => (window.location.href = '/tickets?open=true&slaState=breached') },
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Segmented options={[{ value: 'teams', label: 'By team', count: teams.length }, { value: 'people', label: 'By person', count: people.length }]} value={view} onChange={setView} />
            <div className="relative w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-subtle pointer-events-none" />
              <input className="input pl-9" placeholder="Search teams or people…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>

          {view === 'teams' && (
            filteredTeams.length === 0 ? <Card><EmptyState icon={<UsersRound className="h-5 w-5" />} title="No teams match" /></Card> : (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                {filteredTeams.map((t, i) => (
                  <Card key={t.id} padded={false} className={cn('rise-in', `rise-in-${Math.min(4, i + 1)}`)}>
                    <div className="px-5 pt-4 pb-3 border-b border-default flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{t.name}</h2>
                          <Badge color={TYPE_COLORS[t.teamType] ?? 'slate'}>{byKey('team_type', t.teamType)?.label ?? t.teamType}</Badge>
                          {t.members.some((m) => m.id === me?.id) && <Badge color="green">your team</Badge>}
                        </div>
                        <div className="text-[12.5px] text-muted mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                          {t.manager?.name && <span>Manager <span className="text-default">{t.manager.name}</span></span>}
                          {t.email && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{t.email}</span>}
                          {t.description && <span className="truncate">{t.description}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-4 shrink-0 text-[12.5px] tnum">
                        <Stat label="Open" value={t.load.open} to={`/tickets?open=true&teamId=${t.id}`} />
                        <Stat label="Unassigned" value={t.load.unassigned} tone={t.load.unassigned > 0 ? 'warn' : undefined} to={`/tickets?open=true&unassigned=true&teamId=${t.id}`} />
                        <Stat label="Breached" value={t.load.breached} tone={t.load.breached > 0 ? 'bad' : undefined} to={`/tickets?open=true&slaState=breached&teamId=${t.id}`} />
                      </div>
                    </div>
                    {t.members.length === 0 ? (
                      <div className="px-5 py-6 text-[13px] text-subtle text-center">No members yet.</div>
                    ) : (
                      <ul className="divide-y divide-[var(--border)]">
                        {t.members.map((m) => (
                          <li key={m.id} className="px-5 py-2.5 flex items-center gap-3">
                            <Avatar name={m.name} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[13.5px] font-medium text-default">{m.name}</span>
                                {m.isLead && <Badge color="amber"><Star className="h-3 w-3" /> lead</Badge>}
                                {m.status !== 'active' && <Badge color="gray">{m.status}</Badge>}
                              </div>
                              <div className="text-[12px] text-muted truncate">
                                {m.title ?? m.roles.map((r) => r.name).join(', ') ?? m.email}
                                {m.otherTeamIds.length > 0 && <span className="text-subtle"> · also in {m.otherTeamIds.map(teamName).filter(Boolean).join(', ')}</span>}
                              </div>
                            </div>
                            <div className="text-[12px] tnum text-right shrink-0">
                              <span className={cn(m.openTickets > 0 ? 'text-default font-medium' : 'text-subtle')}>{m.openTickets} open</span>
                              {m.breached > 0 && <span className="text-red-600 font-medium"> · {m.breached} breached</span>}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                ))}
              </div>
            )
          )}

          {view === 'people' && (
            <Card padded={false}>
              {people.length === 0 ? <EmptyState icon={<Users className="h-5 w-5" />} title="No people match" /> : (
                <div className="overflow-auto">
                  <table className="table">
                    <thead><tr><th>Person</th><th>Role</th><th>Teams</th><th>Contact</th><th className="text-right">Open work</th><th>Last sign-in</th></tr></thead>
                    <tbody>
                      {people.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <div className="flex items-center gap-2.5">
                              <Avatar name={p.name} />
                              <div><div className="font-medium text-default">{p.name}</div>{p.title && <div className="text-[12px] text-muted">{p.title}</div>}</div>
                            </div>
                          </td>
                          <td className="text-muted">{p.roles.map((r) => r.name).join(', ') || '—'}</td>
                          <td>
                            <div className="flex flex-wrap gap-1">
                              {p.teams.map((t) => <Badge key={t.id} color={t.isLead ? 'amber' : 'slate'}>{t.isLead && <Star className="h-3 w-3" />}{t.name}</Badge>)}
                            </div>
                          </td>
                          <td className="text-muted text-[12.5px]">
                            <div className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{p.email}</div>
                            {p.phone && <div className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{p.phone}</div>}
                          </td>
                          <td className="text-right tnum"><span className={p.openTickets > 0 ? 'font-medium text-default' : 'text-subtle'}>{p.openTickets}</span>{p.breached > 0 && <span className="text-red-600"> · {p.breached} breached</span>}</td>
                          <td className="text-muted whitespace-nowrap">{p.lastLoginAt ? relativeTime(p.lastLoginAt) : 'Never'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
          <div className="text-[12px] text-subtle">Membership, leads and shared mailboxes are managed under <Link to="/admin/teams" className="text-default font-medium hover:underline">Administration → Teams</Link>.</div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone, to }: { label: string; value: number; tone?: 'warn' | 'bad'; to: string }) {
  return (
    <Link to={to} className="text-right hover:underline">
      <div className="text-[11.5px] text-muted">{label}</div>
      <div className={cn('text-[16px] font-semibold tracking-[-0.02em]', tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-default')}>{value}</div>
    </Link>
  );
}
