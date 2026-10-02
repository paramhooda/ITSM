import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Loader2 } from 'lucide-react';
import { get } from '@/api/client';
import { Badge } from '@/components/ui';
import { titleCase } from '@/lib/format';
import { truncate, cn } from '@/lib/utils';

export interface KbSuggestion {
  id: string;
  number: string;
  title: string;
  summary: string | null;
  articleType: string;
  visibility: string;
  score: number;
}

function useDebounced<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Knowledge suggestions for a free-text context (ticket title/description,
 * alert text). Reusable from ticket forms, the portal and the assistant panel.
 */
export function KbSuggestions({ q, serviceId, customerId, ciTypeKey, limit = 5, title = 'Suggested articles', className, onSelect }: { q: string; serviceId?: string | null; customerId?: string | null; ciTypeKey?: string | null; limit?: number; title?: string | null; className?: string; onSelect?: (s: KbSuggestion) => void }) {
  const term = useDebounced(q.trim());
  const enabled = term.length >= 3;
  const query = useQuery({
    queryKey: ['knowledge', 'suggest', term, serviceId ?? null, customerId ?? null, ciTypeKey ?? null, limit],
    queryFn: () => get<{ items: KbSuggestion[] }>('/knowledge/suggest', { q: term, serviceId: serviceId ?? undefined, customerId: customerId ?? undefined, ciTypeKey: ciTypeKey ?? undefined, limit }),
    enabled,
    staleTime: 30_000,
  });
  const items = query.data?.items ?? [];
  if (!enabled) return null;
  if (!query.isFetching && items.length === 0) return null;
  return (
    <div className={cn('rounded-lg border border-default bg-surface', className)}>
      {title && (
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-default text-[12.5px] font-semibold">
          <BookOpen className="h-3.5 w-3.5 text-brand-600" /> {title}
          {query.isFetching && <Loader2 className="h-3 w-3 animate-spin text-subtle ml-auto" />}
        </div>
      )}
      <ul className="divide-y divide-[var(--border)]">
        {items.map((s) => (
          <li key={s.id}>
            <Link to={`/knowledge/${s.id}`} target={onSelect ? undefined : '_blank'} onClick={() => onSelect?.(s)} className="flex items-start gap-2 px-3 py-2 hover:bg-surface-2/60 text-[13px]">
              <span className="font-mono text-[11px] text-subtle mt-0.5 shrink-0">{s.number}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium block truncate">{s.title}</span>
                {s.summary && <span className="text-xs text-muted block truncate">{truncate(s.summary, 140)}</span>}
              </span>
              <Badge className="py-0 shrink-0">{titleCase(s.articleType)}</Badge>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default KbSuggestions;
