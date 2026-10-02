import { type ReactNode, useEffect } from 'react';
import { NavLink, useNavigate, Link } from 'react-router-dom';
import { Bell, Search, Sparkles, LogOut, User, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { api, get } from '@/api/client';
import { cn } from '@/lib/utils';
import { Avatar, Kbd } from '@/components/ui';
import { MSP_NAV, type NavItem } from './nav';
import { GlobalSearch } from '@/components/GlobalSearch';
import { AssistantPanel } from '@/components/AssistantPanel';
import { Menu } from '@/components/Menu';

export function BrandLogo({ className }: { className?: string }) {
  return (
    <Link to="/" className={cn('inline-flex items-center shrink-0', className)} aria-label="Progression home">
      <img src="/logo.png" alt="Progression" className="h-7 w-auto select-none" draggable={false} />
    </Link>
  );
}

export function SidebarNav({ items }: { items: NavItem[] }) {
  const can = useAuthStore((s) => s.can);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const visible = items.filter((i) => !i.perm || can(...i.perm));
  return (
    <nav className="flex-1 overflow-y-auto px-3 py-3">
      {visible.map((item) => (
        <div key={item.to}>
          {item.section && !collapsed && <div className="px-2.5 pt-5 pb-1.5 text-[11px] uppercase tracking-[0.08em] text-subtle font-medium">{item.section}</div>}
          <NavLink
            to={item.to}
            end={item.to === '/'}
            title={item.label}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 h-8.5 text-[13.5px] my-0.5 transition-colors',
                isActive ? 'bg-white text-default font-medium border border-default shadow-[0_1px_2px_rgba(9,9,11,0.05)]' : 'text-secondary border border-transparent hover:bg-white/70 hover:text-default',
                collapsed && 'justify-center px-0',
              )
            }
          >
            <item.icon className="h-[17px] w-[17px] shrink-0" strokeWidth={1.8} />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </NavLink>
        </div>
      ))}
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

export function Sidebar({ items, label }: { items: NavItem[]; label: string }) {
  const { sidebarCollapsed, toggleSidebar } = useUiStore();
  return (
    <aside className={cn('hidden md:flex flex-col border-r border-default bg-[#fafafa] shrink-0 transition-[width] duration-200', sidebarCollapsed ? 'w-[60px]' : 'w-60')}>
      <div className={cn('flex items-center h-14 px-5 border-b border-default', sidebarCollapsed && 'justify-center px-0')}>
        {sidebarCollapsed ? (
          <img src="/favicon.svg" alt="" className="h-6 w-6 rounded-md" />
        ) : (
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold text-default leading-tight truncate">{label}</div>
            <div className="text-[11.5px] text-subtle leading-tight">Progression</div>
          </div>
        )}
      </div>
      <SidebarNav items={items} />
      <button onClick={toggleSidebar} className="h-11 border-t border-default text-subtle hover:text-default hover:bg-surface-2 flex items-center justify-center" title="Toggle sidebar">
        {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
      </button>
    </aside>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { setSearchOpen, setAssistantOpen, assistantOpen } = useUiStore();
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
          <button onClick={() => setSearchOpen(true)} className="flex items-center gap-2.5 h-9 px-3 rounded-lg bg-white border border-default hover:border-strong text-muted text-[13px] w-full max-w-md transition-colors shadow-[0_1px_2px_rgba(9,9,11,0.03)]">
            <Search className="h-4 w-4" />
            <span className="flex-1 text-left truncate">Search tickets, customers, assets, CIs…</span>
            <Kbd>⌘K</Kbd>
          </button>
          <div className="flex-1" />
          {can('tickets:create') && (
            <button onClick={() => navigate('/tickets/new')} className="hidden sm:inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-white border border-default text-default text-[13px] font-medium hover:bg-surface-2 hover:border-strong shadow-[0_1px_2px_rgba(9,9,11,0.04)] transition-colors">
              <Plus className="h-4 w-4" /> New ticket
            </button>
          )}
          {can('ai:use') && (
            <button onClick={() => setAssistantOpen(!assistantOpen)} className={cn('h-9 w-9 rounded-lg flex items-center justify-center text-muted hover:bg-surface-2 hover:text-default', assistantOpen && 'bg-surface-2 text-default')} title="AI assistant">
              <Sparkles className="h-[18px] w-[18px]" strokeWidth={1.8} />
            </button>
          )}
          <NotificationBell />
          <div className="hidden sm:block w-px h-6 bg-border mx-1" style={{ background: 'var(--border)' }} />
          <BrandLogo className="hidden sm:inline-flex mx-1" />
          <UserMenu />
        </header>
        <div className="flex-1 flex min-h-0">
          <main className="flex-1 overflow-y-auto">
            <div className="p-5 md:p-7 max-w-[1500px] mx-auto">{children}</div>
          </main>
          {assistantOpen && <AssistantPanel />}
        </div>
        <MobileNav items={MSP_NAV} />
      </div>
      <GlobalSearch />
    </div>
  );
}

export function MobileNav({ items }: { items: NavItem[] }) {
  const can = useAuthStore((s) => s.can);
  const visible = items.filter((i) => !i.perm || can(...i.perm)).slice(0, 5);
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
