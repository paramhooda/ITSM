import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, PenLine, AlertTriangle, Eye, FileText } from 'lucide-react';
import { PageHeader, ModuleNav, ErrorBlock, Badge } from '@/components/ui';
import { KNOWLEDGE_MODULES } from '@/layouts/modules';
import { KpiGrid } from '@/components/dashboards/KpiGrid';
import { Panel, RowList, KpiSkeleton, Skeleton } from '@/components/dashboards/Panel';
import { BreakdownBar } from '@/components/dashboards/BreakdownBar';
import { useForwardListParams } from '@/hooks/useForwardListParams';
import { useLookups } from '@/hooks/useLookups';
import { useAuthStore } from '@/stores/auth';
import { fmtNumber, relativeTime, titleCase } from '@/lib/format';
import { KB_STATUS_COLORS, KB_VISIBILITY_COLORS } from '@/lib/statusColors';
import { overviewApi, ovKeys, isUuid, withQuery } from '@/components/overview/api';
import KnowledgeListPage from './KnowledgeListPage';

const VISIBILITY_LABELS: Record<string, string> = { internal: 'Internal', customer: 'Customer-specific', public: 'Public' };

/** Knowledge home for staff: what the base holds and what needs review. Customer users get the article browser. */
export default function KnowledgeOverviewPage() {
  const forwarding = useForwardListParams('/knowledge/articles');
  const navigate = useNavigate();
  const isCustomer = useAuthStore((s) => s.isCustomer());
  const can = useAuthStore((s) => s.can);
  const { options } = useLookups();
  const q = useQuery({ queryKey: ovKeys.knowledge, queryFn: () => overviewApi.knowledge(), refetchInterval: 120_000, placeholderData: (p) => p, enabled: !forwarding && !isCustomer });
  if (forwarding) return null;
  if (isCustomer) return <KnowledgeListPage />;
  const d = q.data;
  const articles = (params: Record<string, string | undefined> = {}) => withQuery('/knowledge/articles', params);
  const typeLabel = (key: string) => options('kb_type').find((o) => o.key === key)?.label ?? titleCase(key);
  const needsReview = d ? d.stale + d.expired + d.expiringSoon30d : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Knowledge" subtitle="What the knowledge base holds and what needs review" />
      <ModuleNav items={KNOWLEDGE_MODULES} />
      {q.isError && <ErrorBlock error={q.error} retry={() => q.refetch()} />}

      {!d && q.isLoading && <KpiSkeleton count={4} />}
      {d && (
        <KpiGrid
          items={[
            { label: 'Articles', value: fmtNumber(d.total), icon: <BookOpen className="h-4 w-4" />, hint: `${fmtNumber(d.byStatus.find((b) => b.key === 'published')?.count ?? 0)} published · ${fmtNumber(d.withoutCategory)} uncategorised`, onClick: () => navigate(articles()) },
            { label: 'Drafts', value: fmtNumber(d.drafts), tone: d.drafts ? 'warn' : 'default', icon: <PenLine className="h-4 w-4" />, hint: 'waiting to be published', onClick: () => navigate(articles({ status: 'draft' })) },
            { label: 'Needs review', value: fmtNumber(needsReview), tone: d.expired ? 'bad' : needsReview ? 'warn' : 'good', icon: <AlertTriangle className="h-4 w-4" />, hint: `${fmtNumber(d.stale)} stale · ${fmtNumber(d.expired)} expired · ${fmtNumber(d.expiringSoon30d)} expiring`, onClick: () => navigate(articles({ status: 'published', sort: 'updatedAt', order: 'asc' })) },
            { label: 'Views · 30d', value: fmtNumber(d.viewsLast30d), icon: <Eye className="h-4 w-4" />, hint: 'article opens by staff and customers', onClick: () => navigate(articles({ sort: 'viewCount', order: 'desc' })) },
          ]}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="By type" subtitle="Runbooks, SOPs, known errors…" to={articles()} toLabel="Articles">
          {d ? <BreakdownBar dense items={d.byType.map((b) => ({ label: b.label || typeLabel(b.key), value: b.count, color: b.color ?? null, href: articles({ type: b.key }) }))} emptyText="No articles yet" /> : <Skeleton rows={5} />}
        </Panel>
        <Panel title="By visibility" subtitle="Who can read what" to={articles()} toLabel="Articles">
          {d ? (
            <>
              <BreakdownBar dense items={d.byVisibility.map((b) => ({ label: b.label || VISIBILITY_LABELS[b.key] || titleCase(b.key), value: b.count, color: b.color ?? KB_VISIBILITY_COLORS[b.key] ?? null, href: articles({ visibility: b.key }) }))} emptyText="No articles yet" />
              <div className="mt-3 pt-3 border-t border-default">
                <BreakdownBar dense items={d.byStatus.map((b) => ({ label: b.label || titleCase(b.key), value: b.count, color: b.color ?? KB_STATUS_COLORS[b.key] ?? null, href: articles({ status: b.key }) }))} emptyText="No articles yet" />
              </div>
            </>
          ) : (
            <Skeleton rows={5} />
          )}
        </Panel>
        <Panel title="By category" subtitle="Largest first" to={can('kb:manage') ? '/knowledge/categories' : articles()} toLabel={can('kb:manage') ? 'Categories' : 'Articles'}>
          {d ? <BreakdownBar dense items={d.byCategory.slice(0, 10).map((b) => ({ label: b.label, value: b.count, color: b.color ?? null, href: isUuid(b.key) ? articles({ categoryId: b.key }) : articles() }))} emptyText="No articles yet" /> : <Skeleton rows={5} />}
        </Panel>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Top viewed" subtitle="What people actually open" to={articles({ sort: 'viewCount', order: 'desc' })} toLabel="Most viewed">
          {d ? (
            <RowList
              dense
              empty="No views recorded yet"
              items={d.topViewed.slice(0, 8).map((a) => ({
                key: a.id,
                leading: <FileText className="h-3.5 w-3.5 text-subtle" />,
                primary: a.title,
                secondary: (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-mono">{a.number}</span>
                    <Badge color={KB_VISIBILITY_COLORS[a.visibility] ?? 'slate'}>{VISIBILITY_LABELS[a.visibility] ?? titleCase(a.visibility)}</Badge>
                  </span>
                ),
                right: `${fmtNumber(a.viewCount)} views`,
                href: `/knowledge/${a.id}`,
              }))}
            />
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
        <Panel title="Recently updated" subtitle="Latest edits" to={articles({ sort: 'updatedAt', order: 'desc' })} toLabel="Recently updated">
          {d ? (
            <RowList
              dense
              empty="Nothing updated yet"
              items={d.recentlyUpdated.slice(0, 8).map((a) => ({
                key: a.id,
                leading: <FileText className="h-3.5 w-3.5 text-subtle" />,
                primary: a.title,
                secondary: (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-mono">{a.number}</span>
                    <Badge color={KB_STATUS_COLORS[a.status] ?? 'slate'} dot>{titleCase(a.status)}</Badge>
                  </span>
                ),
                right: relativeTime(a.updatedAt),
                href: `/knowledge/${a.id}`,
              }))}
            />
          ) : (
            <Skeleton rows={6} />
          )}
        </Panel>
      </div>
    </div>
  );
}
