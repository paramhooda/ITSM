import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Repeat, Phone, Mail, CalendarDays, Users, ShieldAlert, BellRing } from 'lucide-react';
import { PageHeader, Button, Badge, Avatar, DataTable, EmptyState, ErrorBlock, ListShell, FilterGroup, FilterSelect, Tabs, Select, ConfirmDialog, type AppliedFilter, type Column } from '@/components/ui';
import { Segmented } from '@/components/dashboards/Panel';
import { OPERATIONS_MODULES } from '@/layouts/modules';
import { useListState } from '@/hooks/useListState';
import { useLookups } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { errorMessage } from '@/components/admin/api';
import { startOfWeek, addDays, ymd } from '@/components/field/VisitCalendar';
import { RotaCalendar, toneFor } from '@/components/oncall/RotaCalendar';
import { RotaEditor } from '@/components/oncall/RotaEditor';
import { PolicyEditor } from '@/components/oncall/PolicyEditor';
import { CoverDialog } from '@/components/oncall/CoverDialog';
import { PagesPanel } from '@/components/oncall/PagesPanel';
import { oncallApi, oncallKeys, describeRotation, CHANNEL_LABELS, STEP_TARGET_LABELS, type OnCallTeam, type Policy, type Rota, type Shift } from '@/components/oncall/api';
import { cn } from '@/lib/utils';

type Tab = 'schedule' | 'rotas' | 'policies' | 'pages';
const TABS: { key: Tab; label: string }[] = [
  { key: 'schedule', label: 'Schedule' },
  { key: 'rotas', label: 'Rotas' },
  { key: 'policies', label: 'Escalation policies' },
  { key: 'pages', label: 'Pages' },
];

/** The "on call now" strip: one card per rota of each team, the person and when their cover ends. */
function NowStrip({ teams }: { teams: OnCallTeam[] }) {
  const cards = teams.flatMap((t) => t.rotas.map((r) => ({ team: t, rota: r })));
  if (!cards.length) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      {cards.map(({ team, rota }) => (
        <div key={rota.id} className={cn('card p-4 flex gap-3 border-l-4', rota.user ? 'border-l-emerald-400' : 'border-l-[var(--border)]')}>
          <Avatar name={rota.user?.name ?? '?'} size="md" />
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] uppercase tracking-wide text-subtle truncate">{team.name} · {rota.name}</div>
            <div className="font-semibold text-[14px] truncate">{rota.user?.name ?? <span className="text-muted italic font-normal">Nobody on call</span>}</div>
            <div className="text-[12px] text-muted truncate">
              {rota.override && <span className="inline-flex items-center gap-1 mr-2 text-amber-700"><Repeat className="h-3 w-3" /> cover{rota.override.reason ? `: ${rota.override.reason}` : ''}</span>}
              {rota.until ? `until ${fmtDateTime(rota.until)}` : ''}
            </div>
            {rota.user && (
              <div className="mt-1 flex flex-wrap gap-x-3 text-[12px]">
                {rota.user.phone && <a className="inline-flex items-center gap-1 text-brand-700 hover:underline" href={`tel:${rota.user.phone}`}><Phone className="h-3 w-3" />{rota.user.phone}</a>}
                <a className="inline-flex items-center gap-1 text-brand-700 hover:underline" href={`mailto:${rota.user.email}`}><Mail className="h-3 w-3" />{rota.user.email}</a>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function OnCallPage() {
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const manage = can('oncall:manage');
  const { state, set } = useListState({ tab: 'schedule' });
  const tab = (TABS.some((t) => t.key === state.tab) ? state.tab : 'schedule') as Tab;
  const teamId = state.teamId || '';
  const { lookups } = useLookups();
  const teams = useMemo(() => (lookups?.teams ?? []).map((t) => ({ id: t.id, name: t.name })), [lookups?.teams]);
  const weekStart = useMemo(() => (state.week ? startOfWeek(new Date(state.week + 'T00:00:00')) : startOfWeek(new Date())), [state.week]);

  const now = useQuery({ queryKey: oncallKeys.now(teamId || null), queryFn: () => oncallApi.now(teamId || null), refetchInterval: 60_000, placeholderData: (p) => p });
  const scheduleParams = useMemo(() => ({ teamId, from: new Date(weekStart).toISOString(), to: addDays(weekStart, 7).toISOString() }), [teamId, weekStart]);
  const schedule = useQuery({ queryKey: oncallKeys.schedule(scheduleParams), queryFn: () => oncallApi.schedule(scheduleParams), enabled: !!teamId && tab === 'schedule', placeholderData: (p) => p });
  const rotas = useQuery({ queryKey: oncallKeys.rotas(teamId || null), queryFn: () => oncallApi.rotas(teamId || null), enabled: tab !== 'pages' });
  const policies = useQuery({ queryKey: oncallKeys.policies, queryFn: oncallApi.policies, enabled: tab === 'policies' || tab === 'rotas' || tab === 'schedule' });

  const [rotaEditor, setRotaEditor] = useState<{ open: boolean; rota: Rota | null }>({ open: false, rota: null });
  const [policyEditor, setPolicyEditor] = useState<{ open: boolean; policy: Policy | null }>({ open: false, policy: null });
  const [cover, setCover] = useState<{ open: boolean; preset: { rotaId?: string; start?: Date; end?: Date } | null }>({ open: false, preset: null });
  const [confirm, setConfirm] = useState<{ kind: 'rota' | 'policy' | 'override'; id: string; label: string } | null>(null);
  const [pageView, setPageView] = useState<'open' | 'all'>('open');

  const invalidate = () => void qc.invalidateQueries({ queryKey: oncallKeys.all });
  const removeRota = useMutation({ mutationFn: (id: string) => oncallApi.deleteRota(id), onSuccess: () => { invalidate(); toast.success('Rota deleted'); setConfirm(null); }, onError: (e) => toast.error(errorMessage(e)) });
  const removePolicy = useMutation({ mutationFn: (id: string) => oncallApi.deletePolicy(id), onSuccess: () => { invalidate(); toast.success('Policy deleted'); setConfirm(null); }, onError: (e) => toast.error(errorMessage(e)) });
  const removeOverride = useMutation({ mutationFn: (id: string) => oncallApi.deleteOverride(id), onSuccess: () => { invalidate(); toast.success('Cover removed'); setConfirm(null); }, onError: (e) => toast.error(errorMessage(e)) });
  const setTeamPolicy = useMutation({ mutationFn: ({ id, policyId }: { id: string; policyId: string | null }) => oncallApi.setTeamPolicy(id, policyId), onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ['iam', 'teams'] }); toast.success('Default policy saved'); }, onError: (e) => toast.error(errorMessage(e)) });

  const applied: AppliedFilter[] = [];
  if (teamId) applied.push({ key: 'teamId', label: `Team: ${teams.find((t) => t.id === teamId)?.name ?? '…'}`, onRemove: () => set({ teamId: undefined }) });

  const filters = (
    <FilterGroup label="Team">
      <FilterSelect value={teamId} onChange={(e) => set({ teamId: e.target.value })} placeholder="All teams with a rota" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
    </FilterGroup>
  );

  const nowTeams = now.data?.teams ?? [];
  const selectedTeam = nowTeams.find((t) => t.id === teamId) ?? null;
  const rotaRows = rotas.data ?? [];
  const activePolicies = (policies.data ?? []).filter((p) => p.isActive);

  const onSelectShift = (shift: Shift) => setCover({ open: true, preset: { rotaId: shift.rotaId, start: new Date(shift.start), end: new Date(shift.end) } });

  const rotaColumns: Column<Rota>[] = [
    { key: 'name', header: 'Rota', render: (r) => (<div><div className="font-medium">{r.name}</div><div className="text-[12px] text-muted">{r.teamName}</div></div>) },
    { key: 'cadence', header: 'Cadence', render: (r) => <span className="text-muted">{describeRotation(r)}</span> },
    { key: 'participants', header: 'Rotation order', render: (r) => (
      <span className="inline-flex flex-wrap gap-1">
        {r.participants.map((p, i) => <span key={p.userId} className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px]', toneFor(p.userId))}><span className="font-mono opacity-70">{i + 1}</span>{p.name}</span>)}
        {!r.participants.length && <span className="text-subtle italic">nobody yet</span>}
      </span>
    ) },
    { key: 'timezone', header: 'Timezone', width: '140px', render: (r) => <span className="text-muted">{r.timezone}</span> },
    { key: 'isActive', header: 'Status', width: '90px', render: (r) => <Badge color={r.isActive ? 'emerald' : 'gray'} dot>{r.isActive ? 'Active' : 'Off'}</Badge> },
    ...(manage ? [{ key: 'actions', header: '', width: '90px', render: (r: Rota) => (
      <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="icon" aria-label="Edit rota" onClick={() => setRotaEditor({ open: true, rota: r })}><Pencil className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="icon" aria-label="Delete rota" onClick={() => setConfirm({ kind: 'rota', id: r.id, label: r.name })}><Trash2 className="h-3.5 w-3.5" /></Button>
      </span>
    ) }] : []),
  ];

  const policyColumns: Column<Policy>[] = [
    { key: 'name', header: 'Policy', render: (p) => (<div><div className="font-medium">{p.name}</div>{p.description && <div className="text-[12px] text-muted">{p.description}</div>}</div>) },
    { key: 'steps', header: 'Steps', render: (p) => (
      <ol className="flex flex-col gap-0.5 text-[12.5px]">
        {p.steps.map((s, i) => <li key={i} className="text-muted"><span className="font-mono text-subtle mr-1">{i + 1}.</span>{s.target === 'user' ? (s.userName ?? 'a person') : STEP_TARGET_LABELS[s.target]}{s.teamName ? ` of ${s.teamName}` : ''} · {s.channels.map((c) => CHANNEL_LABELS[c]).join(', ')} · {s.timeoutMinutes} min</li>)}
        {p.repeatCount > 0 && <li className="text-subtle">repeats {p.repeatCount}×</li>}
      </ol>
    ) },
    { key: 'teams', header: 'Default for', render: (p) => <span className="text-muted">{p.teams.map((t) => t.name).join(', ') || '—'}</span> },
    { key: 'assignOnAck', header: 'On ack', width: '110px', render: (p) => <span className="text-muted">{p.assignOnAck ? 'assigns ticket' : '—'}</span> },
    { key: 'isActive', header: 'Status', width: '90px', render: (p) => <Badge color={p.isActive ? 'emerald' : 'gray'} dot>{p.isActive ? 'Active' : 'Off'}</Badge> },
    ...(manage ? [{ key: 'actions', header: '', width: '90px', render: (p: Policy) => (
      <span className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="icon" aria-label="Edit policy" onClick={() => setPolicyEditor({ open: true, policy: p })}><Pencil className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="icon" aria-label="Delete policy" onClick={() => setConfirm({ kind: 'policy', id: p.id, label: p.name })}><Trash2 className="h-3.5 w-3.5" /></Button>
      </span>
    ) }] : []),
  ];

  const toolbar = (
    <div className="flex items-center gap-2">
      {tab === 'schedule' && teamId && rotaRows.length > 0 && <Button size="sm" variant="outline" icon={<Repeat className="h-3.5 w-3.5" />} onClick={() => setCover({ open: true, preset: null })}>Add cover</Button>}
      {tab === 'rotas' && manage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setRotaEditor({ open: true, rota: null })}>New rota</Button>}
      {tab === 'policies' && manage && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setPolicyEditor({ open: true, policy: null })}>New policy</Button>}
      {tab === 'pages' && <Segmented size="sm" options={[{ value: 'open', label: 'Waiting' }, { value: 'all', label: 'All recent' }]} value={pageView} onChange={setPageView} />}
    </div>
  );

  const countLine = tab === 'schedule' ? (nowTeams.length ? `${nowTeams.reduce((n, t) => n + t.rotas.filter((r) => r.user).length, 0)} on call across ${nowTeams.length} team${nowTeams.length === 1 ? '' : 's'}` : undefined) : tab === 'rotas' ? `${rotaRows.length} rota${rotaRows.length === 1 ? '' : 's'}` : tab === 'policies' ? `${policies.data?.length ?? 0} polic${(policies.data?.length ?? 0) === 1 ? 'y' : 'ies'}` : undefined;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="On-call" subtitle="Who covers each team, when the shift hands over, and whom a page reaches." />
      {now.isError && <ErrorBlock error={now.error} retry={() => now.refetch()} />}
      <ListShell id="oncall" modules={OPERATIONS_MODULES} filters={filters} applied={applied} activeCount={applied.length} onClear={() => set({ teamId: undefined })} toolbar={toolbar} count={countLine}>
        <Tabs tabs={TABS} value={tab} onChange={(t) => set({ tab: t }, false)} className="mb-3" />

        {tab === 'schedule' && (
          <div className="flex flex-col gap-4">
            {!now.isLoading && nowTeams.length === 0 && !teamId && (
              <EmptyState icon={<Users className="h-5 w-5" />} title="No rota yet" description={manage ? 'Create the first rota so escalations and pages know whom to reach.' : 'Nobody has set up a rota; ask an on-call manager.'} action={manage ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setRotaEditor({ open: true, rota: null })}>New rota</Button> : undefined} />
            )}
            <NowStrip teams={nowTeams} />
            {selectedTeam && (
              <div className="text-[12.5px] text-muted flex flex-wrap gap-x-4">
                <span>Manager: <strong className="text-default">{selectedTeam.managerName ?? '—'}</strong></span>
                <span>Default escalation policy: <strong className="text-default">{selectedTeam.escalationPolicyName ?? 'none'}</strong></span>
              </div>
            )}
            {teamId ? (
              <>
                {schedule.isError && <ErrorBlock error={schedule.error} retry={() => schedule.refetch()} />}
                <RotaCalendar weekStart={weekStart} rotas={schedule.data?.rotas ?? []} shifts={schedule.data?.shifts ?? []} onWeekChange={(d) => set({ week: ymd(d) }, false)} onSelect={onSelectShift} loading={schedule.isFetching} />
                {(schedule.data?.overrides.length ?? 0) > 0 && (
                  <div className="card">
                    <div className="px-4 py-2.5 border-b border-default text-[13px] font-semibold">Cover this week</div>
                    <ul className="divide-y divide-[var(--border)]">
                      {schedule.data!.overrides.map((o) => (
                        <li key={o.id} className="px-4 py-2 text-[13px] flex flex-wrap items-center gap-x-3 gap-y-1">
                          <Repeat className="h-3.5 w-3.5 text-amber-600" />
                          <span className="font-medium">{o.userName}</span>
                          <span className="text-muted">covers {o.rotaName} from {fmtDateTime(o.startsAt)} until {fmtDateTime(o.endsAt)}</span>
                          {o.reason && <span className="text-subtle">· {o.reason}</span>}
                          <span className="flex-1" />
                          {o.createdByName && <span className="text-subtle text-[12px]">added by {o.createdByName}</span>}
                          {o.mine && <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: 'override', id: o.id, label: `${o.userName}'s cover` })}>Remove</Button>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : nowTeams.length > 0 ? (
              <EmptyState icon={<CalendarDays className="h-5 w-5" />} title="Pick a team to see its calendar" description="The week view shows every rota of the team with cover applied; click a shift to add cover." />
            ) : null}
          </div>
        )}

        {tab === 'rotas' && (
          <div className="flex flex-col gap-4">
            {teamId && manage && (
              <div className="card p-4 flex flex-wrap items-center gap-3">
                <ShieldAlert className="h-4 w-4 text-subtle" />
                <span className="text-[13px] font-medium">Default escalation policy for {teams.find((t) => t.id === teamId)?.name}</span>
                <Select className="max-w-xs" value={selectedTeam?.escalationPolicyId ?? ''} onChange={(e) => setTeamPolicy.mutate({ id: teamId, policyId: e.target.value || null })} placeholder="None (pages must name a policy)" options={activePolicies.map((p) => ({ value: p.id, label: p.name }))} />
                <span className="text-[12px] text-muted">Used by "Page the team" and by escalation rules that page through the team's policy.</span>
              </div>
            )}
            <div className="card overflow-x-auto">
              <DataTable columns={rotaColumns} rows={rotaRows} loading={rotas.isLoading} dense onRowClick={manage ? (r) => setRotaEditor({ open: true, rota: r }) : undefined} empty={<EmptyState icon={<Users className="h-5 w-5" />} title="No rotas" description={manage ? 'Create a rota: the team, the rotation and who is in it.' : 'No rota has been set up for this team.'} action={manage ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setRotaEditor({ open: true, rota: null })}>New rota</Button> : undefined} />} />
            </div>
          </div>
        )}

        {tab === 'policies' && (
          <div className="card overflow-x-auto">
            <DataTable columns={policyColumns} rows={policies.data ?? []} loading={policies.isLoading} dense onRowClick={manage ? (p) => setPolicyEditor({ open: true, policy: p }) : undefined} empty={<EmptyState icon={<ShieldAlert className="h-5 w-5" />} title="No escalation policies" description="A policy lists whom a page reaches, over which channels, and how long to wait before the next step." action={manage ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setPolicyEditor({ open: true, policy: null })}>New policy</Button> : undefined} />} />
          </div>
        )}

        {tab === 'pages' && (
          <div className="card">
            <div className="px-4 py-2.5 border-b border-default text-[13px] font-semibold inline-flex items-center gap-2"><BellRing className="h-4 w-4 text-subtle" /> {pageView === 'open' ? 'Pages waiting for an acknowledgement' : 'Recent pages'}</div>
            <PagesPanel status={pageView === 'open' ? 'open' : null} showTicket limit={100} />
          </div>
        )}
      </ListShell>

      <RotaEditor open={rotaEditor.open} onClose={() => setRotaEditor({ open: false, rota: null })} rota={rotaEditor.rota} teamId={teamId || null} teams={teams} />
      <PolicyEditor open={policyEditor.open} onClose={() => setPolicyEditor({ open: false, policy: null })} policy={policyEditor.policy} />
      <CoverDialog open={cover.open} onClose={() => setCover({ open: false, preset: null })} rotas={(schedule.data?.rotas ?? rotaRows).filter((r) => r.isActive)} preset={cover.preset} />
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm ? `${confirm.kind === 'override' ? 'Remove' : 'Delete'} ${confirm.label}?` : ''}
        description={confirm?.kind === 'rota' ? 'Its participants and cover entries go with it; pages already sent are kept.' : confirm?.kind === 'policy' ? 'Teams using it as their default lose it; pages already sent are kept.' : 'The rotation decides again for that period.'}
        confirmLabel={confirm?.kind === 'override' ? 'Remove cover' : 'Delete'}
        danger
        loading={removeRota.isPending || removePolicy.isPending || removeOverride.isPending}
        onConfirm={() => confirm && (confirm.kind === 'rota' ? removeRota.mutate(confirm.id) : confirm.kind === 'policy' ? removePolicy.mutate(confirm.id) : removeOverride.mutate(confirm.id))}
      />
    </div>
  );
}
