import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { SOFTWARE_MODULES } from '@/layouts/modules';

/** Secondary strip inside Software: Overview · Titles · Installations · Licences · Compliance · Renewals (the Discovery shape). */
export function SoftwareNav({ className }: { className?: string }) {
  const { pathname } = useLocation();
  return (
    <nav className={cn('inline-flex items-center rounded-lg bg-surface-2 p-0.5 border border-default h-9 max-w-full overflow-x-auto', className)} aria-label="Software modules">
      {SOFTWARE_MODULES.map((m) => {
        const active = m.end ? pathname === m.to : pathname === m.to || pathname.startsWith(m.to + '/');
        return (
          <NavLink key={m.to} to={m.to} end={m.end} className={cn('inline-flex items-center rounded-md px-3 h-full text-[12.5px] font-medium whitespace-nowrap transition-colors', active ? 'bg-white text-default shadow-[0_1px_2px_rgba(9,9,11,0.08)] border border-default' : 'text-muted hover:text-default border border-transparent')}>
            {m.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
