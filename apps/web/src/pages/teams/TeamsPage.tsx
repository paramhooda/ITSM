import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { UsersRound, Users, Ticket, AlertTriangle, Star, Mail, Phone, Settings2 } from 'lucide-react';
import { get } from '@/api/client';
import { Badge, Button, Card, ErrorBlock, EmptyState, Avatar, LoadingBlock, PageHeader, ListShell, FilterGroup, FilterOptions, FilterToggle, type AppliedFilter } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel, Segmented } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { DOMAIN_COLORS } from '@/lib/statusColors';
import { useAuthStore } from '@/stores/auth';
import { useLookups } from '@/hooks/useLookups';
import { useListState } from '@/hooks/useListState';
import { fmtNumber, relativeTime, titleCase } from '@/lib/format';
import { cn, dotClass } from '@/lib/utils';

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

const FILTER_KEYS = ['q', 'type', 'mine', 'unassigned', 'breached'];

/** Who works where: every team with its people and live workload; people can sit in several teams. */
export default function TeamsPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const me = useAuthStore((s) => s.user);
  const { byKey, options } = useLookups();
  const { state, set } = useListState();
  const view = state.view === 'people' ? 'people' : 'teams';
  const q = state.q ?? '';
  const dir = useQuery({ queryKey: ['iam', 'teams', 'directory'], queryFn: () => get<Directory>('/iam/teams/directory'), staleTime: 60_000 });
  const teams = useMemo(() => dir.data?.teams ?? [], [dir.data]);
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? '';
  const needle = q.trim().toLowerCase();
  const typeLabel = (key: string) => byKey('team_type', key)?.label ?? titleCase(key);

  /** Teams after the rail's filters (search matches the team or any of its people). */
  const filteredTeams = useMemo(
    () =>
      teams.filter((t) => {
        if (state.type && t.teamType !== state.type) return false;
        if (state.mine === 'true' && !t.members.some((m) => m.id === me?.id)) return false;
        if (state.unassigned === 'true' && t.load.unassigned === 0) return false;
        if (state.breached === 'true' && t.load.breached === 0) return false;
        if (needle && !(t.name.toLowerCase().includes(needle) || t.members.some((m) => m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle)))) return false;
        return true;
      }),
    [teams, state.type, state.mine, state.unassigned, state.breached, needle, me?.id],
  );
  const people = useMemo(() => {
    const map = new Map<string, Member & { teams: { id: string; name: string; isLead: boolean }[] }>();
    for (const t of filteredTeams) for (const m of t.members) {
      const cur = map.get(m.id) ?? { ...m, teams: [] };
      cur.teams.push({ id: t.id, name: t.name, isLead: m.isLead });
      map.set(m.id, cur);
    }
    return [...map.values()].filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle) || p.teams.some((t) => t.name.toLowerCase().includes(needle))).sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredTeams, needle]);

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of teams) m.set(t.teamType, (m.get(t.teamType) ?? 0) + 1);
    return m;
  }, [teams]);
  const typeOptions = useMemo(() => {
    const known = options('team_type').map((o) => o.key);
    const keys = [...new Set([...known, ...typeCounts.keys()])].filter((k) => typeCounts.has(k));
    return keys.map((k) => ({ value: k, label: typeLabel(k), dot: dotClass(DOMAIN_COLORS[k] ?? 'slate'), count: typeCounts.get(k) ?? 0 }));
  }, [typeCounts, options]);

  const activeCount = FILTER_KEYS.filter((k) => state[k]).length;
  const clear = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])), false);
  const applied: AppliedFilter[] = [];
  if (q) applied.push({ key: 'q', label: `Search: “${q}”`, onRemove: () => set({ q: undefined }, false) });
  if (state.type) applied.push({ key: 'type', label: `Type: ${typeLabel(state.type)}`, onRemove: () => set({ type: undefined }, false) });
  if (state.mine === 'true') applied.push({ key: 'mine', label: 'My teams', onRemove: () => set({ mine: undefined }, false) });
  if (state.unassigned === 'true') applied.push({ key: 'unassigned', label: 'With unassigned work', onRemove: () => set({ unassigned: undefined }, false) });
  if (state.breached === 'true') applied.push({ key: 'breached', label: 'With breached tickets', onRemove: () => set({ breached: undefined }, false) });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Teams" subtitle="Who works in which team, who leads it, and how much open work each team carries." actions={can('admin:users') ? <Button variant="outline" icon={<Settings2 className="h-4 w-4" />} onClick={() => navigate('/admin/teams')}>Manage in Administration</Button> : undefined} />
      {dir.isError && <ErrorBlock error={dir.error} retry={() => dir.refetch()} />}
      {dir.isLoading && <LoadingBlock />}
      {dir.data && (
        <ListShell
          id="teams"
          search={{ value: q, onChange: (v) => set({ q: v }, false), placeholder: 'Search teams or people…' }}
          activeCount={activeCount}
          onClear={clear}
          applied={applied}
          count={view === 'teams' ? `${fmtNumber(filteredTeams.length)} ${filteredTeams.length === 1 ? 'team' : 'teams'}` : `${fmtNumber(people.length)} ${people.length === 1 ? 'person' : 'people'}`}
          toolbar={<Segmented size="sm" options={[{ value: 'teams', label: 'By team', count: filteredTeams.length }, { value: 'people', label: 'By person', count: people.length }]} value={view} onChange={(v) => set({ view: v === 'people' ? 'people' : undefined }, false)} />}
          filters={
            <>
              <FilterGroup label="Team type">
                <FilterOptions options={typeOptions} value={state.type} onChange={(v) => set({ type: v as string | undefined }, false)} emptyLabel="No teams yet" />
              </FilterGroup>
              <FilterGroup label="Membership">
                <FilterToggle label="My teams" checked={state.mine === 'true'} onChange={(v) => set({ mine: v ? 'true' : undefined }, false)} />
              </FilterGroup>
              <FilterGroup label="Workload">
                <FilterToggle label="With unassigned work" hint="Tickets in the queue that nobody owns" checked={state.unassigned === 'true'} onChange={(v) => set({ unassigned: v ? 'true' : undefined }, false)} />
                <FilterToggle label="With breached tickets" hint="Open tickets past an SLA target" checked={state.breached === 'true'} onChange={(v) => set({ breached: v ? 'true' : undefined }, false)} />
              </FilterGroup>
            </>
          }
          insights={
            <InsightBand
              id="teams"
              summary={`${fmtNumber(dir.data.totals.teams)} teams · ${fmtNumber(dir.data.totals.people)} people`}
              kpis={[
                { label: 'Teams', value: fmtNumber(dir.data.totals.teams), hint: `${fmtNumber(dir.data.totals.people)} people · ${fmtNumber(dir.data.totals.multiTeam)} in more than one team`, icon: <UsersRound className="h-4 w-4" /> },
                { label: 'Open work in teams', value: fmtNumber(dir.data.totals.open), hint: 'tickets assigned to a team', icon: <Ticket className="h-4 w-4" />, onClick: () => navigate('/tickets') },
                { label: 'Waiting for an owner', value: fmtNumber(dir.data.totals.unassigned), tone: dir.data.totals.unassigned > 0 ? 'warn' : 'good', hint: 'in a team queue, nobody assigned', icon: <Users className="h-4 w-4" />, onClick: () => navigate('/tickets?assignee=unassigned') },
                { label: 'Breached in teams', value: fmtNumber(dir.data.totals.breached), tone: dir.data.totals.breached > 0 ? 'bad' : 'good', hint: 'open tickets past an SLA target', icon: <AlertTriangle className="h-4 w-4" />, onClick: () => navigate('/tickets?slaState=breached') },
              ]}
              panels={
                <>
                  <Panel title="Open tickets by team" subtitle="Breached tickets in red · click a team to open its queue">
                    <BreakdownBar dense items={[...teams].sort((a, b) => b.load.open - a.load.open).map((t) => ({ label: t.name, value: t.load.open, secondary: t.load.breached, secondaryLabel: 'breached', color: DOMAIN_COLORS[t.teamType] ?? null, href: `/tickets?teamId=${t.id}` }))} emptyText="No team queues" />
                  </Panel>
                  <Panel title="Largest teams" subtitle="People per team">
                    <BreakdownBar dense items={[...teams].sort((a, b) => b.members.length - a.members.length).slice(0, 8).map((t) => ({ label: t.name, value: t.members.length }))} emptyText="No teams yet" />
                  </Panel>
                </>
              }
            />
          }
        >
          {view === 'teams' && (
            filteredTeams.length === 0 ? <Card><EmptyState icon={<UsersRound className="h-5 w-5" />} title="No teams match" description={activeCount ? 'Adjust or clear the filters.' : undefined} /></Card> : (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                {filteredTeams.map((t, i) => (
                  <Card key={t.id} padded={false} className={cn('rise-in', `rise-in-${Math.min(4, i + 1)}`)}>
                    <div className="px-5 pt-4 pb-3 border-b border-default flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{t.name}</h2>
                          <Badge color={DOMAIN_COLORS[t.teamType] ?? 'slate'}>{typeLabel(t.teamType)}</Badge>
                          {t.members.some((m) => m.id === me?.id) && <Badge color="green">your team</Badge>}
                        </div>
                        <div className="text-[12.5px] text-muted mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                          {t.manager?.name && <span>Manager <span className="text-default">{t.manager.name}</span></span>}
                          {t.email && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{t.email}</span>}
                          {t.description && <span className="truncate">{t.description}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-4 shrink-0 text-[12.5px] tnum">
                        <Stat label="Open" value={t.load.open} to={`/tickets?teamId=${t.id}`} />
                        <Stat label="Unassigned" value={t.load.unassigned} tone={t.load.unassigned > 0 ? 'warn' : undefined} to={`/tickets?assignee=unassigned&teamId=${t.id}`} />
                        <Stat label="Breached" value={t.load.breached} tone={t.load.breached > 0 ? 'bad' : undefined} to={`/tickets?slaState=breached&teamId=${t.id}`} />
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
        </ListShell>
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
