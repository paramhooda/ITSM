import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { ArrowLeft, PenLine, Send, Archive, ArchiveRestore, Trash2, ThumbsUp, ThumbsDown, Eye, RotateCcw, Tag, Ticket as TicketIcon } from 'lucide-react';
import { get, post, del, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useLookups } from '@/hooks/useLookups';
import { Badge, Button, Card, ConfirmDialog, Dialog, ErrorBlock, KeyValue, LoadingBlock, PageHeader } from '@/components/ui';
import { ArticleEditor, type ArticleDetail } from '@/components/knowledge/ArticleEditor';
import { STATUS_COLORS, VisibilityBadge } from '@/components/knowledge/ArticleCard';
import { AttachmentList } from '@/components/attachments/AttachmentList';
import { AuditTrail } from '@/components/audit/AuditTrail';
import { fmtDate, fmtDateTime, relativeTime, titleCase } from '@/lib/format';

interface ArticleFull extends ArticleDetail {
  categoryName: string | null;
  categoryKey: string | null;
  customerName: string | null;
  serviceName: string | null;
  authorId: string | null;
  authorName: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  publishedAt: string | null;
  viewCount: number;
  helpfulCount: number;
  notHelpfulCount: number;
  createdAt: string;
  updatedAt: string;
  versions: { version: number; changedBy: string | null; changedByName: string | null; changeNote: string | null; createdAt: string }[];
  relatedTickets: { id: string; number: string; title: string; type: string; status: string | null; statusColor: string | null }[];
  canManage: boolean;
}

interface VersionDetail {
  version: number;
  title: string;
  summary: string | null;
  body: string;
  changedByName: string | null;
  changeNote: string | null;
  createdAt: string;
}

const votedKey = (id: string) => `itsm.kb.voted.${id}`;

export default function KnowledgeArticlePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useAuthStore((s) => s.can);
  const isCustomer = useAuthStore((s) => s.user?.userType === 'customer');
  const setAssistantContext = useUiStore((s) => s.setAssistantContext);
  const { options } = useLookups();
  const [editorOpen, setEditorOpen] = useState(false);
  const [confirm, setConfirm] = useState<'archive' | 'delete' | 'unarchive' | null>(null);
  const [restoreVersion, setRestoreVersion] = useState<number | null>(null);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [voted, setVoted] = useState<string | null>(() => {
    try {
      return localStorage.getItem(votedKey(id));
    } catch {
      return null;
    }
  });

  // The first load counts as a view; refetches (after edits, feedback...) do not.
  const viewed = useRef<string | null>(null);
  const article = useQuery({
    queryKey: ['knowledge', id],
    queryFn: () => {
      const first = viewed.current !== id;
      viewed.current = id;
      return get<ArticleFull>(`/knowledge/${id}`, first ? undefined : { noView: 1 });
    },
    enabled: !!id,
    staleTime: 60_000,
  });
  const version = useQuery({ queryKey: ['knowledge', id, 'version', viewVersion], queryFn: () => get<VersionDetail>(`/knowledge/${id}/versions/${viewVersion}`), enabled: viewVersion !== null });

  const a = article.data;
  useEffect(() => {
    if (a) setAssistantContext({ label: a.number, entityType: 'kb_article', entityId: a.id, title: a.title });
    return () => setAssistantContext(null);
  }, [a, setAssistantContext]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['knowledge'] });
  };
  const action = useMutation({
    mutationFn: (kind: 'publish' | 'archive' | 'unarchive' | 'delete' | 'restore') => {
      if (kind === 'delete') return del(`/knowledge/${id}`);
      if (kind === 'restore') return post(`/knowledge/${id}/restore-version/${restoreVersion}`, {});
      return post(`/knowledge/${id}/${kind}`, {});
    },
    onSuccess: (_res, kind) => {
      setConfirm(null);
      setRestoreVersion(null);
      invalidate();
      if (kind === 'delete') {
        toast.success('Draft deleted');
        navigate('/knowledge');
      } else toast.success(kind === 'publish' ? 'Article published' : kind === 'archive' ? 'Article archived' : kind === 'unarchive' ? 'Article restored to draft' : 'Version restored');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Action failed'),
  });
  const feedback = useMutation({
    mutationFn: (helpful: boolean) => post<{ helpfulCount: number; notHelpfulCount: number }>(`/knowledge/${id}/feedback`, { helpful }),
    onSuccess: (_res, helpful) => {
      const v = helpful ? 'up' : 'down';
      setVoted(v);
      try {
        localStorage.setItem(votedKey(id), v);
      } catch {
        /* ignore */
      }
      toast.success('Thanks for your feedback');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record feedback'),
  });

  if (article.isLoading) return <LoadingBlock />;
  if (article.isError || !a) return <ErrorBlock error={article.error} retry={() => article.refetch()} />;

  const canManage = !isCustomer && can('kb:manage') && a.canManage;
  const typeLabel = options('kb_type').find((o) => o.key === a.articleType)?.label ?? titleCase(a.articleType);
  const expired = a.expiresAt && new Date(a.expiresAt) < new Date();

  return (
    <div className="max-w-6xl">
      <PageHeader
        breadcrumb={
          <Link to="/knowledge" className="inline-flex items-center gap-1 hover:underline">
            <ArrowLeft className="h-3 w-3" /> Knowledge base
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-subtle">{a.number}</span>
            {a.title}
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge>{typeLabel}</Badge>
            <VisibilityBadge visibility={a.visibility} customerName={a.customerName} />
            {!isCustomer && <Badge color={STATUS_COLORS[a.status]}>{titleCase(a.status)}</Badge>}
            {expired && <Badge color="red">Expired</Badge>}
            {a.categoryName && <span className="text-muted">{a.categoryName}</span>}
            <span className="text-subtle">v{a.version}</span>
            <span className="text-subtle inline-flex items-center gap-1">
              <Eye className="h-3 w-3" /> {a.viewCount}
            </span>
          </span>
        }
        actions={
          canManage && (
            <>
              <Button variant="outline" icon={<PenLine className="h-4 w-4" />} onClick={() => setEditorOpen(true)}>
                Edit
              </Button>
              {a.status === 'draft' && (
                <Button icon={<Send className="h-4 w-4" />} onClick={() => action.mutate('publish')} loading={action.isPending}>
                  Publish
                </Button>
              )}
              {a.status === 'published' && (
                <Button variant="outline" icon={<Archive className="h-4 w-4" />} onClick={() => setConfirm('archive')}>
                  Archive
                </Button>
              )}
              {a.status === 'archived' && (
                <Button variant="outline" icon={<ArchiveRestore className="h-4 w-4" />} onClick={() => setConfirm('unarchive')}>
                  Restore to draft
                </Button>
              )}
              {a.status === 'draft' && (
                <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirm('delete')}>
                  Delete
                </Button>
              )}
            </>
          )
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
        <div className="min-w-0 space-y-4">
          <Card>
            {a.summary && <p className="text-[13.5px] text-muted border-l-2 border-brand-500/50 pl-3 mb-4">{a.summary}</p>}
            <div className="prose-sm text-[13.5px] leading-relaxed">{a.body.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.body}</ReactMarkdown> : <span className="text-subtle">This article has no content yet.</span>}</div>
            <div className="mt-6 pt-4 border-t border-default flex flex-wrap items-center gap-3">
              <span className="text-[13px] text-muted">Was this article helpful?</span>
              <Button size="sm" variant={voted === 'up' ? 'primary' : 'outline'} icon={<ThumbsUp className="h-3.5 w-3.5" />} disabled={!!voted || feedback.isPending} onClick={() => feedback.mutate(true)}>
                Yes {a.helpfulCount > 0 && `(${a.helpfulCount})`}
              </Button>
              <Button size="sm" variant={voted === 'down' ? 'primary' : 'outline'} icon={<ThumbsDown className="h-3.5 w-3.5" />} disabled={!!voted || feedback.isPending} onClick={() => feedback.mutate(false)}>
                No {a.notHelpfulCount > 0 && `(${a.notHelpfulCount})`}
              </Button>
              {voted && <span className="text-xs text-subtle">Thanks, your feedback was recorded.</span>}
            </div>
          </Card>

          <Card title="Attachments" padded>
            <AttachmentList entityType="kb_article" entityId={a.id} customerId={a.customerId} canUpload={canManage} canDelete={canManage} showVisibility={canManage && a.visibility !== 'internal'} compact />
          </Card>

          {!isCustomer && (
            <Card title="History" padded>
              <AuditTrail entityType="kb_article" entityId={a.id} compact />
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card title="Details" padded>
            <KeyValue
              columns={1}
              items={[
                { label: 'Author', value: a.authorName ?? '—' },
                { label: 'Published', value: a.publishedAt ? <span title={fmtDateTime(a.publishedAt)}>{fmtDate(a.publishedAt)}</span> : '—' },
                { label: 'Last updated', value: <span title={fmtDateTime(a.updatedAt)}>{relativeTime(a.updatedAt)}</span> },
                ...(!isCustomer ? [{ label: 'Reviewed', value: a.reviewedAt ? `${fmtDate(a.reviewedAt)}${a.reviewerName ? ` by ${a.reviewerName}` : ''}` : '—' }] : []),
                { label: 'Domain', value: a.domain === 'general' ? 'General' : a.domain.toUpperCase() },
                { label: 'Service', value: a.serviceName ?? '—' },
                { label: 'CI type', value: a.ciTypeKey ? titleCase(a.ciTypeKey) : '—' },
                { label: 'Expires', value: a.expiresAt ? fmtDate(a.expiresAt) : '—' },
                {
                  label: 'Tags',
                  value: a.tags.length ? (
                    <span className="flex flex-wrap gap-1">
                      {a.tags.map((t) => (
                        <Link key={t} to={`/knowledge?tag=${encodeURIComponent(t)}`}>
                          <Badge className="py-0">
                            <Tag className="h-3 w-3" /> {t}
                          </Badge>
                        </Link>
                      ))}
                    </span>
                  ) : (
                    '—'
                  ),
                },
              ]}
            />
          </Card>

          {!isCustomer && a.relatedTickets.length > 0 && (
            <Card title="Related tickets" padded={false}>
              <ul className="divide-y divide-[var(--border)] text-[13px]">
                {a.relatedTickets.map((t) => (
                  <li key={t.id}>
                    <Link to={`/tickets/${t.id}`} className="flex items-center gap-2 px-4 py-2 hover:bg-surface-2/60">
                      <TicketIcon className="h-3.5 w-3.5 text-subtle shrink-0" />
                      <span className="font-mono text-[11.5px] text-subtle">{t.number}</span>
                      <span className="flex-1 truncate">{t.title}</span>
                      {t.status && <Badge color={t.statusColor ?? undefined} className="py-0">{t.status}</Badge>}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {!isCustomer && (
            <Card
              title="Versions"
              padded={false}
            >
              <ul className="divide-y divide-[var(--border)] text-[12.5px]">
                <li className="px-4 py-2 flex items-center gap-2">
                  <span className="font-medium">v{a.version}</span>
                  <span className="text-muted flex-1 truncate">Current</span>
                  <span className="text-subtle">{relativeTime(a.updatedAt)}</span>
                </li>
                {a.versions.map((v) => (
                  <li key={v.version} className="px-4 py-2 flex items-center gap-2">
                    <button className="font-medium hover:underline" onClick={() => setViewVersion(v.version)}>
                      v{v.version}
                    </button>
                    <span className="text-muted flex-1 truncate" title={v.changeNote ?? undefined}>
                      {v.changeNote || (v.changedByName ? `by ${v.changedByName}` : 'No note')}
                    </span>
                    <span className="text-subtle" title={fmtDateTime(v.createdAt)}>
                      {relativeTime(v.createdAt)}
                    </span>
                    {canManage && (
                      <button className="text-subtle hover:text-default" title={`Restore v${v.version}`} onClick={() => setRestoreVersion(v.version)}>
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                ))}
                {a.versions.length === 0 && <li className="px-4 py-2 text-muted">No earlier versions.</li>}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {canManage && <ArticleEditor open={editorOpen} onClose={() => setEditorOpen(false)} article={a} onSaved={invalidate} />}

      <ConfirmDialog
        open={confirm === 'archive'}
        onClose={() => setConfirm(null)}
        onConfirm={() => action.mutate('archive')}
        title="Archive article?"
        description="Archived articles disappear from search, suggestions and the customer portal. You can restore it to draft later."
        confirmLabel="Archive"
        loading={action.isPending}
      />
      <ConfirmDialog open={confirm === 'unarchive'} onClose={() => setConfirm(null)} onConfirm={() => action.mutate('unarchive')} title="Restore to draft?" description="The article becomes an editable draft; publish it again when ready." confirmLabel="Restore" loading={action.isPending} />
      <ConfirmDialog open={confirm === 'delete'} onClose={() => setConfirm(null)} onConfirm={() => action.mutate('delete')} title="Delete draft?" description="This draft and its version history will be permanently removed." confirmLabel="Delete" danger loading={action.isPending} />
      <ConfirmDialog open={restoreVersion !== null} onClose={() => setRestoreVersion(null)} onConfirm={() => action.mutate('restore')} title={`Restore version ${restoreVersion}?`} description="The current content is kept as a new version before restoring." confirmLabel="Restore" loading={action.isPending} />

      <Dialog open={viewVersion !== null} onClose={() => setViewVersion(null)} title={`${a.number} — version ${viewVersion}`} width="max-w-3xl">
        {version.isLoading && <LoadingBlock />}
        {version.data && (
          <div>
            <div className="text-xs text-muted mb-3">
              {version.data.changedByName ? `Saved by ${version.data.changedByName}` : 'Saved'} · {fmtDateTime(version.data.createdAt)}
              {version.data.changeNote && <> · {version.data.changeNote}</>}
            </div>
            <div className="font-semibold mb-1">{version.data.title}</div>
            {version.data.summary && <p className="text-[13px] text-muted mb-3">{version.data.summary}</p>}
            <div className="prose-sm text-[13px]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{version.data.body}</ReactMarkdown>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
