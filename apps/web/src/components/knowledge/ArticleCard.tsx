import { Link } from 'react-router-dom';
import { Eye, Globe, Lock, Building2 } from 'lucide-react';
import { Badge } from '@/components/ui';
import { relativeTime, titleCase } from '@/lib/format';
import { truncate } from '@/lib/utils';
import { KB_STATUS_COLORS, KB_VISIBILITY_COLORS } from '@/lib/statusColors';

export interface ArticleSummary {
  id: string;
  number: string;
  title: string;
  summary?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  articleType: string;
  domain?: string;
  visibility: string;
  customerId?: string | null;
  customerName?: string | null;
  status: string;
  version?: number;
  authorName?: string | null;
  tags?: string[];
  viewCount?: number;
  helpfulCount?: number;
  notHelpfulCount?: number;
  publishedAt?: string | null;
  updatedAt: string;
  expiresAt?: string | null;
}

export const STATUS_COLORS = KB_STATUS_COLORS;
export const VISIBILITY_COLORS = KB_VISIBILITY_COLORS;

export function VisibilityBadge({ visibility, customerName }: { visibility: string; customerName?: string | null }) {
  const Icon = visibility === 'public' ? Globe : visibility === 'customer' ? Building2 : Lock;
  const label = visibility === 'customer' ? `Customer: ${customerName ?? '…'}` : titleCase(visibility);
  return (
    <Badge color={VISIBILITY_COLORS[visibility] ?? 'slate'} className="py-0">
      <Icon className="h-3 w-3" /> {label}
    </Badge>
  );
}

/** Dense list row for knowledge search results and listings. */
export function ArticleCard({ article, showStatus = true, typeLabel }: { article: ArticleSummary; showStatus?: boolean; typeLabel?: string }) {
  const a = article;
  const expired = a.expiresAt && new Date(a.expiresAt) < new Date();
  return (
    <Link to={`/knowledge/${a.id}`} className="block px-4 py-3 hover:bg-surface-2/60 transition-colors">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[11.5px] text-subtle">{a.number}</span>
            <span className="font-medium text-[13.5px] truncate">{a.title}</span>
            {showStatus && a.status !== 'published' && (
              <Badge color={STATUS_COLORS[a.status]} className="py-0">
                {titleCase(a.status)}
              </Badge>
            )}
            {expired && <Badge color="red" className="py-0">Expired</Badge>}
          </div>
          {a.summary && <div className="text-[12.5px] text-muted mt-0.5 line-clamp-2">{truncate(a.summary, 220)}</div>}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[11.5px] text-subtle">
            <Badge className="py-0">{typeLabel ?? titleCase(a.articleType)}</Badge>
            <VisibilityBadge visibility={a.visibility} customerName={a.customerName} />
            {a.categoryName && <span>{a.categoryName}</span>}
            {a.domain && a.domain !== 'general' && <span className="uppercase">{a.domain}</span>}
            {typeof a.viewCount === 'number' && (
              <span className="inline-flex items-center gap-1">
                <Eye className="h-3 w-3" /> {a.viewCount}
              </span>
            )}
            <span>· updated {relativeTime(a.updatedAt)}</span>
            {a.authorName && <span>· {a.authorName}</span>}
          </div>
        </div>
      </div>
    </Link>
  );
}

export default ArticleCard;
