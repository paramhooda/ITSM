import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Flame, Megaphone, PhoneCall, Plus, Sparkles, Send, X, CheckCircle2, ClipboardList, GitBranch, Lock, ExternalLink, Users, AlertTriangle } from 'lucide-react';
import { Button, Badge, Checkbox, Field, Input, Select, Textarea, Toggle, LoadingBlock, ErrorBlock, Avatar } from '@/components/ui';
import { useEngineers } from '@/hooks/useLookups';
import { fmtDateTime, fmtDuration, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Panel } from '../Panel';
import { EntityPicker, type PickerItem } from '../EntityPicker';
import { TicketStatusBadge } from '../TicketStatusBadge';
import { PriorityBadge } from '../PriorityBadge';
import { ticketsApi, qk } from '../api';
import { aiApi } from '@/components/ai/api';
import { useAuthStore } from '@/stores/auth';
import { AnnouncementDialog } from '@/components/announcements/AnnouncementDialog';
import { MAJOR_STATUS_LABELS, type MajorAudience, type MajorDetail, type MajorRecord, type PirAction, type TicketDetail } from '../types';

/**
 * Incident command for a major incident: the bridge and the roles, stakeholder updates on a
 * cadence (drafted by Grady on request), the communication log, child incidents and the
 * post-incident review. One related tab on the ticket, so the ticket stays the record.
 */

const INTERVALS = [15, 30, 60, 120, 240].map((m) => ({ value: String(m), label: m < 60 ? `Every ${m} min` : `Every ${m / 60} h` }));
const AUDIENCE: { key: keyof MajorAudience; label: string }[] = [
  { key: 'requester', label: 'Requester' },
  { key: 'customerContacts', label: 'Customer contacts' },
  { key: 'watchers', label: 'Watchers' },
  { key: 'accountManager', label: 'Account manager' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'team', label: 'Assigned team' },
  { key: 'manager', label: 'Team manager' },
];
const CHANNELS = [
  { key: 'email', label: 'Email' },
  { key: 'in_app', label: 'In app' },
  { key: 'whatsapp', label: 'WhatsApp' },
];
const DEFAULT_AUDIENCE: MajorAudience = { requester: true, customerContacts: true, watchers: true, accountManager: true };
const STATUS_COLOR: Record<MajorRecord['status'], string> = { active: 'red', resolved: 'amber', review_done: 'green', demoted: 'slate' };

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const localDate = (iso?: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');

export function MajorIncidentPanel({ ticket, canEdit }: { ticket: TicketDetail; canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.major(ticket.id), queryFn: () => ticketsApi.major(ticket.id), refetchInterval: 60_000 });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.major(ticket.id) });
    qc.invalidateQueries({ queryKey: qk.detail(ticket.id) });
    qc.invalidateQueries({ queryKey: qk.timeline(ticket.id) });
    qc.invalidateQueries({ queryKey: ['major-incidents'] });
    qc.invalidateQueries({ queryKey: ['dashboards'] });
  };
  if (q.isLoading) return <LoadingBlock label="Loading incident command…" />;
  if (q.isError || !q.data) return <ErrorBlock error={q.error} retry={() => q.refetch()} />;
  const { record, updates, children } = q.data;
  if (!record) return <div className="card p-5 text-[13px] text-muted">This ticket has not been declared a major incident.</div>;
  const live = record.status === 'active';
  const editable = canEdit && record.status !== 'demoted';
  return (
    <div className="flex flex-col gap-4">
      <CommandCard ticket={ticket} record={record} canEdit={editable} onDone={invalidate} />
      {editable && live && <UpdateComposer ticket={ticket} record={record} onDone={invalidate} />}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <CommsLog updates={updates} />
        <ChildIncidents ticket={ticket} data={q.data} canEdit={editable && live} onDone={invalidate} />
      </div>
      {record.status !== 'demoted' && <PirCard ticket={ticket} record={record} canEdit={canEdit} onDone={invalidate} />}
    </div>
  );
}

// ---------------------------------------------------------------- command

/** Publish a banner about this incident (outage notice for the customer by default); the dialog drafts it with Grady on request. */
function DraftAnnouncementButton({ ticket }: { ticket: TicketDetail }) {
  const can = useAuthStore((s) => s.can);
  const [open, setOpen] = useState(false);
  if (!can('announcements:manage')) return null;
  return (
    <>
      <Button size="sm" variant="outline" icon={<Megaphone className="h-3.5 w-3.5" />} onClick={() => setOpen(true)} title="Publish a banner about this incident to customers or staff">
        Draft announcement
      </Button>
      <AnnouncementDialog open={open} onClose={() => setOpen(false)} seed={{ type: 'outage', audience: 'customers', customerIds: [ticket.customerId], sourceTicketId: ticket.id, sourceTicket: { id: ticket.id, number: ticket.number } }} onSaved={() => setOpen(false)} />
    </>
  );
}

function CommandCard({ ticket, record, canEdit, onDone }: { ticket: TicketDetail; record: MajorRecord; canEdit: boolean; onDone: () => void }) {
  const engineers = useEngineers();
  const [bridge, setBridge] = useState(record.bridgeUrl ?? '');
  const [notes, setNotes] = useState(record.bridgeNotes ?? '');
  useEffect(() => {
    setBridge(record.bridgeUrl ?? '');
    setNotes(record.bridgeNotes ?? '');
  }, [record.bridgeUrl, record.bridgeNotes]);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => ticketsApi.updateMajor(ticket.id, body),
    onSuccess: () => {
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const people = (engineers.data ?? []).map((e) => ({ value: e.id, label: e.name }));
  const dueIn = record.nextUpdateDueAt ? Math.round((new Date(record.nextUpdateDueAt).getTime() - Date.now()) / 60_000) : null;
  const bridgeDirty = (bridge || '') !== (record.bridgeUrl ?? '') || (notes || '') !== (record.bridgeNotes ?? '');
  return (
    <Panel
      title={
        <>
          <Flame className="h-4 w-4 text-red-600" /> Incident command
          <Badge color={STATUS_COLOR[record.status]}>{MAJOR_STATUS_LABELS[record.status]}</Badge>
          {record.overdue && (
            <Badge color="red" className="gap-1">
              <AlertTriangle className="h-3 w-3" /> Update overdue
            </Badge>
          )}
        </>
      }
      actions={
        <>
          <DraftAnnouncementButton ticket={ticket} />
          {canEdit && record.status === 'active' ? (
            <Button size="sm" variant="outline" icon={<CheckCircle2 className="h-3.5 w-3.5" />} loading={save.isPending} onClick={() => save.mutate({ status: 'resolved' })} title="Service restored: stops the update cadence and opens the review">
              Mark resolved
            </Button>
          ) : canEdit && record.status === 'resolved' ? (
            <Button size="sm" variant="outline" loading={save.isPending} onClick={() => save.mutate({ status: 'active' })}>
              Re-open incident
            </Button>
          ) : null}
        </>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-3 text-[13px]">
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">Declared</div>
          <div title={fmtDateTime(record.declaredAt)}>
            {relativeTime(record.declaredAt)}
            {record.declaredByName && <span className="text-muted"> by {record.declaredByName}</span>}
          </div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">Last stakeholder update</div>
          <div title={record.lastUpdateAt ? fmtDateTime(record.lastUpdateAt) : undefined}>{record.lastUpdateAt ? relativeTime(record.lastUpdateAt) : <span className="text-muted">none yet</span>}</div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">Next update due</div>
          {record.status === 'active' && record.nextUpdateDueAt && dueIn !== null ? (
            <div className={cn(dueIn < 0 ? 'text-red-600 font-medium' : dueIn < 10 ? 'text-amber-600' : '')} title={fmtDateTime(record.nextUpdateDueAt)}>
              {dueIn < 0 ? `${fmtDuration(-dueIn)} overdue` : `in ${fmtDuration(dueIn)}`}
            </div>
          ) : (
            <div className="text-muted">{record.status === 'active' ? '—' : 'no further updates'}</div>
          )}
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">{record.status === 'resolved' || record.status === 'review_done' ? 'Resolved' : 'Portal banner'}</div>
          {record.status === 'resolved' || record.status === 'review_done' ? (
            <div title={record.resolvedAt ? fmtDateTime(record.resolvedAt) : undefined}>{record.resolvedAt ? relativeTime(record.resolvedAt) : '—'}</div>
          ) : (
            <Toggle checked={record.portalBanner} onChange={(v) => canEdit && save.mutate({ portalBanner: v })} label={record.portalBanner ? 'Shown to the customer' : 'Hidden'} />
          )}
        </div>
      </div>
      <div className="mt-4 pt-4 border-t border-default grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="Incident commander">
          {canEdit ? <Select value={record.commanderUserId ?? ''} onChange={(e) => save.mutate({ commanderUserId: e.target.value || null })} placeholder="Not set" options={people} className="h-8 py-0 text-[13px]" /> : <Person name={record.commanderName} />}
        </Field>
        <Field label="Communications lead" hint="Reminded when a stakeholder update is overdue">
          {canEdit ? <Select value={record.commsLeadUserId ?? ''} onChange={(e) => save.mutate({ commsLeadUserId: e.target.value || null })} placeholder="Not set" options={people} className="h-8 py-0 text-[13px]" /> : <Person name={record.commsLeadName} />}
        </Field>
        <Field label="Update cadence">
          {canEdit ? <Select value={String(record.updateIntervalMinutes)} onChange={(e) => save.mutate({ updateIntervalMinutes: Number(e.target.value) })} options={INTERVALS} className="h-8 py-0 text-[13px]" /> : <span>{INTERVALS.find((i) => i.value === String(record.updateIntervalMinutes))?.label ?? `${record.updateIntervalMinutes} min`}</span>}
        </Field>
      </div>
      <div className="mt-4 pt-4 border-t border-default grid grid-cols-1 md:grid-cols-[1fr_1.4fr] gap-4">
        <Field label="Bridge" hint="Conference link engineers join">
          {canEdit ? (
            <div className="flex items-center gap-2">
              <Input value={bridge} onChange={(e) => setBridge(e.target.value)} placeholder="https://meet.example.com/…" className="h-8 text-[13px]" />
              {record.bridgeUrl && (
                <a href={record.bridgeUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg bg-red-600 text-white text-[12.5px] font-medium hover:bg-red-700 whitespace-nowrap">
                  <PhoneCall className="h-3.5 w-3.5" /> Join
                </a>
              )}
            </div>
          ) : record.bridgeUrl ? (
            <a href={record.bridgeUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
              <PhoneCall className="h-3.5 w-3.5" /> Join the bridge <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            <span className="text-muted">No bridge</span>
          )}
        </Field>
        <Field label="Bridge notes" hint="Dial-in, passcode, who is on the call">
          {canEdit ? <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-[36px] text-[13px]" rows={2} /> : <span className="whitespace-pre-wrap">{record.bridgeNotes || <span className="text-muted">—</span>}</span>}
        </Field>
      </div>
      {canEdit && bridgeDirty && (
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ bridgeUrl: bridge.trim() || null, bridgeNotes: notes.trim() || null })}>
            Save bridge
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setBridge(record.bridgeUrl ?? '');
              setNotes(record.bridgeNotes ?? '');
            }}
          >
            Discard
          </Button>
        </div>
      )}
    </Panel>
  );
}

function Person({ name }: { name: string | null }) {
  if (!name) return <span className="text-muted">Not set</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Avatar name={name} size="xs" /> {name}
    </span>
  );
}

// ---------------------------------------------------------------- updates

function UpdateComposer({ ticket, record, onDone }: { ticket: TicketDetail; record: MajorRecord; onDone: () => void }) {
  const [kind, setKind] = useState<'stakeholder' | 'internal'>('stakeholder');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<MajorAudience>(DEFAULT_AUDIENCE);
  const [channels, setChannels] = useState<string[]>(['email', 'in_app', 'whatsapp']);
  const [banner, setBanner] = useState(record.portalBanner);
  const [drafted, setDrafted] = useState<{ aiGenerated: boolean } | null>(null);
  const post = useMutation({
    mutationFn: () => ticketsApi.postMajorUpdate(ticket.id, kind === 'stakeholder' ? { body: body.trim(), kind, audience, channels, portalBanner: banner } : { body: body.trim(), kind }),
    onSuccess: (r) => {
      toast.success(kind === 'stakeholder' ? `Update sent to ${r.sentCount} recipient${r.sentCount === 1 ? '' : 's'}` : 'Bridge note added');
      setBody('');
      setDrafted(null);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const draft = useMutation({
    mutationFn: () => aiApi.draftMajorUpdate(ticket.id, kind === 'stakeholder' ? 'customer' : 'internal'),
    onSuccess: (r) => {
      setBody(r.draft);
      setDrafted({ aiGenerated: r.aiGenerated });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const stakeholder = kind === 'stakeholder';
  const toggle = (k: keyof MajorAudience) => setAudience((a) => ({ ...a, [k]: !a[k] }));
  const toggleChannel = (c: string) => setChannels((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
  const nobody = stakeholder && !AUDIENCE.some((a) => audience[a.key]);
  return (
    <Panel
      title={
        <>
          <Megaphone className="h-4 w-4 text-subtle" /> Post an update
        </>
      }
      actions={
        <div className="inline-flex rounded-lg border border-default p-0.5 bg-surface-2 text-[12px]">
          <button type="button" onClick={() => setKind('stakeholder')} className={cn('px-2.5 h-6 rounded-md', stakeholder ? 'bg-white shadow-sm text-default font-medium' : 'text-muted hover:text-default')}>
            Stakeholder update
          </button>
          <button type="button" onClick={() => setKind('internal')} className={cn('px-2.5 h-6 rounded-md inline-flex items-center gap-1', !stakeholder ? 'bg-white shadow-sm text-default font-medium' : 'text-muted hover:text-default')}>
            <Lock className="h-3 w-3" /> Bridge note
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder={stakeholder ? 'What happened, what is affected, what we are doing, when the next update comes…' : 'Internal note for the bridge log (not sent to anyone)'} className="text-[13px]" data-testid="major-update-body" />
        {drafted && <div className="text-[11.5px] text-muted inline-flex items-center gap-1"><Sparkles className="h-3 w-3" /> {drafted.aiGenerated ? 'Drafted by Grady from the incident record and the latest notes. Read it before sending.' : 'Template draft (AI provider not configured). Edit before sending.'}</div>}
        {stakeholder && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-[12.5px]">
            <div>
              <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium mb-1.5 inline-flex items-center gap-1"><Users className="h-3 w-3" /> Audience</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {AUDIENCE.map((a) => (
                  <Checkbox key={a.key} label={a.label} checked={!!audience[a.key]} onChange={() => toggle(a.key)} className="text-[12.5px]" />
                ))}
              </div>
            </div>
            <div>
              <div className="text-[11.5px] uppercase tracking-wide text-subtle font-medium mb-1.5">Channels</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {CHANNELS.map((c) => (
                  <Checkbox key={c.key} label={c.label} checked={channels.includes(c.key)} onChange={() => toggleChannel(c.key)} className="text-[12.5px]" />
                ))}
              </div>
              <div className="mt-2">
                <Checkbox label="Show on the customer portal banner" checked={banner} onChange={(e) => setBanner(e.target.checked)} className="text-[12.5px]" />
              </div>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" icon={<Send className="h-3.5 w-3.5" />} loading={post.isPending} disabled={!body.trim() || nobody || (stakeholder && channels.length === 0)} onClick={() => post.mutate()} data-testid="major-update-send">
            {stakeholder ? 'Send update' : 'Add note'}
          </Button>
          <Button size="sm" variant="outline" icon={<Sparkles className="h-3.5 w-3.5" />} loading={draft.isPending} onClick={() => draft.mutate()} title="Grady drafts the update from the incident record">
            Draft with Grady
          </Button>
          {nobody && <span className="text-[12px] text-amber-600">Pick at least one audience.</span>}
          {stakeholder && !nobody && <span className="text-[12px] text-muted">Resets the cadence: the next update is due {INTERVALS.find((i) => i.value === String(record.updateIntervalMinutes))?.label.toLowerCase().replace('every ', '') ?? `${record.updateIntervalMinutes} min`} after sending.</span>}
        </div>
      </div>
    </Panel>
  );
}

function CommsLog({ updates }: { updates: MajorDetail['updates'] }) {
  return (
    <Panel
      title={
        <>
          <ClipboardList className="h-4 w-4 text-subtle" /> Communication log <span className="text-muted font-normal">· {updates.length}</span>
        </>
      }
      padded={false}
    >
      {updates.length === 0 ? (
        <div className="px-4 py-3 text-[12.5px] text-muted">No updates posted yet. Stakeholders only know what is in this log.</div>
      ) : (
        <ul className="divide-y divide-[var(--border)] max-h-[520px] overflow-y-auto">
          {updates.map((u) => (
            <li key={u.id} className="px-4 py-3 text-[13px]">
              <div className="flex items-center gap-2 flex-wrap text-[11.5px] text-muted">
                {u.kind === 'stakeholder' ? (
                  <Badge color="blue" className="gap-1">
                    <Megaphone className="h-3 w-3" /> Stakeholder update
                  </Badge>
                ) : (
                  <Badge color="slate" className="gap-1">
                    <Lock className="h-3 w-3" /> Bridge note
                  </Badge>
                )}
                <span>{u.authorName}</span>
                <span title={fmtDateTime(u.createdAt)}>· {relativeTime(u.createdAt)}</span>
                {u.kind === 'stakeholder' && (
                  <span className="ml-auto tnum">
                    {u.sentCount} sent · {u.channels.map((c) => (c === 'in_app' ? 'in app' : c === 'whatsapp' ? 'WhatsApp' : c)).join(', ')}
                    {u.portalBanner ? ' · portal' : ''}
                  </span>
                )}
              </div>
              <div className="mt-1.5 whitespace-pre-wrap text-default">{u.body}</div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- children

function ChildIncidents({ ticket, data, canEdit, onDone }: { ticket: TicketDetail; data: MajorDetail; canEdit: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<PickerItem[]>([]);
  const add = useMutation({
    mutationFn: () => ticketsApi.addMajorChild(ticket.id, { ticketId: target[0]!.id }),
    onSuccess: () => {
      setTarget([]);
      setOpen(false);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({ mutationFn: (childId: string) => ticketsApi.removeLink(childId, data.children.find((c) => c.id === childId)!.linkId), onSuccess: onDone, onError: (e: Error) => toast.error(e.message) });
  return (
    <Panel
      title={
        <>
          <GitBranch className="h-4 w-4 text-subtle" /> Child incidents <span className="text-muted font-normal">· {data.children.length}</span>
        </>
      }
      actions={canEdit ? <Button size="sm" variant="outline" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen((o) => !o)}>Add child</Button> : undefined}
      padded={false}
    >
      {open && canEdit && (
        <div className="px-4 py-3 border-b border-default flex flex-col sm:flex-row gap-2 sm:items-start">
          <EntityPicker
            className="flex-1"
            queryKey={`major-children-${ticket.customerId}`}
            placeholder="Ticket number or title…"
            value={target}
            onChange={setTarget}
            minChars={2}
            search={async (q) => (await ticketsApi.lookup(q, ticket.customerId, ticket.id)).items.map((t) => ({ id: t.id, label: `${t.number} · ${t.title}`, sublabel: t.status?.label ?? null }))}
          />
          <Button size="sm" onClick={() => add.mutate()} disabled={!target.length} loading={add.isPending}>
            Link as child
          </Button>
        </div>
      )}
      {data.children.length === 0 ? (
        <div className="px-4 py-3 text-[12.5px] text-muted">Tickets raised for the same outage are linked here so they close together.</div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {data.children.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-4 py-2 text-[13px] group">
              <Link to={`/tickets/${c.id}`} className="font-mono text-brand-700 hover:underline whitespace-nowrap">{c.number}</Link>
              <span className="truncate flex-1" title={c.title}>{c.title}</span>
              <PriorityBadge priority={c.priority} compact />
              <TicketStatusBadge status={c.status} />
              {canEdit && (
                <button onClick={() => remove.mutate(c.id)} className="text-subtle hover:text-red-600 opacity-0 group-hover:opacity-100" aria-label="Unlink child">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- post-incident review

function PirCard({ ticket, record, canEdit, onDone }: { ticket: TicketDetail; record: MajorRecord; canEdit: boolean; onDone: () => void }) {
  const engineers = useEngineers();
  const [what, setWhat] = useState(record.pirWhatHappened ?? '');
  const [impact, setImpact] = useState(record.pirImpact ?? '');
  const [cause, setCause] = useState(record.pirRootCause ?? '');
  const [actions, setActions] = useState<PirAction[]>(record.pirActions);
  const [newAction, setNewAction] = useState('');
  useEffect(() => {
    setWhat(record.pirWhatHappened ?? '');
    setImpact(record.pirImpact ?? '');
    setCause(record.pirRootCause ?? '');
    setActions(record.pirActions);
  }, [record.pirWhatHappened, record.pirImpact, record.pirRootCause, record.pirActions]);
  const dirty = useMemo(() => what !== (record.pirWhatHappened ?? '') || impact !== (record.pirImpact ?? '') || cause !== (record.pirRootCause ?? '') || JSON.stringify(actions) !== JSON.stringify(record.pirActions), [what, impact, cause, actions, record]);
  const save = useMutation({
    mutationFn: (complete: boolean) => ticketsApi.updateMajor(ticket.id, { pirWhatHappened: what.trim() || null, pirImpact: impact.trim() || null, pirRootCause: cause.trim() || null, pirActions: actions.map((a) => ({ ...a, ownerName: undefined })), ...(complete ? { status: 'review_done' } : {}) }),
    onSuccess: (_r, complete) => {
      toast.success(complete ? 'Post-incident review completed' : 'Review saved');
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const people = (engineers.data ?? []).map((e) => ({ value: e.id, label: e.name }));
  const done = record.status === 'review_done';
  const readOnly = !canEdit || done;
  const patchAction = (id: string, patch: Partial<PirAction>) => setActions((as) => as.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const complete = record.status === 'resolved' && what.trim() && cause.trim();
  const openActions = actions.filter((a) => !a.done).length;
  return (
    <Panel
      title={
        <>
          <ClipboardList className="h-4 w-4 text-subtle" /> Post-incident review
          {done ? <Badge color="green">Completed {record.pirCompletedAt ? relativeTime(record.pirCompletedAt) : ''}</Badge> : record.status === 'resolved' ? <Badge color="amber">Due</Badge> : <Badge color="slate">After resolution</Badge>}
          {actions.length > 0 && <span className="text-muted font-normal text-[12px]">· {openActions} of {actions.length} actions open</span>}
        </>
      }
      actions={
        !readOnly ? (
          <>
            <Button size="sm" variant="outline" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(false)}>
              Save
            </Button>
            <Button size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} loading={save.isPending} disabled={!complete} title={complete ? 'Closes the review; the record keeps the actions' : 'Needs a resolved incident, what happened and a root cause'} onClick={() => save.mutate(true)}>
              Complete review
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="What happened" hint="Timeline in plain words: detection, diagnosis, fix">
          {readOnly ? <ProseOrDash text={what} /> : <Textarea value={what} onChange={(e) => setWhat(e.target.value)} rows={4} className="text-[13px]" />}
        </Field>
        <Field label="Impact" hint="Who and what was affected, for how long">
          {readOnly ? <ProseOrDash text={impact} /> : <Textarea value={impact} onChange={(e) => setImpact(e.target.value)} rows={4} className="text-[13px]" />}
        </Field>
        <Field label="Root cause" hint="The cause, not the symptom; link a problem ticket for the fix">
          {readOnly ? <ProseOrDash text={cause} /> : <Textarea value={cause} onChange={(e) => setCause(e.target.value)} rows={4} className="text-[13px]" />}
        </Field>
      </div>
      <div className="mt-4 pt-4 border-t border-default">
        <div className="text-[12.5px] font-medium text-secondary mb-2">Follow-up actions</div>
        {actions.length === 0 && <div className="text-[12.5px] text-muted mb-2">No actions recorded.</div>}
        <ul className="flex flex-col gap-1.5">
          {actions.map((a) => (
            <li key={a.id} className="flex flex-col sm:flex-row sm:items-center gap-2 text-[13px]">
              <Checkbox checked={!!a.done} disabled={readOnly} onChange={(e) => patchAction(a.id, { done: e.target.checked })} />
              {readOnly ? <span className={cn('flex-1', a.done && 'line-through text-muted')}>{a.text}</span> : <Input value={a.text} onChange={(e) => patchAction(a.id, { text: e.target.value })} className="h-8 text-[13px] flex-1" />}
              {readOnly ? (
                <span className="text-[12px] text-muted whitespace-nowrap">{a.ownerName ?? 'Unowned'}{a.dueAt ? ` · due ${localDate(a.dueAt)}` : ''}</span>
              ) : (
                <>
                  <Select value={a.ownerId ?? ''} onChange={(e) => patchAction(a.id, { ownerId: e.target.value || null })} placeholder="Owner" options={people} className="h-8 py-0 text-[12.5px] sm:w-44" />
                  <Input type="date" value={localDate(a.dueAt)} onChange={(e) => patchAction(a.id, { dueAt: e.target.value ? new Date(`${e.target.value}T00:00:00`).toISOString() : null })} className="h-8 text-[12.5px] sm:w-40" />
                  <button type="button" onClick={() => setActions((as) => as.filter((x) => x.id !== a.id))} className="text-subtle hover:text-red-600" aria-label="Remove action">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        {!readOnly && (
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newAction.trim()) return;
              setActions((as) => [...as, { id: uid(), text: newAction.trim(), ownerId: null, dueAt: null, done: false }]);
              setNewAction('');
            }}
          >
            <Input value={newAction} onChange={(e) => setNewAction(e.target.value)} placeholder="Add a follow-up action…" className="h-8 text-[13px] flex-1" />
            <Button size="sm" variant="outline" type="submit" icon={<Plus className="h-3.5 w-3.5" />} disabled={!newAction.trim()}>
              Add
            </Button>
          </form>
        )}
      </div>
    </Panel>
  );
}

function ProseOrDash({ text }: { text: string }) {
  return text ? <div className="text-[13px] whitespace-pre-wrap">{text}</div> : <span className="text-muted text-[13px]">—</span>;
}
