import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { PenLine, Send, Archive, ArchiveRestore, Trash2, ThumbsUp, ThumbsDown, RotateCcw, Tag, Ticket as TicketIcon, Info, History } from 'lucide-react';
import { get, post, del, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useLookups } from '@/hooks/useLookups';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorBlock, LoadingBlock } from '@/components/ui';
import type { MenuItem } from '@/components/Menu';
import { RecordLayout, RecordHeader, RelatedTabs, ActivityStream, RailTabs, RailCard, RailRows, useAuditStream } from '@/components/record';
import { ArticleEditor, type ArticleDetail } from '@/components/knowledge/ArticleEditor';
import { STATUS_COLORS, VisibilityBadge } from '@/components/knowledge/ArticleCard';
import { AttachmentList } from '@/components/attachments/AttachmentList';
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
  // Staff see the audit history in the rail; portal users never load it.
  const audit = useAuditStream('kb_article', isCustomer ? undefined : id);

  const a = article.data;
  useEffect(() => {
    if (a) setAssistantContext({ label: a.number, entityType: 'kb_article', entityId: a.id, title: a.title });
    return () => setAssistantContext(null);
  }, [a, setAssistantContext]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['knowledge'] });
    qc.invalidateQueries({ queryKey: ['audit', 'entity', 'kb_article', id] });
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
  const expired = !!a.expiresAt && new Date(a.expiresAt) < new Date();

  // ---- header: Edit + Publish up front, lifecycle moves in the overflow menu
  const primary = canManage ? (
    <>
      <Button size="sm" variant={a.status === 'draft' ? 'outline' : 'primary'} icon={<PenLine className="h-3.5 w-3.5" />} onClick={() => setEditorOpen(true)}>Edit</Button>
      {a.status === 'draft' && <Button size="sm" icon={<Send className="h-3.5 w-3.5" />} onClick={() => action.mutate('publish')} loading={action.isPending}>Publish</Button>}
    </>
  ) : undefined;
  const menu: MenuItem[] = canManage
    ? [
        ...(a.status === 'published' ? [{ label: 'Archive', icon: <Archive className="h-4 w-4" />, onClick: () => setConfirm('archive') }] : []),
        ...(a.status === 'archived' ? [{ label: 'Restore to draft', icon: <ArchiveRestore className="h-4 w-4" />, onClick: () => setConfirm('unarchive') }] : []),
        ...(a.status === 'draft' ? [{ label: 'Delete draft', icon: <Trash2 className="h-4 w-4" />, onClick: () => setConfirm('delete'), danger: true }] : []),
      ]
    : [];

  const crumbs = [
    { label: 'Knowledge', to: '/knowledge' },
    ...(a.categoryName ? [{ label: a.categoryName, to: a.categoryId && !isCustomer ? `/knowledge?categoryId=${a.categoryId}` : undefined }] : []),
    { label: a.number },
  ];

  // ---- related lists under the article
  const tabs = [
    {
      key: 'tickets',
      label: 'Related tickets',
      count: a.relatedTickets.length,
      hidden: isCustomer,
      content: (
        <section className="card">
          {a.relatedTickets.length === 0 ? (
            <EmptyState icon={<TicketIcon className="h-5 w-5" />} title="No related tickets" description="Tickets that link this article appear here." />
          ) : (
            <ul className="divide-y divide-[var(--border)] text-[13px]">
              {a.relatedTickets.map((t) => (
                <li key={t.id}>
                  <Link to={`/tickets/${t.id}`} className="flex items-center gap-2 px-4 py-2 hover:bg-surface-2/60">
                    <TicketIcon className="h-3.5 w-3.5 text-subtle shrink-0" />
                    <span className="font-mono text-[11.5px] text-subtle">{t.number}</span>
                    <span className="flex-1 truncate">{t.title}</span>
                    <span className="text-[12px] text-muted capitalize">{t.type}</span>
                    {t.status && <Badge color={t.statusColor ?? undefined} className="py-0">{t.status}</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ),
    },
    {
      key: 'versions',
      label: 'Versions',
      count: a.versions.length + 1,
      hidden: isCustomer,
      content: (
        <section className="card">
          <ul className="divide-y divide-[var(--border)] text-[12.5px]">
            <li className="px-4 py-2 flex items-center gap-2">
              <span className="font-medium w-10">v{a.version}</span>
              <span className="text-muted flex-1 truncate">Current</span>
              <span className="text-subtle" title={fmtDateTime(a.updatedAt)}>{relativeTime(a.updatedAt)}</span>
            </li>
            {a.versions.map((v) => (
              <li key={v.version} className="px-4 py-2 flex items-center gap-2">
                <button className="font-medium hover:underline w-10 text-left" onClick={() => setViewVersion(v.version)}>v{v.version}</button>
                <span className="text-muted flex-1 truncate" title={v.changeNote ?? undefined}>{v.changeNote || (v.changedByName ? `by ${v.changedByName}` : 'No note')}</span>
                <span className="text-subtle" title={fmtDateTime(v.createdAt)}>{relativeTime(v.createdAt)}</span>
                {canManage && (
                  <button className="text-subtle hover:text-default" title={`Restore v${v.version}`} onClick={() => setRestoreVersion(v.version)}>
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ),
    },
    {
      key: 'attachments',
      label: 'Attachments',
      content: (
        <section className="card px-4 py-3">
          <AttachmentList entityType="kb_article" entityId={a.id} customerId={a.customerId} canUpload={canManage} canDelete={canManage} showVisibility={canManage && a.visibility !== 'internal'} compact />
        </section>
      ),
    },
  ];

  const detailRows = [
    { label: 'Type', value: typeLabel },
    { label: 'Visibility', value: <VisibilityBadge visibility={a.visibility} customerName={a.customerName} /> },
    { label: 'Status', value: <Badge color={STATUS_COLORS[a.status]}>{titleCase(a.status)}</Badge>, hidden: isCustomer },
    { label: 'Category', value: a.categoryName },
    { label: 'Domain', value: a.domain === 'general' ? 'General' : a.domain.toUpperCase() },
    { label: 'Service', value: a.serviceName, hidden: !a.serviceName },
    { label: 'CI type', value: a.ciTypeKey ? titleCase(a.ciTypeKey) : null, hidden: !a.ciTypeKey },
    { label: 'Version', value: `v${a.version}` },
    { label: 'Views', value: String(a.viewCount) },
    { label: 'Helpful', value: `${a.helpfulCount} yes · ${a.notHelpfulCount} no` },
    { label: 'Author', value: a.authorName },
    { label: 'Published', value: a.publishedAt ? <span title={fmtDateTime(a.publishedAt)}>{fmtDate(a.publishedAt)}</span> : null },
    { label: 'Reviewed', value: a.reviewedAt ? `${fmtDate(a.reviewedAt)}${a.reviewerName ? ` by ${a.reviewerName}` : ''}` : null, hidden: isCustomer },
    { label: 'Expires', value: a.expiresAt ? <span className={expired ? 'text-red-600' : undefined}>{fmtDate(a.expiresAt)}</span> : null },
    { label: 'Updated', value: <span title={fmtDateTime(a.updatedAt)}>{relativeTime(a.updatedAt)}</span> },
  ];

  return (
    <>
      <RecordLayout
        header={
          <RecordHeader
            crumbs={crumbs}
            number={a.number}
            title={a.title}
            badges={
              <>
                <Badge>{typeLabel}</Badge>
                <VisibilityBadge visibility={a.visibility} customerName={a.customerName} />
                {!isCustomer && <Badge color={STATUS_COLORS[a.status]}>{titleCase(a.status)}</Badge>}
                {expired && <Badge color="red">Expired</Badge>}
              </>
            }
            controls={
              a.tags.length > 0 ? (
                <>
                  {a.tags.map((t) => (
                    <Link key={t} to={`/knowledge?tag=${encodeURIComponent(t)}`}>
                      <Badge color="slate" className="py-0 gap-1"><Tag className="h-3 w-3" /> {t}</Badge>
                    </Link>
                  ))}
                </>
              ) : undefined
            }
            primary={primary}
            menu={menu}
            createdAt={a.createdAt}
            createdBy={a.authorName}
            updatedAt={a.updatedAt}
          />
        }
        main={
          <>
            <article className="card px-5 py-4">
              {a.summary && <p className="text-[13.5px] text-muted border-l-2 border-brand-500/50 pl-3 mb-4">{a.summary}</p>}
              <div className="prose-sm text-[13.5px] leading-relaxed">{a.body.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.body}</ReactMarkdown> : <span className="text-subtle">No content yet.</span>}</div>
              <div className="mt-6 pt-3 border-t border-default flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] text-muted mr-1">Was this helpful?</span>
                <Button size="sm" variant={voted === 'up' ? 'primary' : 'outline'} icon={<ThumbsUp className="h-3.5 w-3.5" />} disabled={!!voted || feedback.isPending} onClick={() => feedback.mutate(true)}>
                  Yes{a.helpfulCount > 0 && <span className="tnum text-subtle">{a.helpfulCount}</span>}
                </Button>
                <Button size="sm" variant={voted === 'down' ? 'primary' : 'outline'} icon={<ThumbsDown className="h-3.5 w-3.5" />} disabled={!!voted || feedback.isPending} onClick={() => feedback.mutate(false)}>
                  No{a.notHelpfulCount > 0 && <span className="tnum text-subtle">{a.notHelpfulCount}</span>}
                </Button>
                {voted && <span className="text-[12px] text-subtle">Recorded.</span>}
              </div>
            </article>
            <RelatedTabs tabs={tabs} />
          </>
        }
        aside={
          <RailTabs
            tabs={[
              {
                key: 'details',
                label: 'Details',
                icon: Info,
                content: (
                  <RailCard title={<><Info className="h-3.5 w-3.5 text-subtle" /> Article</>}>
                    <RailRows rows={detailRows} />
                  </RailCard>
                ),
              },
              { key: 'activity', label: 'Activity', icon: History, hidden: isCustomer, badge: audit.entries.length, content: <ActivityStream entries={audit.entries} loading={audit.isLoading} title="History" maxHeight="calc(100vh - 220px)" /> },
            ]}
          />
        }
      />

      {canManage && <ArticleEditor open={editorOpen} onClose={() => setEditorOpen(false)} article={a} onSaved={invalidate} />}

      <ConfirmDialog
        open={confirm === 'archive'}
        onClose={() => setConfirm(null)}
        onConfirm={() => action.mutate('archive')}
        title="Archive article?"
        description="Archived articles leave search, suggestions and the portal. You can restore it to draft later."
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
    </>
  );
}
