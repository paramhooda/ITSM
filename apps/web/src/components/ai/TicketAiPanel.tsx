import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles, ChevronDown, ChevronRight, FileText, Tags, UserCheck, Lightbulb, MessageSquareText, CopyCheck, Check, X, Copy, Loader2, Send, Link2, AlertTriangle } from 'lucide-react';
import { Button, Badge, Select, Textarea, ProgressBar } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { ticketsApi } from '@/components/tickets/api';
import type { TicketDetail } from '@/components/tickets/types';
import { aiApi, aiQk, type SummaryResult, type ClassificationResult, type AssignmentResult, type ResolutionResult, type DraftResult, type DuplicateResult, type Tone } from './api';

type Kind = 'summary' | 'classification' | 'assignment' | 'resolution' | 'draft' | 'duplicates';
type Result = { summary: SummaryResult; classification: ClassificationResult; assignment: AssignmentResult; resolution: ResolutionResult; draft: DraftResult; duplicates: DuplicateResult };

const TONES: { value: Tone; label: string }[] = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'formal', label: 'Formal' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'apologetic', label: 'Apologetic' },
];

function copy(text: string) {
  navigator.clipboard?.writeText(text).then(() => toast.success('Copied to clipboard')).catch(() => toast.error('Could not copy'));
}

/**
 * "AI assistance" card for the ticket context panel. Every result is a
 * proposal: Apply calls the normal ticket endpoints, Accept/Reject records
 * the decision. Works without a provider (rule-based fallbacks).
 */
export function TicketAiPanel({ ticket }: { ticket: TicketDetail }) {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user)!;
  const isCustomer = user.userType === 'customer';
  const p = ticket.permissions;
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState<Kind | null>(null);
  const [results, setResults] = useState<Partial<Result>>({});
  const [decided, setDecided] = useState<Record<string, 'accepted' | 'rejected'>>({});
  const [tone, setTone] = useState<Tone>('neutral');
  const [draftText, setDraftText] = useState('');

  const status = useQuery({ queryKey: aiQk.status, queryFn: aiApi.status, staleTime: 60_000, retry: false });
  const enabled = !!status.data?.enabled;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['tickets', ticket.id] });

  const run = useMutation({
    mutationFn: async (kind: Kind) => {
      switch (kind) {
        case 'summary': return { kind, data: await aiApi.summarize(ticket.id) };
        case 'classification': return { kind, data: await aiApi.classify(ticket.id) };
        case 'assignment': return { kind, data: await aiApi.recommendAssignment(ticket.id) };
        case 'resolution': return { kind, data: await aiApi.resolutionSuggestions(ticket.id) };
        case 'draft': return { kind, data: await aiApi.draftCustomerUpdate(ticket.id, tone) };
        case 'duplicates': return { kind, data: await aiApi.duplicateCheck(ticket.id) };
      }
    },
    onSuccess: (res) => {
      setResults((r) => ({ ...r, [res.kind]: res.data }));
      setActive(res.kind);
      if (res.kind === 'draft') setDraftText((res.data as DraftResult).draft);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const decide = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'accepted' | 'rejected' }) => aiApi.decide(id, status),
    onSuccess: (_d, v) => setDecided((d) => ({ ...d, [v.id]: v.status })),
    onError: (e: Error) => toast.error(e.message),
  });

  const applyClassification = useMutation({
    mutationFn: (r: ClassificationResult) => ticketsApi.update(ticket.id, { categoryId: r.categoryId, subcategoryId: r.subcategoryId, impactId: r.impactId, urgencyId: r.urgencyId, ...(r.priorityId ? { priorityId: r.priorityId } : {}) }),
    onSuccess: (_d, r) => {
      decide.mutate({ id: r.suggestionId, status: 'accepted' });
      invalidate();
      toast.success('Classification applied');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const applyAssignment = useMutation({
    mutationFn: (r: AssignmentResult) => ticketsApi.assign(ticket.id, { teamId: r.teamId ?? undefined, assigneeId: r.userId ?? undefined, autoProgress: true }),
    onSuccess: (_d, r) => {
      decide.mutate({ id: r.suggestionId, status: 'accepted' });
      invalidate();
      toast.success('Assignment applied');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const postReply = useMutation({
    mutationFn: (r: DraftResult) => ticketsApi.comment(ticket.id, { kind: 'comment', body: draftText.trim() }),
    onSuccess: (_d, r) => {
      decide.mutate({ id: r.suggestionId, status: 'accepted' });
      qc.invalidateQueries({ queryKey: ['tickets', ticket.id] });
      toast.success('Reply posted');
      setActive(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const linkDuplicate = useMutation({
    mutationFn: ({ targetTicketId }: { targetTicketId: string; suggestionId: string }) => ticketsApi.addLink(ticket.id, { targetTicketId, linkType: 'duplicate_of' }),
    onSuccess: (_d, v) => {
      decide.mutate({ id: v.suggestionId, status: 'accepted' });
      invalidate();
      toast.success('Linked as duplicate');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const closed = ['closed', 'cancelled'].includes(ticket.status?.category ?? '');
  const actions: { kind: Kind; label: string; icon: typeof FileText; show: boolean }[] = [
    { kind: 'summary', label: 'Summarize', icon: FileText, show: true },
    { kind: 'classification', label: 'Classify', icon: Tags, show: !isCustomer && p.update && !closed },
    { kind: 'assignment', label: 'Suggest assignment', icon: UserCheck, show: !isCustomer && p.assign && !closed },
    { kind: 'resolution', label: 'Resolution ideas', icon: Lightbulb, show: !closed },
    { kind: 'draft', label: 'Draft customer update', icon: MessageSquareText, show: !isCustomer && p.comment && !closed },
    { kind: 'duplicates', label: 'Duplicates', icon: CopyCheck, show: !closed },
  ];

  const Decision = ({ id, onAccept, acceptLabel = 'Accept', accepting }: { id: string; onAccept?: () => void; acceptLabel?: string; accepting?: boolean }) => {
    const d = decided[id];
    if (d) return <span className={cn('text-[11.5px] inline-flex items-center gap-1', d === 'accepted' ? 'text-green-700 dark:text-green-300' : 'text-subtle')}>{d === 'accepted' ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />} {d === 'accepted' ? 'Accepted' : 'Rejected'}</span>;
    return (
      <div className="flex items-center gap-1.5">
        <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} loading={accepting} onClick={onAccept ?? (() => decide.mutate({ id, status: 'accepted' }))}>{acceptLabel}</Button>
        <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => decide.mutate({ id, status: 'rejected' })}>Reject</Button>
      </div>
    );
  };

  const Source = ({ r }: { r: { aiGenerated: boolean } }) => (
    <span className="text-[11px] text-subtle">{r.aiGenerated ? `Generated by ${status.data?.provider ?? 'AI'}` : 'Rule-based suggestion'}</span>
  );

  function renderResult() {
    if (!active) return null;
    const r = results[active];
    if (!r) return null;
    switch (active) {
      case 'summary': {
        const s = r as SummaryResult;
        return (
          <div className="space-y-2">
            <p className="text-[12.5px] leading-relaxed">{s.summary}</p>
            {s.keyFacts.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-subtle font-medium">Key facts</div>
                <ul className="list-disc pl-4 text-[12px] space-y-0.5">{s.keyFacts.map((f, i) => <li key={i}>{f}</li>)}</ul>
              </div>
            )}
            {s.nextSteps.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-subtle font-medium">Next steps</div>
                <ul className="list-disc pl-4 text-[12px] space-y-0.5">{s.nextSteps.map((f, i) => <li key={i}>{f}</li>)}</ul>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <Source r={s} />
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(`${s.summary}\n\nKey facts:\n${s.keyFacts.map((f) => `- ${f}`).join('\n')}\n\nNext steps:\n${s.nextSteps.map((f) => `- ${f}`).join('\n')}`)}>Copy</Button>
                <Decision id={s.suggestionId} acceptLabel="Helpful" />
              </div>
            </div>
          </div>
        );
      }
      case 'classification': {
        const c = r as ClassificationResult;
        const rows: { label: string; value: string | null; changed: boolean }[] = [
          { label: 'Category', value: c.labels.category, changed: c.categoryId !== (c.current?.categoryId ?? ticket.categoryId) },
          { label: 'Subcategory', value: c.labels.subcategory, changed: c.subcategoryId !== (c.current?.subcategoryId ?? ticket.subcategoryId) },
          { label: 'Impact', value: c.labels.impact, changed: c.impactId !== (c.current?.impactId ?? ticket.impactId) },
          { label: 'Urgency', value: c.labels.urgency, changed: c.urgencyId !== (c.current?.urgencyId ?? ticket.urgencyId) },
          { label: 'Priority', value: c.labels.priority, changed: c.priorityId !== (c.current?.priorityId ?? ticket.priorityId) },
        ];
        return (
          <div className="space-y-2">
            <div className="grid grid-cols-[90px_1fr] gap-x-2 gap-y-1 text-[12.5px]">
              {rows.map((row) => (
                <div key={row.label} className="contents">
                  <span className="text-[11.5px] uppercase tracking-wide text-subtle font-medium">{row.label}</span>
                  <span className={cn(row.changed && row.value ? 'font-medium' : 'text-muted')}>{row.value ?? '—'}{row.changed && row.value ? <span className="ml-1 text-[10.5px] text-brand-700 dark:text-brand-300">changed</span> : null}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 text-[11.5px] text-muted">
              <span>Confidence</span>
              <div className="flex-1"><ProgressBar pct={c.confidence} tone={c.confidence >= 70 ? 'good' : c.confidence >= 40 ? 'warn' : 'bad'} /></div>
              <span>{c.confidence}%</span>
            </div>
            <div className="text-[12px] text-muted">{c.rationale}</div>
            <div className="flex items-center justify-between gap-2">
              <Source r={c} />
              <Decision id={c.suggestionId} acceptLabel="Apply" accepting={applyClassification.isPending} onAccept={() => applyClassification.mutate(c)} />
            </div>
          </div>
        );
      }
      case 'assignment': {
        const a = r as AssignmentResult;
        const same = a.teamId === ticket.assignedTeamId && a.userId === ticket.assigneeId;
        return (
          <div className="space-y-2">
            <div className="text-[12.5px]">
              {a.userName || a.teamName ? (
                <>
                  Assign to <span className="font-medium">{a.userName ?? 'no specific engineer'}</span>{a.teamName ? <> in <span className="font-medium">{a.teamName}</span></> : null}
                  {same && <span className="ml-1 text-[11px] text-subtle">(already assigned)</span>}
                </>
              ) : (
                <span className="text-muted">No confident recommendation.</span>
              )}
            </div>
            <div className="text-[12px] text-muted">{a.rationale}</div>
            {a.alternatives.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-subtle font-medium">Candidates</div>
                <ul className="text-[12px] space-y-0.5">
                  {a.alternatives.map((alt) => (
                    <li key={alt.userId} className="flex items-center justify-between gap-2">
                      <span className="truncate">{alt.name}</span>
                      <span className="text-subtle shrink-0">{alt.resolvedSimilar} similar · {alt.resolvedForCustomer} for customer · {alt.openLoad} open</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <Source r={a} />
              {(a.userId || a.teamId) && !same ? <Decision id={a.suggestionId} acceptLabel="Apply" accepting={applyAssignment.isPending} onAccept={() => applyAssignment.mutate(a)} /> : <Decision id={a.suggestionId} acceptLabel="Noted" />}
            </div>
          </div>
        );
      }
      case 'resolution': {
        const s = r as ResolutionResult;
        return (
          <div className="space-y-2">
            {s.suggestions.length === 0 && <div className="text-[12.5px] text-muted">No resolved similar tickets or matching articles yet.</div>}
            {s.suggestions.map((sg, i) => (
              <div key={i} className="rounded-md border border-default p-2">
                <div className="flex items-center gap-2 text-[12px]">
                  <Badge color={sg.source === 'kb' ? 'violet' : 'slate'}>{sg.source === 'kb' ? 'Article' : 'Ticket'}</Badge>
                  {sg.link ? <Link to={sg.link} className="font-mono text-brand-700 dark:text-brand-300 hover:underline">{sg.ref}</Link> : <span className="font-mono">{sg.ref}</span>}
                  <span className="truncate text-muted" title={sg.title}>{sg.title}</span>
                </div>
                <ol className="list-decimal pl-4 mt-1 text-[12px] space-y-0.5">{sg.steps.map((st, j) => <li key={j}>{st}</li>)}</ol>
              </div>
            ))}
            <div className="flex items-center justify-between gap-2">
              <Source r={s} />
              {s.suggestions.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(s.suggestions.map((sg) => `${sg.ref} ${sg.title}\n${sg.steps.map((st, j) => `${j + 1}. ${st}`).join('\n')}`).join('\n\n'))}>Copy</Button>
                  <Decision id={s.suggestionId} acceptLabel="Helpful" />
                </div>
              )}
            </div>
          </div>
        );
      }
      case 'draft': {
        const d = r as DraftResult;
        return (
          <div className="space-y-2">
            <Textarea value={draftText} onChange={(e) => setDraftText(e.target.value)} className="min-h-[140px] text-[12.5px]" />
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <Source r={d} />
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(draftText)}>Copy</Button>
                {decided[d.suggestionId] ? (
                  <span className="text-[11.5px] text-subtle">{decided[d.suggestionId] === 'accepted' ? 'Posted' : 'Rejected'}</span>
                ) : (
                  <>
                    <Button size="sm" icon={<Send className="h-3.5 w-3.5" />} loading={postReply.isPending} disabled={!draftText.trim()} onClick={() => postReply.mutate(d)}>Post as reply</Button>
                    <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => decide.mutate({ id: d.suggestionId, status: 'rejected' })}>Reject</Button>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      }
      case 'duplicates': {
        const d = r as DuplicateResult;
        const alreadyLinked = new Set(ticket.links.map((l) => l.ticket.id));
        return (
          <div className="space-y-2">
            {d.items.length === 0 && <div className="text-[12.5px] text-muted inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-green-600" /> No likely duplicates among open tickets of this customer.</div>}
            {d.items.map((it) => (
              <div key={it.id} className="rounded-md border border-default p-2">
                <div className="flex items-center gap-2 text-[12px]">
                  <Link to={it.link} className="font-mono text-brand-700 dark:text-brand-300 hover:underline">{it.number}</Link>
                  <span className="truncate" title={it.title}>{it.title}</span>
                  <Badge color={it.score >= 0.6 ? 'red' : it.score >= 0.4 ? 'amber' : 'slate'} className="ml-auto shrink-0">{Math.round(it.score * 100)}%</Badge>
                </div>
                <div className="text-[11.5px] text-subtle mt-0.5">{it.status} · {it.reasons.join(', ')}</div>
                {!isCustomer && p.links && !alreadyLinked.has(it.id) && (
                  <div className="mt-1">
                    <Button size="sm" variant="outline" icon={<Link2 className="h-3.5 w-3.5" />} loading={linkDuplicate.isPending} onClick={() => linkDuplicate.mutate({ targetTicketId: it.id, suggestionId: d.suggestionId })}>Mark as duplicate of {it.number}</Button>
                  </div>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between gap-2">
              <Source r={d} />
              {d.items.length > 0 && !decided[d.suggestionId] && <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => decide.mutate({ id: d.suggestionId, status: 'rejected' })}>Not duplicates</Button>}
              {decided[d.suggestionId] && <span className="text-[11.5px] text-subtle">{decided[d.suggestionId] === 'accepted' ? 'Linked' : 'Dismissed'}</span>}
            </div>
          </div>
        );
      }
    }
  }

  return (
    <div className="card">
      <button className="w-full flex items-center justify-between gap-3 px-4 py-2.5 border-b border-default text-left" onClick={() => setOpen((v) => !v)}>
        <span className="font-semibold text-[13px] inline-flex items-center gap-2"><Sparkles className="h-4 w-4 text-brand-600" /> AI assistance</span>
        <span className="flex items-center gap-2">
          {status.data && !enabled && <span className="text-[10.5px] text-amber-700 dark:text-amber-300 inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> AI not configured — rule-based</span>}
          {open ? <ChevronDown className="h-4 w-4 text-subtle" /> : <ChevronRight className="h-4 w-4 text-subtle" />}
        </span>
      </button>
      {open && (
        <div className="p-3 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {actions.filter((a) => a.show).map((a) => (
              <button
                key={a.kind}
                onClick={() => (results[a.kind] && active !== a.kind ? setActive(a.kind) : run.mutate(a.kind))}
                disabled={run.isPending}
                className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-60', active === a.kind ? 'border-brand-500 bg-brand-600/10 text-brand-700 dark:text-brand-300' : 'border-default text-muted hover:text-default hover:bg-surface-2')}
              >
                {run.isPending && run.variables === a.kind ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <a.icon className="h-3.5 w-3.5" />}
                {a.label}
              </button>
            ))}
          </div>
          {active === 'draft' && (
            <div className="flex items-center gap-2 text-[12px]">
              <span className="text-subtle">Tone</span>
              <Select value={tone} onChange={(e) => setTone(e.target.value as Tone)} className="h-7 py-0 text-[12px] w-36" options={TONES} />
              <Button size="sm" variant="ghost" loading={run.isPending} onClick={() => run.mutate('draft')}>Regenerate</Button>
            </div>
          )}
          {active && results[active] && (
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">{renderResult()}</div>
              <button className="text-subtle hover:text-default shrink-0" title="Hide" onClick={() => setActive(null)}><X className="h-3.5 w-3.5" /></button>
            </div>
          )}
          {!active && !run.isPending && <div className="text-[12px] text-subtle">Proposals only: nothing is applied until you accept it.</div>}
        </div>
      )}
    </div>
  );
}
