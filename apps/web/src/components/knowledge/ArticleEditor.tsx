import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { Eye, PenLine, Columns2 } from 'lucide-react';
import { get, post, patch, ApiError } from '@/api/client';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { Button, Drawer, Field, Input, Select, Textarea } from '@/components/ui';
import { cn } from '@/lib/utils';

export const ARTICLE_TYPES = ['sop', 'runbook', 'troubleshooting', 'faq', 'known_error', 'resolution', 'procedure'] as const;
export const DOMAIN_OPTIONS = [
  { value: 'general', label: 'General' },
  { value: 'noc', label: 'NOC' },
  { value: 'soc', label: 'SOC' },
  { value: 'amc', label: 'AMC' },
  { value: 'service_desk', label: 'Service Desk' },
];

export interface KbCategory {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  parentId: string | null;
  domain: string;
  sortOrder: number;
  articleCount?: number;
}

export interface ArticleDetail {
  id: string;
  number: string;
  title: string;
  summary: string | null;
  body: string;
  categoryId: string | null;
  articleType: string;
  domain: string;
  visibility: string;
  customerId: string | null;
  serviceId: string | null;
  ciTypeKey: string | null;
  status: string;
  version: number;
  tags: string[];
  relatedTicketIds: string[];
  expiresAt: string | null;
}

interface FormState {
  title: string;
  summary: string;
  body: string;
  categoryId: string;
  articleType: string;
  domain: string;
  visibility: string;
  customerId: string;
  serviceId: string;
  ciTypeKey: string;
  tags: string;
  relatedTicketIds: string;
  expiresAt: string;
  changeNote: string;
}

function toForm(a?: ArticleDetail | null, defaults?: Partial<FormState>): FormState {
  return {
    title: a?.title ?? defaults?.title ?? '',
    summary: a?.summary ?? defaults?.summary ?? '',
    body: a?.body ?? defaults?.body ?? '',
    categoryId: a?.categoryId ?? defaults?.categoryId ?? '',
    articleType: a?.articleType ?? defaults?.articleType ?? 'procedure',
    domain: a?.domain ?? defaults?.domain ?? 'general',
    visibility: a?.visibility ?? defaults?.visibility ?? 'internal',
    customerId: a?.customerId ?? defaults?.customerId ?? '',
    serviceId: a?.serviceId ?? defaults?.serviceId ?? '',
    ciTypeKey: a?.ciTypeKey ?? defaults?.ciTypeKey ?? '',
    tags: a?.tags?.join(', ') ?? defaults?.tags ?? '',
    relatedTicketIds: a?.relatedTicketIds?.join(', ') ?? defaults?.relatedTicketIds ?? '',
    expiresAt: a?.expiresAt ? a.expiresAt.slice(0, 10) : defaults?.expiresAt ?? '',
    changeNote: '',
  };
}

function toPayload(f: FormState) {
  const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  return {
    title: f.title.trim(),
    summary: f.summary.trim() || null,
    body: f.body,
    categoryId: f.categoryId || null,
    articleType: f.articleType,
    domain: f.domain,
    visibility: f.visibility,
    customerId: f.visibility === 'customer' ? f.customerId || null : null,
    serviceId: f.serviceId || null,
    ciTypeKey: f.ciTypeKey || null,
    tags: split(f.tags),
    relatedTicketIds: split(f.relatedTicketIds),
    expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T23:59:59`).toISOString() : null,
  };
}

/**
 * Create / edit drawer with a side-by-side markdown preview. Saving a new
 * article creates a draft; "Save & publish" publishes immediately.
 */
export function ArticleEditor({ open, onClose, article, defaults, onSaved }: { open: boolean; onClose: () => void; article?: ArticleDetail | null; defaults?: Partial<FormState>; onSaved?: (a: ArticleDetail) => void }) {
  const qc = useQueryClient();
  const { options, lookups } = useLookups();
  const customers = useCustomersLookup();
  const categories = useQuery({ queryKey: ['knowledge', 'categories'], queryFn: () => get<{ items: KbCategory[] }>('/knowledge/categories'), staleTime: 60_000 });
  const [form, setForm] = useState<FormState>(() => toForm(article, defaults));
  const [mode, setMode] = useState<'edit' | 'split' | 'preview'>('split');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(toForm(article, defaults));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, article?.id]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const typeOptions = useMemo(() => {
    const seeded = options('kb_type');
    const base = seeded.length ? seeded.map((o) => ({ value: o.key, label: o.label })) : ARTICLE_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }));
    return base.filter((o) => (ARTICLE_TYPES as readonly string[]).includes(o.value));
  }, [options]);
  const categoryOptions = useMemo(() => {
    const cats = categories.data?.items ?? [];
    const byParent = new Map<string | null, KbCategory[]>();
    cats.forEach((c) => byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]));
    const out: { value: string; label: string }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const c of byParent.get(parent) ?? []) {
        out.push({ value: c.id, label: `${'— '.repeat(depth)}${c.name}` });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [categories.data]);

  const save = useMutation({
    mutationFn: async (publish: boolean) => {
      const payload = toPayload(form);
      if (!payload.title) throw new ApiError(422, 'A title is required');
      if (payload.visibility === 'customer' && !payload.customerId) throw new ApiError(422, 'Select the customer this article is written for');
      let saved: ArticleDetail;
      if (article) saved = await patch<ArticleDetail>(`/knowledge/${article.id}`, { ...payload, changeNote: form.changeNote.trim() || null });
      else saved = await post<ArticleDetail>('/knowledge', payload);
      if (publish && saved.status !== 'published') saved = await post<ArticleDetail>(`/knowledge/${saved.id}/publish`, {});
      return saved;
    },
    onSuccess: (saved, publish) => {
      toast.success(publish ? `${saved.number} published` : article ? `${saved.number} saved` : `${saved.number} created as draft`);
      qc.invalidateQueries({ queryKey: ['knowledge'] });
      onSaved?.(saved);
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save the article'),
  });

  const customerSelectAvailable = customers.data && !customers.isError;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={article ? `Edit ${article.number}` : 'New article'}
      width="max-w-5xl"
      footer={
        <>
          {error && <div className="text-xs text-red-600 mr-auto">{error}</div>}
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => save.mutate(false)} loading={save.isPending}>
            {article ? 'Save' : 'Save draft'}
          </Button>
          {(!article || article.status !== 'published') && (
            <Button onClick={() => save.mutate(true)} loading={save.isPending}>
              Save & publish
            </Button>
          )}
        </>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Title" required className="md:col-span-3">
          <Input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Short, searchable title" autoFocus />
        </Field>
        <Field label="Summary" className="md:col-span-3">
          <Textarea className="min-h-[52px]" value={form.summary} onChange={(e) => set('summary', e.target.value)} placeholder="One or two sentences shown in search results and suggestions" />
        </Field>
        <Field label="Category">
          <Select value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)} placeholder="Uncategorized" options={categoryOptions} />
        </Field>
        <Field label="Type">
          <Select value={form.articleType} onChange={(e) => set('articleType', e.target.value)} options={typeOptions} />
        </Field>
        <Field label="Domain">
          <Select value={form.domain} onChange={(e) => set('domain', e.target.value)} options={DOMAIN_OPTIONS} />
        </Field>
        <Field label="Visibility" hint={form.visibility === 'internal' ? 'MSP staff only' : form.visibility === 'public' ? 'All customer portals' : 'One customer portal'}>
          <Select
            value={form.visibility}
            onChange={(e) => set('visibility', e.target.value)}
            options={[
              { value: 'internal', label: 'Internal (MSP only)' },
              { value: 'customer', label: 'Customer-specific' },
              { value: 'public', label: 'Public (all customers)' },
            ]}
          />
        </Field>
        {form.visibility === 'customer' && (
          <Field label="Customer" required hint={customerSelectAvailable ? undefined : 'Customer directory unavailable — paste the customer ID'}>
            {customerSelectAvailable ? (
              <Select value={form.customerId} onChange={(e) => set('customerId', e.target.value)} placeholder="Select customer…" options={(customers.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} />
            ) : (
              <Input value={form.customerId} onChange={(e) => set('customerId', e.target.value)} placeholder="Customer ID" />
            )}
          </Field>
        )}
        <Field label="Service">
          <Select value={form.serviceId} onChange={(e) => set('serviceId', e.target.value)} placeholder="Any service" options={(lookups?.services ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        </Field>
        <Field label="CI type">
          <Select value={form.ciTypeKey} onChange={(e) => set('ciTypeKey', e.target.value)} placeholder="Any CI type" options={(lookups?.ciTypes ?? []).map((t) => ({ value: t.key, label: t.name }))} />
        </Field>
        <Field label="Tags" hint="Comma separated">
          <Input value={form.tags} onChange={(e) => set('tags', e.target.value)} placeholder="exchange, email, outage" />
        </Field>
        <Field label="Expires on" hint="Optional review/expiry date">
          <Input type="date" value={form.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} />
        </Field>
        <Field label="Related ticket IDs" hint="Comma separated UUIDs" className="md:col-span-2">
          <Input value={form.relatedTicketIds} onChange={(e) => set('relatedTicketIds', e.target.value)} placeholder="Optional" />
        </Field>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between mb-1">
          <label className="text-[12.5px] font-medium text-muted">Body (Markdown)</label>
          <div className="inline-flex rounded-md border border-default overflow-hidden text-xs">
            {(
              [
                ['edit', PenLine, 'Edit'],
                ['split', Columns2, 'Split'],
                ['preview', Eye, 'Preview'],
              ] as const
            ).map(([m, Icon, label]) => (
              <button key={m} className={cn('px-2 py-1 inline-flex items-center gap-1', mode === m ? 'bg-brand-600 text-white' : 'text-muted hover:bg-surface-2')} onClick={() => setMode(m)} type="button">
                <Icon className="h-3 w-3" /> {label}
              </button>
            ))}
          </div>
        </div>
        <div className={cn('grid gap-3', mode === 'split' ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1')}>
          {mode !== 'preview' && <Textarea className="min-h-[360px] font-mono text-[12.5px] leading-relaxed" value={form.body} onChange={(e) => set('body', e.target.value)} placeholder={'# Purpose\n\n## Steps\n1. ...\n\n## Verification\n...'} />}
          {mode !== 'edit' && (
            <div className="min-h-[360px] rounded-lg border border-default p-3 prose-sm text-[13px] overflow-auto bg-surface-2/30">
              {form.body.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{form.body}</ReactMarkdown> : <span className="text-subtle">Preview appears here.</span>}
            </div>
          )}
        </div>
      </div>

      {article && (
        <Field label="Change note" hint="Recorded in the version history when title, summary or body change" className="mt-4">
          <Input value={form.changeNote} onChange={(e) => set('changeNote', e.target.value)} placeholder="What changed and why" />
        </Field>
      )}
    </Drawer>
  );
}

export default ArticleEditor;
