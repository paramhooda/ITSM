import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { ModuleNav } from '@/components/ui/ModuleNav';
import { CMDB_MODULES } from '@/layouts/modules';

/** Module strip at the top of every Configuration (CMDB) page, mirroring the navigator's modules. */
export function CmdbNav({ className }: { className?: string }) {
  return <ModuleNav items={CMDB_MODULES} className={className} label="Configuration modules" />;
}

/** Secondary strip inside Discovery: Overview · Sources · Runs · Findings. */
export function DiscoveryNav({ className }: { className?: string }) {
  const { pathname } = useLocation();
  const items = [
    { to: '/cmdb/discovery', label: 'Overview', end: true },
    { to: '/cmdb/discovery/sources', label: 'Sources' },
    { to: '/cmdb/discovery/runs', label: 'Runs' },
    { to: '/cmdb/discovery/findings', label: 'Findings' },
  ];
  return (
    <div className={cn('inline-flex items-center rounded-lg bg-surface-2 p-0.5 border border-default h-9', className)}>
      {items.map((m) => {
        const active = m.end ? pathname === m.to : pathname === m.to || pathname.startsWith(m.to + '/');
        return (
          <NavLink key={m.to} to={m.to} end={m.end} className={cn('inline-flex items-center rounded-md px-3 h-full text-[12.5px] font-medium whitespace-nowrap transition-colors', active ? 'bg-white text-default shadow-[0_1px_2px_rgba(9,9,11,0.08)] border border-default' : 'text-muted hover:text-default border border-transparent')}>
            {m.label}
          </NavLink>
        );
      })}
    </div>
  );
}
