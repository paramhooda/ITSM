import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate, Link, useLocation } from 'react-router-dom';
import { Bell, Search, LogOut, User, Plus, ChevronLeft, ChevronRight, ChevronDown, Filter } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { api, get } from '@/api/client';
import { cn } from '@/lib/utils';
import { Avatar, Kbd } from '@/components/ui';
import { Tooltip } from '@/components/ui/Tooltip';
import { MSP_NAV, visibleNav, type NavItem, type NavChild } from './nav';
import { GlobalSearch } from '@/components/GlobalSearch';
import { GradyWidget } from '@/components/grady/GradyWidget';
import { Menu } from '@/components/Menu';

export function BrandLogo({ className }: { className?: string }) {
  return (
    <Link to="/" className={cn('inline-flex items-center shrink-0', className)} aria-label="Progression home">
      <img src="/logo.png" alt="Progression" className="h-7 w-auto select-none" draggable={false} />
    </Link>
  );
}

const NAV_OPEN_KEY = 'itsm.nav.open';
const readOpen = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(NAV_OPEN_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
};

/** Which module of an application matches the current URL (query-string modules match exactly). */
function activeChild(children: NavChild[], pathname: string, search: string): NavChild | undefined {
  const here = pathname + search;
  const exact = children.find((c) => c.to === here);
  if (exact) return exact;
  const plain = children.filter((c) => !c.to.includes('?'));
  return plain.find((c) => c.to !== '/' && pathname === c.to) ?? plain.filter((c) => c.to !== '/' && pathname.startsWith(c.to + '/')).sort((a, b) => b.to.length - a.to.length)[0];
}

/**
 * Application navigator: applications grouped by section, each expandable into its
 * modules, with a "Filter navigator" box like ServiceNow's.
 */
export function SidebarNav({ items, label }: { items: NavItem[]; label?: string }) {
  const can = useAuthStore((s) => s.can);
  const areas = useAuthStore((s) => s.user?.areas);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const { pathname, search } = useLocation();
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const visible = useMemo(() => visibleNav(items, can, areas), [items, can, areas]);
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle
        ? visible
            .map((i) => ({ ...i, children: i.children?.filter((c) => c.label.toLowerCase().includes(needle)) }))
            .filter((i) => i.label.toLowerCase().includes(needle) || (i.children?.length ?? 0) > 0)
        : visible,
    [visible, needle],
  );
  const toggle = (key: string) =>
    setOpen((o) => {
      const next = { ...o, [key]: !(o[key] ?? false) };
      try {
        localStorage.setItem(NAV_OPEN_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  const isAppActive = (item: NavItem) => (item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(item.to + '/'));
  return (
    <nav className={cn('flex-1 overflow-y-auto py-3', collapsed ? 'px-2' : 'px-3')} aria-label={label}>
      {!collapsed && (
        <div className="relative mb-2 px-0.5">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-subtle pointer-events-none" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter navigator" aria-label="Filter navigator" className="input h-8 pl-8 text-[12.5px] bg-white" />
        </div>
      )}
      {label && !collapsed && !needle && <div className="px-2.5 pb-1.5 text-[11px] uppercase tracking-[0.08em] text-subtle font-medium">{label}</div>}
      {shown.map((item) => {
        const children = item.children ?? [];
        const appActive = isAppActive(item);
        const expanded = children.length > 0 && !collapsed && (needle ? true : (open[item.to] ?? appActive));
        const current = activeChild(children, pathname, search);
        return (
          <div key={item.to}>
            {item.section && !needle && (collapsed ? <div className="my-2 mx-2 border-t border-default" aria-hidden /> : <div className="px-2.5 pt-5 pb-1.5 text-[11px] uppercase tracking-[0.08em] text-subtle font-medium">{item.section}</div>)}
            <div className="flex items-center">
              <Tooltip label={collapsed ? item.label : undefined} className="flex-1 min-w-0">
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  aria-label={item.label}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2.5 rounded-lg h-8.5 text-[13.5px] my-0.5 transition-colors',
                      (isActive || appActive) && !(expanded && current && current.to !== item.to) ? 'bg-white text-default font-medium border border-default shadow-[0_1px_2px_rgba(9,9,11,0.05)]' : 'text-secondary border border-transparent hover:bg-white/70 hover:text-default',
                      collapsed ? 'justify-center px-0' : 'px-2.5',
                    )
                  }
                >
                  <item.icon className={cn('h-[17px] w-[17px] shrink-0', !appActive && item.tint)} strokeWidth={1.9} />
                  {!collapsed && <span className="truncate flex-1">{item.label}</span>}
                  {!collapsed && children.length > 0 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggle(item.to);
                      }}
                      aria-label={expanded ? `Collapse ${item.label}` : `Expand ${item.label}`}
                      aria-expanded={expanded}
                      className="h-6 w-6 -mr-1 rounded-md inline-flex items-center justify-center text-subtle hover:text-default hover:bg-surface-2"
                    >
                      <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !expanded && '-rotate-90')} />
                    </button>
                  )}
                </NavLink>
              </Tooltip>
            </div>
            {expanded && (
              <ul className="ml-[21px] border-l border-default pl-2 my-0.5">
                {children.map((c) => (
                  <li key={c.to}>
                    <Link to={c.to} className={cn('flex items-center h-7 rounded-md px-2 text-[12.5px] transition-colors truncate', current?.to === c.to ? 'bg-white text-default font-medium border border-default' : 'text-muted border border-transparent hover:text-default hover:bg-white/70')} aria-current={current?.to === c.to ? 'page' : undefined}>
                      {c.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {needle && shown.length === 0 && <div className="px-2.5 py-2 text-[12.5px] text-subtle">No modules match.</div>}
    </nav>
  );
}

export function NotificationBell() {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['notifications', 'unread'], queryFn: () => get<{ unread: number }>('/notifications/unread-count'), refetchInterval: 30_000 });
  const unread = data?.unread ?? 0;
  return (
    <button onClick={() => navigate('/notifications')} className="relative h-9 w-9 rounded-lg text-muted hover:bg-surface-2 hover:text-default flex items-center justify-center" title="Notifications">
      <Bell className="h-[18px] w-[18px]" strokeWidth={1.8} />
      {unread > 0 && <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center ring-2 ring-white">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}

export function UserMenu() {
  const user = useAuthStore((s) => s.user)!;
  const clear = useAuthStore((s) => s.clear);
  const navigate = useNavigate();
  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
    } finally {
      clear();
      navigate('/login');
    }
  }
  return (
    <Menu
      trigger={
        <button className="flex items-center gap-2 rounded-lg pl-1 pr-2 h-9 hover:bg-surface-2" title={user.email}>
          <Avatar name={user.name} />
          <span className="hidden md:block text-[13px] max-w-[140px] truncate text-default">{user.name}</span>
        </button>
      }
      items={[
        { label: 'Profile & preferences', icon: <User className="h-4 w-4" />, onClick: () => navigate('/profile') },
        { label: 'Sign out', icon: <LogOut className="h-4 w-4" />, onClick: logout, danger: true },
      ]}
    />
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const SIDEBAR_SHORTCUT = `${isMac ? '⌘' : 'Ctrl'}+B`;

/** Left navigation: logo top-left, collapsible to an icon rail with a handle on its edge and ⌘B / Ctrl+B. */
export function Sidebar({ items, label }: { items: NavItem[]; label: string }) {
  const { sidebarCollapsed, toggleSidebar } = useUiStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);
  const tip = `${sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar · ${SIDEBAR_SHORTCUT}`;
  return (
    <aside className={cn('group/side relative hidden md:flex flex-col border-r border-default bg-app shrink-0 transition-[width] duration-200', sidebarCollapsed ? 'w-[60px]' : 'w-60')} data-collapsed={sidebarCollapsed || undefined}>
      <div className={cn('flex items-center h-14 border-b border-default shrink-0', sidebarCollapsed ? 'justify-center px-0' : 'px-4')}>
        {sidebarCollapsed ? (
          <Link to="/" aria-label="Progression home" className="inline-flex">
            <img src="/favicon.svg" alt="" className="h-7 w-7 rounded-md" draggable={false} />
          </Link>
        ) : (
          <BrandLogo />
        )}
      </div>
      <Tooltip label={tip} className="absolute -right-3 top-[18px] z-20">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-expanded={!sidebarCollapsed}
          aria-label={tip}
          className={cn(
            'h-6 w-6 rounded-full border border-default bg-white text-muted shadow-[0_1px_3px_rgba(9,9,11,0.12)] flex items-center justify-center hover:text-default hover:border-strong hover:shadow-raised transition-[opacity,box-shadow,border-color] focus-visible:opacity-100 focus:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-500/30',
            !sidebarCollapsed && 'opacity-0 group-hover/side:opacity-100',
          )}
        >
          {sidebarCollapsed ? <ChevronRight className="h-3.5 w-3.5" strokeWidth={2.2} /> : <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2.2} />}
        </button>
      </Tooltip>
      <SidebarNav items={items} label={label} />
    </aside>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { setSearchOpen } = useUiStore();
  const can = useAuthStore((s) => s.can);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSearchOpen]);

  return (
    <div className="h-full flex bg-app">
      <Sidebar items={MSP_NAV} label="Service Management" />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 flex items-center gap-2 px-4 md:px-6 border-b border-default bg-surface shrink-0">
          <BrandLogo className="md:hidden mr-1" />
          <button onClick={() => setSearchOpen(true)} className="flex items-center gap-2.5 h-9 px-3 rounded-lg bg-white border border-default hover:border-strong text-muted text-[13px] flex-1 min-w-0 max-w-md transition-colors shadow-[0_1px_2px_rgba(9,9,11,0.03)]">
            <Search className="h-4 w-4" />
            <span className="flex-1 text-left truncate">Search tickets, customers, assets, CIs…</span>
            <span className="hidden sm:inline-flex"><Kbd>⌘K</Kbd></span>
          </button>
          <div className="flex-1" />
          {can('tickets:create') && (
            <button onClick={() => navigate('/tickets/new')} className="hidden sm:inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-white border border-default text-default text-[13px] font-medium hover:bg-surface-2 hover:border-strong shadow-[0_1px_2px_rgba(9,9,11,0.04)] transition-colors">
              <Plus className="h-4 w-4" /> New ticket
            </button>
          )}
          <NotificationBell />
          <UserMenu />
        </header>
        <div className="flex-1 flex min-h-0">
          <main className="flex-1 overflow-y-auto">
            <div className="p-5 md:p-7 max-w-[1500px] mx-auto">{children}</div>
          </main>
        </div>
        <MobileNav items={MSP_NAV} />
      </div>
      <GlobalSearch />
      <GradyWidget />
    </div>
  );
}

export function MobileNav({ items }: { items: NavItem[] }) {
  const can = useAuthStore((s) => s.can);
  const areas = useAuthStore((s) => s.user?.areas);
  const visible = visibleNav(items, can, areas).slice(0, 5);
  return (
    <nav className="md:hidden flex border-t border-default bg-surface shrink-0">
      {visible.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => cn('flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px]', isActive ? 'text-default' : 'text-muted')}>
          <item.icon className="h-4 w-4" />
          {item.label.split(' ')[0]}
        </NavLink>
      ))}
    </nav>
  );
}
