import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Bot, Check, X } from 'lucide-react';
import { Button } from '@/components/ui';
import { errorMessage } from '@/components/admin/api';
import { cn } from '@/lib/utils';
import { aiApi, aiQk, type StoredSuggestion } from './api';
import type { TicketDetail } from '@/components/tickets/types';

type Kind = 'classification' | 'assignment' | 'duplicates';
const KINDS: Kind[] = ['classification', 'assignment', 'duplicates'];
const DAY = 86_400_000;

interface Chip {
  key: string;
  kind: Kind | 'done';
  tone: 'info' | 'good';
  text: string;
  detail?: string | null;
  suggestion?: StoredSuggestion;
  targetTicketId?: string | null;
  applyLabel?: string;
  link?: { to: string; label: string } | null;
}

const TONE = { info: 'bg-brand-50 text-brand-700 border-brand-200', good: 'bg-emerald-50 text-emerald-700 border-emerald-200' };

/**
 * What triage on arrival proposed for this ticket, under the attention strip:
 * a category and priority, an owner, a likely duplicate. Apply carries the
 * proposal out through the ticket services; Dismiss records the rejection.
 * A classification triage already applied shows for a day as a quiet note.
 */
export function TriageChips({ ticket, canUpdate, canAssign, canLink }: { ticket: TicketDetail; canUpdate: boolean; canAssign: boolean; canLink: boolean }) {
  const qc = useQueryClient();
  const [hidden, setHidden] = useState<string[]>([]);
  const q = useQuery({ queryKey: aiQk.suggestions(ticket.id), queryFn: () => aiApi.listSuggestions(ticket.id), staleTime: 30_000 });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: aiQk.suggestions(ticket.id) });
    void qc.invalidateQueries({ queryKey: ['tickets', ticket.id] });
    void qc.invalidateQueries({ queryKey: ['tickets', 'list'] });
  };
  const decide = useMutation({
    mutationFn: ({ id, status, targetTicketId }: { id: string; status: 'accepted' | 'rejected'; targetTicketId?: string | null }) => aiApi.decide(id, status, null, status === 'accepted' ? { apply: true, targetTicketId: targetTicketId ?? null } : undefined),
    onSuccess: (res) => {
      refresh();
      if (res.status === 'applied') toast.success('Applied');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const chips = useMemo<Chip[]>(() => {
    const items = (q.data?.items ?? []).filter((s) => s.payload.triage === true);
    const out: Chip[] = [];
    for (const kind of KINDS) {
      const s = items.filter((x) => x.kind === kind).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      if (!s) continue;
      const p = s.payload as Record<string, unknown>;
      if (kind === 'classification') {
        const labels = (p.labels ?? {}) as Record<string, string | null>;
        const conf = s.confidence != null ? ` (${s.confidence}% sure)` : '';
        if (s.status === 'applied' && Date.now() - new Date(s.createdAt).getTime() < DAY && !p.pending) {
          out.push({ key: s.id, kind: 'done', tone: 'good', text: `Classified by Grady as ${[labels.category, labels.subcategory].filter(Boolean).join(' / ') || 'a category'}${conf}` });
          continue;
        }
        if (s.status !== 'proposed' || !canUpdate) continue;
        const parts: string[] = [];
        if (p.categoryId && p.categoryId !== ticket.category?.id) parts.push(`category ${[labels.category, labels.subcategory].filter(Boolean).join(' / ')}`);
        if (p.priorityId && p.priorityId !== ticket.priority?.id && labels.priority) parts.push(`priority ${labels.priority}`);
        if (!parts.length) continue;
        out.push({ key: s.id, kind, tone: 'info', text: `Grady suggests ${parts.join(' and ')}${conf}`, detail: s.rationale, suggestion: s, applyLabel: 'Apply' });
      } else if (kind === 'assignment') {
        if (s.status !== 'proposed' || !canAssign) continue;
        const userId = typeof p.userId === 'string' ? p.userId : null;
        const teamId = typeof p.teamId === 'string' ? p.teamId : null;
        if ((!userId || userId === ticket.assignee?.id) && (!teamId || teamId === ticket.team?.id)) continue;
        const who = [typeof p.userName === 'string' ? p.userName : null, typeof p.teamName === 'string' ? p.teamName : null].filter(Boolean).join(' · ');
        out.push({ key: s.id, kind, tone: 'info', text: `Owner: ${who}`, detail: s.rationale, suggestion: s, applyLabel: 'Assign' });
      } else if (kind === 'duplicates') {
        if (s.status !== 'proposed' || !canLink) continue;
        const likely = (Array.isArray(p.likely) ? p.likely : []) as string[];
        const list = (Array.isArray(p.items) ? p.items : []) as { id: string; number: string; title: string }[];
        const first = list.find((i) => likely.includes(i.number));
        if (!first) continue;
        out.push({ key: s.id, kind, tone: 'info', text: `Possible duplicate of ${first.number}${likely.length > 1 ? ` (+${likely.length - 1} more)` : ''}`, detail: first.title, suggestion: s, targetTicketId: first.id, applyLabel: 'Link as duplicate', link: { to: `/tickets/${first.id}`, label: first.number } });
      }
    }
    return out.filter((c) => !hidden.includes(c.key));
  }, [q.data, ticket, canUpdate, canAssign, canLink, hidden]);

  if (!chips.length) return null;
  return (
    <section className="card relative overflow-hidden px-4 py-2.5">
      <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-brand-500" aria-hidden />
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted mr-1"><Bot className="h-3.5 w-3.5" /> Grady triage</span>
        {chips.map((c) => (
          <span key={c.key} className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 h-7 text-[12.5px] leading-none', TONE[c.tone])} title={c.detail ?? undefined}>
            {c.link ? <Link to={c.link.to} className="hover:underline">{c.text}</Link> : c.text}
            {c.suggestion && (
              <>
                <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[12px]" icon={<Check className="h-3 w-3" />} loading={decide.isPending && decide.variables?.id === c.suggestion.id} onClick={() => decide.mutate({ id: c.suggestion!.id, status: 'accepted', targetTicketId: c.targetTicketId })}>{c.applyLabel}</Button>
                <button type="button" className="inline-flex items-center text-subtle hover:text-default" aria-label="Dismiss" onClick={() => { setHidden((h) => [...h, c.key]); decide.mutate({ id: c.suggestion!.id, status: 'rejected' }); }}><X className="h-3 w-3" /></button>
              </>
            )}
            {c.kind === 'done' && <button type="button" className="inline-flex items-center text-subtle hover:text-default" aria-label="Hide" onClick={() => setHidden((h) => [...h, c.key])}><X className="h-3 w-3" /></button>}
          </span>
        ))}
      </div>
    </section>
  );
}
