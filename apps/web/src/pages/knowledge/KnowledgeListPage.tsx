import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus, BookOpen, FolderOpen, Folder, AlertTriangle, FileText, PenLine, CalendarClock } from 'lucide-react';
import { get } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useLookups } from '@/hooks/useLookups';
import { useListState } from '@/hooks/useListState';
import { Button, PageHeader, SearchInput, Select, Pagination, EmptyState, LoadingBlock, ErrorBlock, Badge, FilterBar } from '@/components/ui';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel, RowList } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { fmtNumber, titleCase } from '@/lib/format';
import { ArticleCard, type ArticleSummary } from '@/components/knowledge/ArticleCard';
import { ArticleEditor, DOMAIN_OPTIONS, type KbCategory } from '@/components/knowledge/ArticleEditor';
import { cn } from '@/lib/utils';

interface ListResponse {
  items: ArticleSummary[];
  total: number;
  page: number;
  pageSize: number;
}

interface Stats {
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byVisibility: Record<string, number>;
  topViewed: { id: string; number: string; title: string; viewCount: number }[];
  stale: { count: number; items: { id: string; number: string; title: string }[] };
  expiringSoon: number;
}

const DEFAULTS = { pageSize: '25' };

export default function KnowledgeListPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const isCustomer = useAuthStore((s) => s.user?.userType === 'customer');
  const canManage = !isCustomer && can('kb:manage');
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { options } = useLookups();
  const [editorOpen, setEditorOpen] = useState(false);

  const categories = useQuery({ queryKey: ['knowledge', 'categories'], queryFn: () => get<{ items: KbCategory[]; uncategorized: number }>('/knowledge/categories'), staleTime: 60_000 });
  const stats = useQuery({ queryKey: ['knowledge', 'stats'], queryFn: () => get<Stats>('/knowledge/stats'), enabled: canManage, staleTime: 60_000 });

  const query = useMemo(
    () => ({
      page,
      pageSize,
      q: state.q || undefined,
      categoryId: state.categoryId || undefined,
      articleType: state.type || undefined,
      status: !isCustomer ? state.status || undefined : undefined,
      domain: state.domain || undefined,
      visibility: !isCustomer ? state.visibility || undefined : undefined,
      tag: state.tag || undefined,
      sort: state.sort || undefined,
      order: state.order || undefined,
    }),
    [page, pageSize, state, isCustomer],
  );
  const list = useQuery({ queryKey: ['knowledge', 'list', query], queryFn: () => get<ListResponse>('/knowledge', query), placeholderData: (prev) => prev });

  const typeLabel = (key: string) => options('kb_type').find((o) => o.key === key)?.label;
  const typeOptions = options('kb_type').map((o) => ({ value: o.key, label: o.label }));

  const tree = useMemo(() => {
    const cats = categories.data?.items ?? [];
    const byParent = new Map<string | null, KbCategory[]>();
    cats.forEach((c) => byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]));
    const total = (c: KbCategory): number => (c.articleCount ?? 0) + (byParent.get(c.id) ?? []).reduce((n, ch) => n + total(ch), 0);
    const rows: { cat: KbCategory; depth: number; count: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const c of byParent.get(parent) ?? []) {
        rows.push({ cat: c, depth, count: total(c) });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }, [categories.data]);
  const totalArticles = (categories.data?.items ?? []).reduce((n, c) => n + (c.articleCount ?? 0), 0) + (categories.data?.uncategorized ?? 0);
  const FILTER_KEYS = ['q', 'categoryId', 'type', 'status', 'domain', 'visibility', 'tag', 'sort', 'order'];
  const activeCount = FILTER_KEYS.filter((k) => state[k]).length;
  const clear = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Knowledge base"
        subtitle={isCustomer ? 'Procedures, guides and answers published for your organization.' : 'Runbooks, SOPs, known errors and customer procedures.'}
        actions={
          canManage && (
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditorOpen(true)}>
              New article
            </Button>
          )
        }
      />

      <FilterBar activeCount={activeCount} onClear={clear}>
        <SearchInput className="w-72" value={state.q ?? ''} onChange={(v) => set({ q: v })} placeholder="Search titles, numbers and content…" />
        <Select className="w-36 h-8 py-0 text-[13px]" value={state.type ?? ''} onChange={(e) => set({ type: e.target.value })} placeholder="All types" options={typeOptions} />
        <Select className="w-44 h-8 py-0 text-[13px] lg:hidden" value={state.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value })} placeholder="All categories" options={tree.map(({ cat, depth }) => ({ value: cat.id, label: `${'— '.repeat(depth)}${cat.name}` }))} />
        {!isCustomer && <Select className="w-36 h-8 py-0 text-[13px]" value={state.domain ?? ''} onChange={(e) => set({ domain: e.target.value })} placeholder="All domains" options={DOMAIN_OPTIONS} />}
        {!isCustomer && <Select className="w-36 h-8 py-0 text-[13px]" value={state.status ?? ''} onChange={(e) => set({ status: e.target.value })} placeholder="All statuses" options={[{ value: 'published', label: 'Published' }, { value: 'draft', label: 'Draft' }, { value: 'archived', label: 'Archived' }]} />}
        {!isCustomer && <Select className="w-40 h-8 py-0 text-[13px]" value={state.visibility ?? ''} onChange={(e) => set({ visibility: e.target.value })} placeholder="All visibility" options={[{ value: 'internal', label: 'Internal' }, { value: 'customer', label: 'Customer-specific' }, { value: 'public', label: 'Public' }]} />}
        <Select
          className="w-44 h-8 py-0 text-[13px]"
          value={state.sort ? `${state.sort}:${state.order ?? 'desc'}` : ''}
          onChange={(e) => {
            const [sort, order] = e.target.value.split(':');
            set({ sort: sort || undefined, order: order || undefined });
          }}
          placeholder={state.q ? 'Sort: relevance' : 'Sort: recently updated'}
          options={[
            { value: 'updatedAt:desc', label: 'Recently updated' },
            { value: 'viewCount:desc', label: 'Most viewed' },
            { value: 'title:asc', label: 'Title A–Z' },
            { value: 'publishedAt:desc', label: 'Recently published' },
          ]}
        />
        {state.tag && (
          <Badge className="cursor-pointer" onClick={() => set({ tag: undefined })}>
            tag: {state.tag} ×
          </Badge>
        )}
      </FilterBar>

      {canManage && (
        <InsightBand
          id="knowledge"
          loading={stats.isLoading}
          summary={stats.data ? `${fmtNumber(totalArticles)} articles` : undefined}
          kpis={
            stats.data
              ? [
                  { label: 'Published', value: fmtNumber(stats.data.byStatus.published ?? 0), icon: <BookOpen className="h-4 w-4" />, hint: `${fmtNumber(stats.data.byStatus.archived ?? 0)} archived`, onClick: () => set({ status: state.status === 'published' ? undefined : 'published' }) },
                  { label: 'Drafts', value: fmtNumber(stats.data.byStatus.draft ?? 0), tone: (stats.data.byStatus.draft ?? 0) > 0 ? 'warn' : 'default', icon: <PenLine className="h-4 w-4" />, hint: 'waiting to be published', onClick: () => set({ status: state.status === 'draft' ? undefined : 'draft' }) },
                  { label: 'Review overdue', value: fmtNumber(stats.data.stale.count), tone: stats.data.stale.count > 0 ? 'bad' : 'good', icon: <AlertTriangle className="h-4 w-4" />, hint: 'published over 12 months ago, not reviewed' },
                  { label: 'Expiring · 30d', value: fmtNumber(stats.data.expiringSoon), tone: stats.data.expiringSoon > 0 ? 'warn' : 'good', icon: <CalendarClock className="h-4 w-4" />, hint: 'articles with an expiry date coming up' },
                ]
              : []
          }
          panels={
            stats.data && (
              <>
                <Panel title="Most viewed" subtitle="What people actually open">
                  <RowList dense empty="No views recorded yet" items={stats.data.topViewed.slice(0, 6).map((t) => ({ key: t.id, leading: <FileText className="h-3.5 w-3.5 text-subtle" />, primary: t.title, secondary: t.number, right: `${fmtNumber(t.viewCount)} views`, href: `/knowledge/${t.id}` }))} />
                </Panel>
                <Panel title="By type" subtitle="Runbooks, SOPs, known errors…">
                  <BreakdownBar dense items={Object.entries(stats.data.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: typeLabel(k) ?? titleCase(k), value: v, active: state.type === k }))} onSelect={(i) => { const k = Object.keys(stats.data!.byType).find((key) => (typeLabel(key) ?? titleCase(key)) === i.label); if (k) set({ type: state.type === k ? undefined : k }); }} />
                </Panel>
              </>
            )
          }
        />
      )}

      <div className="flex gap-4">
        <aside className="hidden lg:block w-56 shrink-0">
          <div className="card p-2 sticky top-0">
            <div className="px-2 pb-1 text-[10.5px] uppercase tracking-wider text-subtle font-semibold">Categories</div>
            <button className={cn('w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[13px]', !state.categoryId ? 'bg-brand-600/10 text-brand-700 font-medium' : 'text-muted hover:bg-surface-2')} onClick={() => set({ categoryId: undefined })}>
              <span className="inline-flex items-center gap-2">
                <BookOpen className="h-3.5 w-3.5" /> All articles
              </span>
              <span className="text-xs">{totalArticles}</span>
            </button>
            {tree.map(({ cat, depth, count }) => {
              const active = state.categoryId === cat.id;
              return (
                <button key={cat.id} className={cn('w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[13px]', active ? 'bg-brand-600/10 text-brand-700 font-medium' : 'text-muted hover:bg-surface-2')} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => set({ categoryId: active ? undefined : cat.id })} title={cat.description ?? cat.name}>
                  <span className="inline-flex items-center gap-2 min-w-0">
                    {active ? <FolderOpen className="h-3.5 w-3.5 shrink-0" /> : <Folder className="h-3.5 w-3.5 shrink-0" />}
                    <span className="truncate">{cat.name}</span>
                  </span>
                  <span className="text-xs">{count}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <div className="flex-1 min-w-0">
          <div className="card" style={{ padding: 0 }}>
            {list.isLoading && <LoadingBlock />}
            {list.isError && <ErrorBlock error={list.error} retry={() => list.refetch()} />}
            {list.data && list.data.items.length === 0 && (
              <EmptyState
                icon={<BookOpen className="h-5 w-5" />}
                title="No articles match"
                description={isCustomer ? 'Try a different search term.' : 'Adjust the filters or write the first article for this area.'}
                action={canManage ? <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditorOpen(true)}>New article</Button> : undefined}
              />
            )}
            {list.data && list.data.items.length > 0 && (
              <div className="divide-y divide-[var(--border)]">
                {list.data.items.map((a) => (
                  <ArticleCard key={a.id} article={a} showStatus={!isCustomer} typeLabel={typeLabel(a.articleType)} />
                ))}
              </div>
            )}
            {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
          </div>
        </div>
      </div>

      {canManage && <ArticleEditor open={editorOpen} onClose={() => setEditorOpen(false)} defaults={{ categoryId: state.categoryId ?? '' }} onSaved={(a) => navigate(`/knowledge/${a.id}`)} />}
    </div>
  );
}
