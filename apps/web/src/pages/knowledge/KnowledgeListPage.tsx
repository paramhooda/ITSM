import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus, BookOpen, AlertTriangle, FileText, PenLine, CalendarClock } from 'lucide-react';
import { get } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { useLookups, useCustomersLookup } from '@/hooks/useLookups';
import { useListState } from '@/hooks/useListState';
import { Button, PageHeader, Select, Pagination, EmptyState, LoadingBlock, ErrorBlock, ListShell, FilterGroup, FilterOptions, FilterSelect, FilterDateRange, FilterToggle, type AppliedFilter } from '@/components/ui';
import { KNOWLEDGE_MODULES, PORTAL_KNOWLEDGE_MODULES } from '@/layouts/modules';
import { InsightBand } from '@/components/dashboards/InsightBand';
import { Panel, RowList } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { fmtDate, fmtNumber, titleCase } from '@/lib/format';
import { dotClass } from '@/lib/utils';
import { DOMAIN_COLORS, KB_STATUS_COLORS, KB_VISIBILITY_COLORS } from '@/lib/statusColors';
import { itemsOf } from '@/components/tickets/api';
import { ArticleCard, type ArticleSummary } from '@/components/knowledge/ArticleCard';
import { ArticleEditor, DOMAIN_OPTIONS, type KbCategory } from '@/components/knowledge/ArticleEditor';

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
const STATUS_OPTIONS = [
  { value: 'published', label: 'Published' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
];
const VISIBILITY_OPTIONS = [
  { value: 'internal', label: 'Internal' },
  { value: 'customer', label: 'Customer-specific' },
  { value: 'public', label: 'Public' },
];
const SORT_OPTIONS = [
  { value: 'updatedAt:desc', label: 'Recently updated' },
  { value: 'viewCount:desc', label: 'Most viewed' },
  { value: 'title:asc', label: 'Title A–Z' },
  { value: 'publishedAt:desc', label: 'Recently published' },
];
const FILTER_KEYS = ['q', 'categoryId', 'type', 'status', 'domain', 'visibility', 'customerId', 'tag', 'updatedFrom', 'updatedTo', 'expiring', 'needsReview'];

/** Articles module of Knowledge: the browsable list, with the article browser the portal users already know. */
export default function KnowledgeListPage() {
  const navigate = useNavigate();
  const can = useAuthStore((s) => s.can);
  const isCustomer = useAuthStore((s) => s.isCustomer());
  const canManage = !isCustomer && can('kb:manage');
  const { state, set, page, pageSize, setPage } = useListState(DEFAULTS);
  const { options } = useLookups();
  const customers = useCustomersLookup();
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
      customerId: !isCustomer ? state.customerId || undefined : undefined,
      tag: state.tag || undefined,
      updatedFrom: state.updatedFrom || undefined,
      updatedTo: state.updatedTo || undefined,
      expiring: state.expiring === 'true' ? 'true' : undefined,
      needsReview: state.needsReview === 'true' ? 'true' : undefined,
      sort: state.sort || undefined,
      order: state.order || undefined,
    }),
    [page, pageSize, state, isCustomer],
  );
  const list = useQuery({ queryKey: ['knowledge', 'list', query], queryFn: () => get<ListResponse>('/knowledge', query), placeholderData: (prev) => prev });

  const typeLabel = (key: string) => options('kb_type').find((o) => o.key === key)?.label;
  const typeOptions = options('kb_type');
  const customerItems = itemsOf<{ id: string; name: string; code: string }>(customers.data);

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
  const activeCount = FILTER_KEYS.filter((k) => state[k]).length;
  const clear = () => set(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));

  const applied: AppliedFilter[] = [];
  if (state.q) applied.push({ key: 'q', label: `Search: “${state.q}”`, onRemove: () => set({ q: undefined }) });
  if (state.categoryId) applied.push({ key: 'categoryId', label: `Category: ${tree.find((r) => r.cat.id === state.categoryId)?.cat.name ?? '…'}`, onRemove: () => set({ categoryId: undefined }) });
  if (state.type) applied.push({ key: 'type', label: `Type: ${typeLabel(state.type) ?? titleCase(state.type)}`, onRemove: () => set({ type: undefined }) });
  if (state.domain) applied.push({ key: 'domain', label: `Domain: ${DOMAIN_OPTIONS.find((d) => d.value === state.domain)?.label ?? state.domain}`, onRemove: () => set({ domain: undefined }) });
  if (!isCustomer && state.visibility) applied.push({ key: 'visibility', label: `Visibility: ${VISIBILITY_OPTIONS.find((v) => v.value === state.visibility)?.label ?? state.visibility}`, onRemove: () => set({ visibility: undefined }) });
  if (!isCustomer && state.status) applied.push({ key: 'status', label: `Status: ${titleCase(state.status)}`, onRemove: () => set({ status: undefined }) });
  if (!isCustomer && state.customerId) applied.push({ key: 'customerId', label: `Customer: ${customerItems.find((c) => c.id === state.customerId)?.name ?? '…'}`, onRemove: () => set({ customerId: undefined }) });
  if (state.tag) applied.push({ key: 'tag', label: `Tag: ${state.tag}`, onRemove: () => set({ tag: undefined }) });
  if (state.updatedFrom || state.updatedTo) applied.push({ key: 'updated', label: `Updated ${state.updatedFrom ? `from ${fmtDate(state.updatedFrom)}` : ''}${state.updatedFrom && state.updatedTo ? ' ' : ''}${state.updatedTo ? `to ${fmtDate(state.updatedTo)}` : ''}`, onRemove: () => set({ updatedFrom: undefined, updatedTo: undefined }) });
  if (state.expiring === 'true') applied.push({ key: 'expiring', label: 'Expiring soon', onRemove: () => set({ expiring: undefined }) });
  if (state.needsReview === 'true') applied.push({ key: 'needsReview', label: 'Needs review', onRemove: () => set({ needsReview: undefined }) });

  const filters = (
    <>
      <FilterGroup label="Category">
        <FilterOptions
          max={10}
          options={tree.map(({ cat, depth, count }) => ({ value: cat.id, label: <span style={{ paddingLeft: depth * 10 }}>{cat.name}</span>, count }))}
          value={state.categoryId}
          onChange={(v) => set({ categoryId: v as string | undefined })}
          emptyLabel={categories.isLoading ? 'Loading…' : 'No categories yet'}
        />
      </FilterGroup>
      {typeOptions.length > 0 && (
        <FilterGroup label="Type">
          <FilterOptions options={typeOptions.map((o) => ({ value: o.key, label: o.label, count: canManage ? stats.data?.byType[o.key] ?? 0 : null }))} value={state.type} onChange={(v) => set({ type: v as string | undefined })} />
        </FilterGroup>
      )}
      {!isCustomer && (
        <>
          <FilterGroup label="Visibility">
            <FilterOptions options={VISIBILITY_OPTIONS.map((o) => ({ ...o, dot: dotClass(KB_VISIBILITY_COLORS[o.value]), count: canManage ? stats.data?.byVisibility[o.value] ?? 0 : null }))} value={state.visibility} onChange={(v) => set({ visibility: v as string | undefined })} />
          </FilterGroup>
          <FilterGroup label="Status">
            <FilterOptions options={STATUS_OPTIONS.map((o) => ({ ...o, dot: dotClass(KB_STATUS_COLORS[o.value]), count: canManage ? stats.data?.byStatus[o.value] ?? 0 : null }))} value={state.status} onChange={(v) => set({ status: v as string | undefined })} />
          </FilterGroup>
          <FilterGroup label="Domain" defaultOpen={!!state.domain}>
            <FilterOptions options={DOMAIN_OPTIONS.map((o) => ({ ...o, dot: dotClass(DOMAIN_COLORS[o.value]) }))} value={state.domain} onChange={(v) => set({ domain: v as string | undefined })} />
          </FilterGroup>
          <FilterGroup label="Customer" defaultOpen={!!state.customerId}>
            <FilterSelect value={state.customerId ?? ''} onChange={(e) => set({ customerId: e.target.value })} placeholder="Any customer" options={customerItems.map((c) => ({ value: c.id, label: c.name }))} />
          </FilterGroup>
        </>
      )}
      <FilterGroup label="Updated" defaultOpen={!!(state.updatedFrom || state.updatedTo || state.expiring || state.needsReview)}>
        <FilterDateRange from={state.updatedFrom} to={state.updatedTo} onChange={(r) => set({ updatedFrom: r.from, updatedTo: r.to })} />
        <FilterToggle label="Expiring soon" hint="Expiry date within the next 30 days" checked={state.expiring === 'true'} onChange={(v) => set({ expiring: v ? 'true' : undefined })} />
        {!isCustomer && <FilterToggle label="Needs review" hint="Published over 12 months ago and not reviewed since" checked={state.needsReview === 'true'} onChange={(v) => set({ needsReview: v ? 'true' : undefined })} />}
      </FilterGroup>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={isCustomer ? 'Knowledge base' : 'Articles'}
        subtitle={isCustomer ? 'Procedures, guides and answers published for your organization.' : 'Runbooks, SOPs, known errors and customer procedures.'}
        actions={
          canManage && (
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditorOpen(true)}>
              New article
            </Button>
          )
        }
      />

      <ListShell
        id={isCustomer ? 'portal-knowledge' : 'knowledge-articles'}
        modules={isCustomer ? PORTAL_KNOWLEDGE_MODULES : KNOWLEDGE_MODULES}
        search={{ value: state.q ?? '', onChange: (v) => set({ q: v }), placeholder: 'Search titles, numbers and content…' }}
        filters={filters}
        activeCount={activeCount}
        onClear={clear}
        applied={applied}
        count={list.data ? `${fmtNumber(list.data.total)} ${list.data.total === 1 ? 'article' : 'articles'}` : undefined}
        toolbar={
          <Select
            className="w-44 h-8 py-0 text-[13px]"
            value={state.sort ? `${state.sort}:${state.order ?? 'desc'}` : ''}
            onChange={(e) => {
              const [sort, order] = e.target.value.split(':');
              set({ sort: sort || undefined, order: order || undefined });
            }}
            placeholder={state.q ? 'Sort: relevance' : 'Sort: recently updated'}
            options={SORT_OPTIONS}
          />
        }
        insights={
          canManage ? (
            <InsightBand
              id="knowledge"
              loading={stats.isLoading}
              summary={stats.data ? `${fmtNumber(totalArticles)} articles` : undefined}
              kpis={
                stats.data
                  ? [
                      { label: 'Published', value: fmtNumber(stats.data.byStatus.published ?? 0), icon: <BookOpen className="h-4 w-4" />, hint: `${fmtNumber(stats.data.byStatus.archived ?? 0)} archived`, onClick: () => set({ status: state.status === 'published' ? undefined : 'published' }), active: state.status === 'published' },
                      { label: 'Drafts', value: fmtNumber(stats.data.byStatus.draft ?? 0), tone: (stats.data.byStatus.draft ?? 0) > 0 ? 'warn' : 'default', icon: <PenLine className="h-4 w-4" />, hint: 'waiting to be published', onClick: () => set({ status: state.status === 'draft' ? undefined : 'draft' }), active: state.status === 'draft' },
                      { label: 'Review overdue', value: fmtNumber(stats.data.stale.count), tone: stats.data.stale.count > 0 ? 'bad' : 'good', icon: <AlertTriangle className="h-4 w-4" />, hint: 'published over 12 months ago, not reviewed', onClick: () => set({ needsReview: state.needsReview === 'true' ? undefined : 'true' }), active: state.needsReview === 'true' },
                      { label: 'Expiring · 30d', value: fmtNumber(stats.data.expiringSoon), tone: stats.data.expiringSoon > 0 ? 'warn' : 'good', icon: <CalendarClock className="h-4 w-4" />, hint: 'articles with an expiry date coming up', onClick: () => set({ expiring: state.expiring === 'true' ? undefined : 'true' }), active: state.expiring === 'true' },
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
          ) : undefined
        }
      >
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
      </ListShell>

      {canManage && <ArticleEditor open={editorOpen} onClose={() => setEditorOpen(false)} defaults={{ categoryId: state.categoryId ?? '' }} onSaved={(a) => navigate(`/knowledge/${a.id}`)} />}
    </div>
  );
}
