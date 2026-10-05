import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Ticket, Building2, Boxes, Server, FileSignature, BookOpen, Layers, Wrench, Bug } from 'lucide-react';
import { useUiStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { get } from '@/api/client';
import { Dialog, Badge, Kbd } from '@/components/ui';

interface SearchHit {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
  badge?: string;
  badgeColor?: string;
  link: string;
}

const ICONS: Record<string, typeof Ticket> = { ticket: Ticket, customer: Building2, asset: Boxes, ci: Server, contract: FileSignature, kb: BookOpen, service: Layers, visit: Wrench, known_error: Bug };

export function GlobalSearch() {
  const { searchOpen, setSearchOpen } = useUiStore();
  const isCustomer = useAuthStore((s) => s.user?.userType === 'customer');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const { data, isFetching } = useQuery({
    queryKey: ['search', q],
    queryFn: () => get<{ items: SearchHit[] }>('/search', { q }),
    enabled: searchOpen && q.trim().length >= 2,
    staleTime: 10_000,
  });
  const items = data?.items ?? [];

  useEffect(() => {
    if (!searchOpen) {
      setQ('');
      setActive(0);
    }
  }, [searchOpen]);

  function go(hit: SearchHit) {
    setSearchOpen(false);
    navigate(isCustomer && hit.type === 'ticket' ? `/portal/tickets/${hit.id}` : hit.link);
  }

  if (isCustomer) return null;
  return (
    <Dialog open={searchOpen} onClose={() => setSearchOpen(false)} width="max-w-xl">
      <div className="flex items-center gap-2 -mx-1">
        <Search className="h-4 w-4 text-subtle" />
        <input
          autoFocus
          className="flex-1 bg-transparent outline-none text-[14px] py-1"
          placeholder="Search by ticket number, customer, hostname, IP, serial, contract…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, items.length - 1));
            if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
            if (e.key === 'Enter' && items[active]) go(items[active]);
          }}
        />
        <Kbd>esc</Kbd>
      </div>
      <div className="mt-3 -mx-5 border-t border-default max-h-[50vh] overflow-y-auto">
        {q.trim().length < 2 && <div className="px-5 py-6 text-[13px] text-muted">Type at least two characters. Results respect your customer access.</div>}
        {q.trim().length >= 2 && !isFetching && items.length === 0 && <div className="px-5 py-6 text-[13px] text-muted">No matches.</div>}
        {items.map((hit, i) => {
          const Icon = ICONS[hit.type] ?? Search;
          return (
            <button key={`${hit.type}-${hit.id}`} onMouseEnter={() => setActive(i)} onClick={() => go(hit)} className={`w-full flex items-center gap-3 px-5 py-2 text-left ${i === active ? 'bg-surface-2' : ''}`}>
              <Icon className="h-4 w-4 text-subtle shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] truncate">{hit.title}</div>
                {hit.subtitle && <div className="text-xs text-muted truncate">{hit.subtitle}</div>}
              </div>
              {hit.badge && <Badge color={hit.badgeColor}>{hit.badge}</Badge>}
              <span className="text-[10.5px] uppercase text-subtle">{hit.type}</span>
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
