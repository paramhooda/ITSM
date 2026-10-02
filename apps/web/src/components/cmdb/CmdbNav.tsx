import { NavLink, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';

const MODULES = [
  { to: '/cmdb', label: 'Overview', end: true },
  { to: '/cmdb/cis', label: 'Configuration items' },
  { to: '/cmdb/services', label: 'Business services' },
  { to: '/cmdb/map', label: 'Service map' },
  { to: '/cmdb/classes', label: 'CI classes' },
  { to: '/cmdb/discovery', label: 'Discovery', perm: ['discovery:run', 'discovery:manage'] as const },
];

/** Module strip at the top of every Configuration (CMDB) page, mirroring the navigator's modules. */
export function CmdbNav({ className }: { className?: string }) {
  const can = useAuthStore((s) => s.can);
  const { pathname } = useLocation();
  return (
    <nav className={cn('flex items-center gap-1 border-b border-default overflow-x-auto -mt-2 mb-4', className)} aria-label="Configuration modules">
      {MODULES.filter((m) => !m.perm || can(...m.perm)).map((m) => {
        const active = m.end ? pathname === m.to : pathname === m.to || pathname.startsWith(m.to + '/');
        return (
          <NavLink key={m.to} to={m.to} end={m.end} className={cn('px-3 py-2 text-[13px] font-medium border-b-2 -mb-px whitespace-nowrap transition-colors', active ? 'border-brand-600 text-default' : 'border-transparent text-muted hover:text-default')}>
            {m.label}
          </NavLink>
        );
      })}
    </nav>
  );
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
