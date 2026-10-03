import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, Send, Save, CheckCheck, Trash2, Clock, AlertTriangle, Siren, CalendarClock, Users, Inbox, Eye, Pencil } from 'lucide-react';
import { PageHeader, ListShell, Button, Badge, Card, DataTable, Drawer, EmptyState, ErrorBlock, LoadingBlock, Select, Textarea, Field, ConfirmDialog, Avatar, type Column } from '@/components/ui';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { Segmented } from '@/components/dashboards/Panel';
import { OPERATIONS_MODULES } from '@/layouts/modules';
import { useListState } from '@/hooks/useListState';
import { useAuthStore } from '@/stores/auth';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { HANDOVER_STATUS_COLORS, BREACH_RISK_COLORS } from '@/lib/statusColors';
import { handoverApi, handoverKeys, type Handover, type HandoverFacts, type HandoverTeam } from '@/components/handover/api';

const STATUS_LABEL: Record<string, string> = { draft: 'Draft', final: 'Published', acknowledged: 'Acknowledged' };
const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const describeDays = (days: number[]) => (days.length === 7 ? 'every day' : days.length === 5 && !days.includes(6) && !days.includes(7) ? 'weekdays' : days.map((d) => WEEKDAY[d - 1]).join(', '));

function Markdown({ body }: { body: string }) {
  return (
    <div className="prose-sm text-[13.5px] leading-relaxed [&_h2]:text-[12px] [&_h2]:uppercase [&_h2]:tracking-wide [&_h2]:text-subtle [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1.5 [&_ul]:pl-4 [&_ul]:list-disc [&_li]:my-0.5 [&_p]:my-1">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}

/** The digest lists: the tickets the incoming shift should look at, with a link each. */
function DigestLists({ facts }: { facts: HandoverFacts }) {
  const lists = facts.tickets.filter((l) => l.items.length);
  return (
    <div className="flex flex-col gap-4">
      {lists.map((l) => (
        <div key={l.key}>
          <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mb-1">{l.title} · {facts.counts[l.key === 'p1p2' ? 'p1p2' : l.key === 'atRisk' ? 'atRisk' : l.key === 'awaitingCustomer' ? 'awaitingCustomer' : l.key]}</div>
          <ul className="flex flex-col gap-1">
            {l.items.map((t) => (
              <li key={t.id} className="flex items-start gap-2 text-[12.5px]">
                <Link to={`/tickets/${t.id}`} className="font-mono text-brand-700 hover:underline whitespace-nowrap">{t.number}</Link>
                <span className="min-w-0 flex-1 truncate" title={t.title}>{t.title}</span>
                {t.priority && <Badge color="slate">{t.priority}</Badge>}
                {t.breachRisk && <Badge color={BREACH_RISK_COLORS[t.breachRisk] ?? 'slate'}>{t.breachRisk} risk</Badge>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {facts.major.length > 0 && (
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mb-1">Major incidents</div>
          <ul className="flex flex-col gap-1">
            {facts.major.map((m) => (
              <li key={m.id} className="flex items-start gap-2 text-[12.5px]">
                <Link to={`/tickets/${m.id}?tab=major`} className="font-mono text-brand-700 hover:underline whitespace-nowrap">{m.number}</Link>
                <span className="min-w-0 flex-1 truncate">{m.title}</span>
                {m.nextUpdateAt && <span className="text-subtle whitespace-nowrap">update {relativeTime(m.nextUpdateAt)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {facts.changes.length > 0 && (
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-subtle font-semibold mb-1">Changes in the next 12 hours</div>
          <ul className="flex flex-col gap-1">
            {facts.changes.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-[12.5px]">
                <Link to={`/tickets/${c.id}?tab=plan`} className="font-mono text-brand-700 hover:underline whitespace-nowrap">{c.number}</Link>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {c.scheduledStart && <span className="text-subtle whitespace-nowrap">{fmtDateTime(c.scheduledStart)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!lists.length && !facts.major.length && !facts.changes.length && <div className="text-[12.5px] text-subtle">Nothing open needs attention right now.</div>}
    </div>
  );
}

function OnCallCard({ facts }: { facts: HandoverFacts }) {
  const row = (label: string, people: { userId: string; name: string; rota: string | null }[], when: string | null) => (
    <div className="flex items-start gap-3">
      <div className="w-10 text-[11.5px] uppercase tracking-wide text-subtle font-semibold pt-0.5">{label}</div>
      <div className="flex-1 min-w-0">
        {people.length ? people.map((p) => (
          <div key={p.userId + label} className="flex items-center gap-2 text-[13px]">
            <Avatar name={p.name} size="sm" />
            <span className="font-medium truncate">{p.name}</span>
            {p.rota && <span className="text-subtle truncate">{p.rota}</span>}
          </div>
        )) : <span className="text-[12.5px] text-subtle italic">Nobody on a rota</span>}
        {when && people.length > 0 && <div className="text-[11.5px] text-subtle mt-0.5">{when}</div>}
      </div>
    </div>
  );
  return (
    <Card title="On call" actions={<Link to="/operations/on-call" className="text-[12px] text-brand-700 hover:underline">Rotas</Link>}>
      <div className="flex flex-col gap-3">
        {row('Now', facts.onCall.now, facts.onCall.now[0]?.until ? `until ${fmtDateTime(facts.onCall.now[0].until)}` : null)}
        {row('Next', facts.onCall.next, facts.onCall.next[0]?.from ? `from ${fmtDateTime(facts.onCall.next[0].from)}` : null)}
      </div>
    </Card>
  );
}

/** One handover in full: the note and the facts it was written from. */
function HandoverDrawer({ handover, onClose, canAck, onAck, acking }: { handover: Handover | null; onClose: () => void; canAck: boolean; onAck: (note: string) => void; acking: boolean }) {
  const [note, setNote] = useState('');
  useEffect(() => setNote(''), [handover?.id]);
  const h = handover;
  return (
    <Drawer open={!!h} onClose={onClose} title={h ? `${h.teamName ?? 'Team'} · ${h.shiftName ?? 'Shift'} · ${h.shiftDate}` : ''} width="max-w-3xl">
      {h && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
            <Badge color={HANDOVER_STATUS_COLORS[h.status] ?? 'slate'}>{STATUS_LABEL[h.status] ?? h.status}</Badge>
            <span>by <strong className="text-default">{h.authorName ?? 'unknown'}</strong></span>
            {h.publishedAt && <span>· published {fmtDateTime(h.publishedAt)}</span>}
            {h.acknowledgedAt && <span>· acknowledged by <strong className="text-default">{h.acknowledgedByName ?? 'someone'}</strong> {relativeTime(h.acknowledgedAt)}</span>}
          </div>
          {h.acknowledgementNote && <div className="rounded-lg border border-default bg-surface-2 px-3 py-2 text-[13px]"><span className="text-subtle">Incoming shift: </span>{h.acknowledgementNote}</div>}
          <div className="card p-4"><Markdown body={h.body || '_Empty handover._'} /></div>
          {h.facts && (
            <details className="card p-4">
              <summary className="cursor-pointer text-[12.5px] font-medium text-muted">Facts the handover was written from ({new Date(h.facts.generatedAt).toLocaleString()})</summary>
              <div className="mt-3"><DigestLists facts={h.facts} /></div>
            </details>
          )}
          {canAck && h.status === 'final' && (
            <div className="card p-4 flex flex-col gap-3">
              <Field label="Acknowledge the handover" hint="Optional note for the outgoing engineer"><Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Taken over; watching INC-… first." /></Field>
              <div className="flex justify-end"><Button icon={<CheckCheck className="h-4 w-4" />} loading={acking} onClick={() => onAck(note)}>Acknowledge</Button></div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

/**
 * Shift handover: pick a team, see the shift running now and the digest of what is open, breached,
 * at risk, major and scheduled next, draft the handover with Grady or by hand, publish it to the
 * incoming shift and acknowledge the one you take over.
 */
export default function HandoverPage() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const can = useAuthStore((s) => s.can);
  const { state, set } = useListState({});
  const teams = useQuery({ queryKey: handoverKeys.teams, queryFn: handoverApi.teams, refetchInterval: 120_000 });
  const teamItems = teams.data?.items ?? [];
  const teamId = state.team && teamItems.some((t) => t.id === state.team) ? state.team : (teamItems.find((t) => t.canWrite && t.shifts.length)?.id ?? teamItems.find((t) => t.shifts.length)?.id ?? teamItems[0]?.id ?? null);
  const team: HandoverTeam | null = teamItems.find((t) => t.id === teamId) ?? null;
  const digest = useQuery({ queryKey: handoverKeys.digest(teamId ?? ''), queryFn: () => handoverApi.digest(teamId!), enabled: !!teamId, refetchInterval: 120_000 });
  const history = useQuery({ queryKey: handoverKeys.list({ teamId, status: state.status || 'all' }), queryFn: () => handoverApi.list({ teamId: teamId ?? undefined, status: state.status || 'all', pageSize: 50 }), enabled: !!teamId, placeholderData: (p) => p });
  const [notes, setNotes] = useState('');
  const [body, setBody] = useState('');
  const [aiDraft, setAiDraft] = useState<string | null>(null);
  const [draftFacts, setDraftFacts] = useState<HandoverFacts | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [deleting, setDeleting] = useState<Handover | null>(null);
  useEffect(() => {
    setBody('');
    setAiDraft(null);
    setDraftFacts(null);
    setDraftId(null);
    setNotes('');
  }, [teamId]);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['handover'] });
  const open = useQuery({ queryKey: handoverKeys.one(state.handover ?? ''), queryFn: () => handoverApi.one(state.handover!), enabled: !!state.handover });

  const draft = useMutation({
    mutationFn: () => handoverApi.draft({ teamId: teamId!, notes: notes || undefined }),
    onSuccess: (d) => {
      setBody(d.body);
      setAiDraft(d.ai ? d.body : null);
      setDraftFacts(d.facts);
      setMode('preview');
      toast.success(d.ai ? 'Grady drafted the handover from the live digest' : 'Drafted from the live digest');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const save = useMutation({
    mutationFn: (publish: boolean) => (draftId ? handoverApi.update(draftId, { body }).then((h) => (publish ? handoverApi.publish(h.id) : h)) : handoverApi.create({ teamId: teamId!, body, aiDraft, facts: draftFacts, publish })),
    onSuccess: (h, publish) => {
      void invalidate();
      if (publish) {
        setBody('');
        setAiDraft(null);
        setDraftFacts(null);
        setDraftId(null);
        setNotes('');
        setMode('edit');
        toast.success('Handover published to the incoming shift');
        set({ handover: h.id }, false);
      } else {
        setDraftId(h.id);
        toast.success('Draft saved');
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const ack = useMutation({ mutationFn: ({ id, note }: { id: string; note: string }) => handoverApi.acknowledge(id, { note: note || undefined }), onSuccess: () => { void invalidate(); void open.refetch(); toast.success('Handover acknowledged'); }, onError: (e: Error) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: (id: string) => handoverApi.remove(id), onSuccess: () => { void invalidate(); setDeleting(null); toast.success('Handover deleted'); }, onError: (e: Error) => toast.error(e.message) });
  const publishPublished = useMutation({ mutationFn: (id: string) => handoverApi.publish(id), onSuccess: () => { void invalidate(); toast.success('Handover published to the incoming shift'); }, onError: (e: Error) => toast.error(e.message) });

  const facts = digest.data;
  const canWrite = !!team?.canWrite;
  const canManage = can('oncall:manage');
  const tiles = useMemo(() => {
    if (!facts) return [];
    const c = facts.counts;
    return [
      { label: 'Open', value: c.open, icon: <Inbox className="h-4 w-4" />, hint: `${c.openedInShift} opened · ${c.resolvedInShift} resolved this shift` },
      { label: 'P1 / P2', value: c.p1p2, tone: c.p1p2 ? 'warn' : 'good', icon: <AlertTriangle className="h-4 w-4" /> },
      { label: 'SLA breached', value: c.breached, tone: c.breached ? 'bad' : 'good', icon: <Clock className="h-4 w-4" />, hint: `${c.atRisk} at risk` },
      { label: 'Unassigned', value: c.unassigned, tone: c.unassigned ? 'warn' : 'default', icon: <Users className="h-4 w-4" />, hint: `${c.awaitingCustomer} waiting on the customer` },
      { label: 'Major incidents', value: c.major, tone: c.major ? 'bad' : 'good', icon: <Siren className="h-4 w-4" /> },
      { label: 'Changes next 12h', value: c.changesNext, icon: <CalendarClock className="h-4 w-4" /> },
    ] as const;
  }, [facts]);

  const columns: Column<Handover>[] = [
    { key: 'shift', header: 'Shift', render: (r) => <div><div className="font-medium">{r.shiftName ?? 'Shift'} · {r.shiftDate}</div><div className="text-[11.5px] text-subtle">{r.teamName}</div></div> },
    { key: 'author', header: 'Handed over by', render: (r) => <span className="text-muted">{r.authorName ?? '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => <Badge color={HANDOVER_STATUS_COLORS[r.status] ?? 'slate'}>{STATUS_LABEL[r.status] ?? r.status}</Badge> },
    { key: 'published', header: 'Published', render: (r) => <span className="text-muted whitespace-nowrap">{r.publishedAt ? relativeTime(r.publishedAt) : '—'}</span> },
    { key: 'ack', header: 'Acknowledged', render: (r) => (r.acknowledgedAt ? <span className="text-muted whitespace-nowrap">{r.acknowledgedByName ?? 'someone'} · {relativeTime(r.acknowledgedAt)}</span> : r.status === 'final' ? <span className="text-amber-700">Waiting</span> : <span className="text-subtle">—</span>) },
    {
      key: 'actions',
      header: '',
      className: 'text-right whitespace-nowrap',
      render: (r) => (
        <div className="inline-flex items-center gap-1">
          <Button size="sm" variant="outline" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => set({ handover: r.id }, false)}>Open</Button>
          {r.status === 'draft' && canWrite && r.authorId === user?.id && <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { setDraftId(r.id); setBody(r.body); setAiDraft(r.aiDraft); setDraftFacts(r.facts); setMode('edit'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Edit</Button>}
          {r.status === 'draft' && canWrite && r.authorId === user?.id && <Button size="sm" variant="outline" icon={<Send className="h-3.5 w-3.5" />} loading={publishPublished.isPending} onClick={() => publishPublished.mutate(r.id)}>Publish</Button>}
          {r.status === 'final' && canWrite && r.authorId !== user?.id && <Button size="sm" icon={<CheckCheck className="h-3.5 w-3.5" />} loading={ack.isPending} onClick={() => ack.mutate({ id: r.id, note: '' })}>Acknowledge</Button>}
          {((r.status === 'draft' && r.authorId === user?.id) || canManage) && <Button size="icon" variant="ghost" aria-label="Delete handover" onClick={() => setDeleting(r)}><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Shift handover"
        subtitle="What the incoming shift must watch: the live digest, the handover note and who took it over"
        actions={
          <Select value={teamId ?? ''} onChange={(e) => set({ team: e.target.value, handover: undefined }, false)} options={teamItems.map((t) => ({ value: t.id, label: `${t.name}${t.unacknowledged ? ` · ${t.unacknowledged} to acknowledge` : ''}` }))} placeholder={teams.isPending ? 'Loading teams…' : 'Choose a team'} />
        }
      />
      <ListShell id="handover" modules={OPERATIONS_MODULES}>
      {teams.isError && <ErrorBlock error={teams.error} retry={() => teams.refetch()} />}
      {teams.isPending && <LoadingBlock />}
      {teams.data && !team && <EmptyState icon={<Users className="h-5 w-5" />} title="No team to hand over" description="Teams appear here once they exist; add shifts to a team under Administration → Teams." />}
      {team && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">
            <div className="flex flex-col gap-4 min-w-0">
              <Card
                title={team.current ? `${team.current.name} shift · ends ${fmtDateTime(team.current.endsAt)}` : team.shifts.length ? 'No shift is running right now' : 'No shifts defined for this team'}
                actions={team.next ? <span className="text-[12px] text-muted">Next: {team.next.name} from {fmtDateTime(team.next.startsAt)}</span> : canManage ? <Link to="/admin/teams" className="text-[12px] text-brand-700 hover:underline">Set up shifts</Link> : null}
              >
                {digest.isError && <ErrorBlock error={digest.error} retry={() => digest.refetch()} />}
                {digest.isPending && <LoadingBlock label="Reading the queue…" />}
                {facts && <KpiGrid columns={3} items={[...tiles]} />}
              </Card>
              {canWrite ? (
                <Card
                  title={draftId ? 'Edit the draft' : 'Write the handover'}
                  actions={<Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }]} />}
                >
                  <div className="flex flex-col gap-3">
                    <Field label="Your notes for the incoming shift" hint="Anything the digest cannot know: workarounds in place, who promised what, what to chase">
                      <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Vendor callback on INC-… expected at 21:00; firewall change deferred to Thursday." />
                    </Field>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" icon={<Sparkles className="h-4 w-4" />} loading={draft.isPending} onClick={() => draft.mutate()}>Draft with Grady</Button>
                      {aiDraft && body !== aiDraft && <span className="text-[12px] text-subtle">Edited since the draft</span>}
                    </div>
                    {mode === 'edit' ? (
                      <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} className="font-mono text-[12.5px]" placeholder={'## Watch first\n- INC-… \n\n## Open and at risk\n…'} />
                    ) : (
                      <div className="rounded-lg border border-default p-4 min-h-[200px]">{body.trim() ? <Markdown body={body} /> : <span className="text-subtle text-[13px]">Nothing written yet. Draft with Grady or switch to Edit.</span>}</div>
                    )}
                    <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-default">
                      <Button variant="outline" icon={<Save className="h-4 w-4" />} loading={save.isPending && save.variables === false} disabled={!body.trim()} onClick={() => save.mutate(false)}>Save draft</Button>
                      <Button icon={<Send className="h-4 w-4" />} loading={save.isPending && save.variables === true} disabled={!body.trim()} onClick={() => save.mutate(true)}>Publish to the incoming shift</Button>
                    </div>
                  </div>
                </Card>
              ) : (
                <Card title="Handover notes">
                  <div className="text-[13px] text-muted">You can read this team's handovers; members of the team write and acknowledge them.</div>
                </Card>
              )}
            </div>
            <div className="flex flex-col gap-4 min-w-0">
              {facts && <OnCallCard facts={facts} />}
              {facts && <Card title="Watch list"><DigestLists facts={facts} /></Card>}
            </div>
          </div>
          <Card
            title="Handover history"
            actions={<Segmented size="sm" value={state.status || 'all'} onChange={(v) => set({ status: v === 'all' ? undefined : v }, false)} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'acknowledged', label: 'Acknowledged' }]} />}
            padded={false}
          >
            <DataTable columns={columns} rows={history.data?.items ?? []} loading={history.isPending} dense empty={<EmptyState icon={<Inbox className="h-5 w-5" />} title="No handover yet" description="The first handover for this team appears here once it is published." />} />
          </Card>
        </>
      )}
      </ListShell>
      <HandoverDrawer handover={open.data ?? null} onClose={() => set({ handover: undefined }, false)} canAck={canWrite && open.data?.authorId !== user?.id} onAck={(note) => open.data && ack.mutate({ id: open.data.id, note })} acking={ack.isPending} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete this handover?" description={deleting ? `${deleting.shiftName ?? 'Shift'} · ${deleting.shiftDate} by ${deleting.authorName ?? 'unknown'}. This cannot be undone.` : ''} confirmLabel="Delete" danger onConfirm={() => deleting && remove.mutate(deleting.id)} loading={remove.isPending} />
    </div>
  );
}
