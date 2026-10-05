import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bug, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { portalApi, pk } from '@/components/portal/api';
import { truncate, cn } from '@/lib/utils';
import { kedbApi, kedbKeys, type KnownErrorRow, type PortalKnownError } from './api';
import { KeStatusBadge } from './KeStatusBadge';

function useDebounced<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export type SuggestedKnownError = { id: string; number: string; title: string; keStatus: string; workaround: string | null; serviceName: string | null; customerName?: string | null };

export const fromStaffRow = (r: KnownErrorRow): SuggestedKnownError => ({ id: r.id, number: r.number, title: r.title, keStatus: r.keStatus, workaround: r.workaround, serviceName: r.serviceName, customerName: r.customerName });
const fromPortal = (r: PortalKnownError): SuggestedKnownError => ({ id: r.id, number: r.number, title: r.title, keStatus: r.keStatus, workaround: r.workaround, serviceName: r.service?.name ?? null });

interface ListProps {
  title?: string | null;
  className?: string;
  /** Open the entry in a new tab (create pages keep the form). */
  newTab?: boolean;
  /** When given, each row offers a Link button that attaches the known error to the incident. */
  onLink?: (ke: SuggestedKnownError) => void;
  linking?: string | null;
}

/**
 * Known errors matching a free-text context (the title of an incident being raised or triaged).
 * Staff search the whole database for the chosen customer; customer users get the published entries
 * of their own organisation with the customer wording only. Hidden while nothing matches, and never
 * queried for a user without the permission (kedb:read, or portal:kedb for customers).
 */
export function KnownErrorSuggestions({ q, customerId, serviceId, ciId, excludeTicketId, limit, title = 'Known errors with a workaround', ...list }: ListProps & { q: string; customerId?: string | null; serviceId?: string | null; ciId?: string | null; excludeTicketId?: string | null; limit?: number }) {
  const isCustomer = useAuthStore((s) => s.isCustomer());
  const can = useAuthStore((s) => s.can);
  const allowed = isCustomer ? can('portal:kedb') : can('kedb:read');
  const term = useDebounced(q.trim());
  const enabled = allowed && term.length >= 3;
  const params = { q: term, customerId: customerId ?? undefined, serviceId: serviceId ?? undefined, ciId: isCustomer ? undefined : ciId ?? undefined, excludeTicketId: isCustomer ? undefined : excludeTicketId ?? undefined, limit };
  const query = useQuery({
    queryKey: isCustomer ? pk.knownErrorSuggest(params) : kedbKeys.suggest(params),
    queryFn: async (): Promise<SuggestedKnownError[]> => (isCustomer ? (await portalApi.knownErrorSuggest(params)).items.map(fromPortal) : (await kedbApi.suggest(params)).items.map(fromStaffRow)),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  const items = query.data ?? [];
  if (!enabled) return null;
  if (!query.isFetching && items.length === 0) return null;
  return <KnownErrorSuggestionList items={items} loading={query.isFetching} title={title} {...list} />;
}

/** The rendered list; the rail card feeds it the matches the ticket read already computed instead of querying again. */
export function KnownErrorSuggestionList({ items, loading, title = 'Known errors with a workaround', className, newTab = true, onLink, linking }: ListProps & { items: SuggestedKnownError[]; loading?: boolean }) {
  const isCustomer = useAuthStore((s) => s.isCustomer());
  return (
    <div className={cn('rounded-lg border border-default bg-surface', className)} data-testid="known-error-suggestions">
      {title && (
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-default text-[12.5px] font-semibold">
          <Bug className="h-3.5 w-3.5 text-orange-500" /> {title}
          {loading && <Loader2 className="h-3 w-3 animate-spin text-subtle ml-auto" />}
        </div>
      )}
      <ul className="divide-y divide-[var(--border)]">
        {items.map((s) => (
          <li key={s.id} className="flex items-start gap-2 px-3 py-2 text-[13px]">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 min-w-0">
                {!isCustomer && <span className="font-mono text-[11px] text-subtle shrink-0">{s.number}</span>}
                <Link to={`/knowledge/known-errors/${s.id}`} target={newTab ? '_blank' : undefined} rel={newTab ? 'noreferrer' : undefined} className="font-medium truncate hover:underline">{s.title}</Link>
                <KeStatusBadge status={s.keStatus} portal={isCustomer} className="py-0 shrink-0" />
              </span>
              {s.workaround && <span className="text-xs text-muted block mt-0.5 line-clamp-2">{truncate(s.workaround, 160)}</span>}
              {s.serviceName && <span className="text-[11.5px] text-subtle block truncate">{s.serviceName}</span>}
            </span>
            {onLink && (
              <Button size="sm" variant="outline" className="shrink-0 h-7 px-2" loading={linking === s.id} onClick={() => onLink(s)}>
                Link
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default KnownErrorSuggestions;
