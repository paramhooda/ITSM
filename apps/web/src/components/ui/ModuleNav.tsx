import { NavLink, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import type { ModuleItem } from '@/layouts/modules';

/**
 * The module strip under a page header: Overview · <module> · <module> …, one per
 * application (definitions live in layouts/modules.ts). Permission-filtered, with
 * the current module underlined. Identical on staff and portal pages.
 */
export function ModuleNav({ items, className, label = 'Modules' }: { items: ModuleItem[]; className?: string; label?: string }) {
  const can = useAuthStore((s) => s.can);
  const { pathname } = useLocation();
  const visible = items.filter((m) => !m.perm || can(...m.perm));
  if (visible.length < 2) return null;
  return (
    <nav className={cn('flex items-center gap-1 border-b border-default overflow-x-auto -mt-2 mb-4', className)} aria-label={label}>
      {visible.map((m) => {
        // A module may carry a query string (the dashboards strip keeps the period and the scope); the path decides what is current.
        const path = m.to.split('?')[0]!;
        const active = m.match ? m.match(pathname) : m.end ? pathname === path : pathname === path || pathname.startsWith(path + '/');
        return (
          <NavLink key={m.to} to={m.to} end={m.end} aria-current={active ? 'page' : undefined} className={cn('px-3 py-2 text-[13px] font-medium border-b-2 -mb-px whitespace-nowrap transition-colors', active ? 'border-brand-600 text-default' : 'border-transparent text-muted hover:text-default')}>
            {m.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
