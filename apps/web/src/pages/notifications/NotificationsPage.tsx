import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bell, CheckCheck, Inbox, ExternalLink } from 'lucide-react';
import { get, post, ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { Button, EmptyState, ErrorBlock, LoadingBlock, PageHeader, Toggle } from '@/components/ui';
import { fmtDateTime, relativeTime, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Notification {
  id: string;
  event: string;
  title: string;
  body: string | null;
  link: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

interface Page {
  items: Notification[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 30;

const EVENT_COLORS: Record<string, string> = {
  'sla.breached': 'text-red-600',
  'sla.warning': 'text-amber-600',
  'ticket.escalated': 'text-orange-600',
  'contract.expired': 'text-red-600',
  'contract.expiring': 'text-amber-600',
  'entitlement.exhausted': 'text-red-600',
};

export default function NotificationsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isCustomer = useAuthStore((s) => s.user?.userType === 'customer');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const list = useInfiniteQuery({
    queryKey: ['notifications', 'list', unreadOnly],
    queryFn: ({ pageParam }) => get<Page>('/notifications', { page: pageParam, pageSize: PAGE_SIZE, unread: unreadOnly ? 'true' : undefined }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  const markRead = useMutation({
    mutationFn: (payload: { ids?: string[]; all?: boolean }) => post<{ unread: number }>('/notifications/read', payload),
    onSuccess: invalidate,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not update notifications'),
  });

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const unreadCount = items.filter((n) => !n.readAt).length;

  function open(n: Notification) {
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    if (!n.link) return;
    if (/^https?:\/\//.test(n.link)) {
      window.open(n.link, '_blank', 'noopener');
      return;
    }
    let link = n.link;
    if (isCustomer && link.startsWith('/tickets/')) link = `/portal${link}`;
    navigate(link);
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Notifications"
        subtitle={total ? `${total} notification${total === 1 ? '' : 's'}${unreadOnly ? ' unread' : ''}` : undefined}
        actions={
          <>
            <Toggle checked={unreadOnly} onChange={setUnreadOnly} label="Unread only" />
            <Button variant="outline" size="sm" icon={<CheckCheck className="h-4 w-4" />} onClick={() => markRead.mutate({ all: true })} loading={markRead.isPending} disabled={unreadCount === 0 && !unreadOnly}>
              Mark all read
            </Button>
          </>
        }
      />

      <div className="card" style={{ padding: 0 }}>
        {list.isLoading && <LoadingBlock />}
        {list.isError && <ErrorBlock error={list.error} retry={() => list.refetch()} />}
        {!list.isLoading && items.length === 0 && <EmptyState icon={<Inbox className="h-5 w-5" />} title={unreadOnly ? 'No unread notifications' : 'No notifications yet'} description="Ticket updates, SLA warnings, approvals and contract milestones will appear here." />}
        {items.length > 0 && (
          <ul className="divide-y divide-[var(--border)]">
            {items.map((n) => {
              const unread = !n.readAt;
              return (
                <li key={n.id} className={cn('flex items-start gap-3 px-4 py-3 transition-colors', unread ? 'bg-brand-600/5' : '', n.link && 'cursor-pointer hover:bg-surface-2/60')} onClick={() => open(n)}>
                  <span className="mt-1.5 shrink-0 w-2 flex justify-center">{unread ? <span className="h-2 w-2 rounded-full bg-brand-600" /> : <span className="h-2 w-2" />}</span>
                  <Bell className={cn('h-4 w-4 mt-0.5 shrink-0', EVENT_COLORS[n.event] ?? 'text-subtle')} />
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-[13.5px] truncate', unread ? 'font-semibold' : 'font-medium')}>{n.title}</div>
                    {n.body && <div className="text-[12.5px] text-muted mt-0.5 line-clamp-2">{n.body}</div>}
                    <div className="text-[11.5px] text-subtle mt-1 flex items-center gap-2">
                      <span title={fmtDateTime(n.createdAt)}>{relativeTime(n.createdAt)}</span>
                      <span>· {titleCase(n.event.replace(/\./g, ' '))}</span>
                      {n.link && (
                        <span className="inline-flex items-center gap-0.5">
                          · <ExternalLink className="h-3 w-3" /> open
                        </span>
                      )}
                    </div>
                  </div>
                  {unread && (
                    <button
                      className="text-[11.5px] text-muted hover:text-default shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        markRead.mutate({ ids: [n.id] });
                      }}
                    >
                      Mark read
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {list.hasNextPage && (
          <div className="flex justify-center py-3 border-t border-default">
            <Button variant="ghost" size="sm" onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
              Load more ({items.length} of {total})
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
