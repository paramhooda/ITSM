import { type ReactNode, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Bell, Search, Sparkles, Sun, Moon, Monitor, LogOut, User, PanelLeftClose, PanelLeftOpen, ShieldCheck, Plus } from 'lucide-react';
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

export function SidebarNav({ items }: { items: NavItem[] }) {
  const can = useAuthStore((s) => s.can);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const visible = items.filter((i) => !i.perm || can(...i.perm));
  return (
    <nav className="flex-1 overflow-y-auto px-2 py-2">
      {visible.map((item) => (
        <div key={item.to}>
          {item.section && !collapsed && <div className="px-2 pt-4 pb-1 text-[10.5px] uppercase tracking-wider text-subtle font-semibold">{item.section}</div>}
          <NavLink
            to={item.to}
            end={item.to === '/'}
            title={item.label}
            className={({ isActive }) => cn('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] my-0.5 transition-colors', isActive ? 'bg-brand-600/10 text-brand-700 dark:text-brand-300 font-medium' : 'text-muted hover:bg-surface-2 hover:text-default', collapsed && 'justify-center')}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </NavLink>
        </div>
      ))}
    </nav>
  );
}

export function ThemeToggle() {
  const { theme, setTheme } = useUiStore();
  const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  return (
    <button onClick={() => setTheme(next)} className="h-8 w-8 rounded-md text-muted hover:bg-surface-2 hover:text-default flex items-center justify-center" title={`Theme: ${theme}`}>
      <Icon className="h-4 w-4" />
    </button>
  );
}

export function NotificationBell() {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['notifications', 'unread'], queryFn: () => get<{ unread: number }>('/notifications/unread-count'), refetchInterval: 30_000 });
  const unread = data?.unread ?? 0;
  return (
    <button onClick={() => navigate('/notifications')} className="relative h-8 w-8 rounded-md text-muted hover:bg-surface-2 hover:text-default flex items-center justify-center" title="Notifications">
      <Bell className="h-4 w-4" />
      {unread > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center">{unread > 99 ? '99+' : unread}</span>}
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
        <button className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-2">
          <Avatar name={user.name} />
          <span className="hidden md:block text-[13px] max-w-[140px] truncate">{user.name}</span>
        </button>
      }
      items={[
        { label: 'Profile & preferences', icon: <User className="h-4 w-4" />, onClick: () => navigate('/profile') },
        { label: 'Sign out', icon: <LogOut className="h-4 w-4" />, onClick: logout, danger: true },
      ]}
    />
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { sidebarCollapsed, toggleSidebar, setSearchOpen, setAssistantOpen, assistantOpen } = useUiStore();
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
    <div className="h-full flex">
      <aside className={cn('hidden md:flex flex-col border-r border-default bg-surface shrink-0 transition-[width]', sidebarCollapsed ? 'w-14' : 'w-56')}>
        <div className={cn('flex items-center gap-2 h-12 px-3 border-b border-default', sidebarCollapsed && 'justify-center px-0')}>
          <div className="h-7 w-7 rounded-md bg-slate-900 dark:bg-brand-600 text-sky-400 dark:text-white flex items-center justify-center shrink-0">
            <ShieldCheck className="h-4 w-4" />
          </div>
          {!sidebarCollapsed && <div className="font-semibold text-[13px] leading-tight truncate">MSP Service Management</div>}
        </div>
        <SidebarNav items={MSP_NAV} />
        <button onClick={toggleSidebar} className="h-10 border-t border-default text-subtle hover:text-default flex items-center justify-center" title="Toggle sidebar">
          {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 flex items-center gap-2 px-3 border-b border-default bg-surface shrink-0">
          <button onClick={() => setSearchOpen(true)} className="flex items-center gap-2 h-8 px-3 rounded-md bg-surface-2 text-muted text-[13px] w-full max-w-md hover:text-default">
            <Search className="h-4 w-4" />
            <span className="flex-1 text-left">Search tickets, customers, assets, CIs…</span>
            <Kbd>⌘K</Kbd>
          </button>
          <div className="flex-1" />
          {can('tickets:create') && (
            <button onClick={() => navigate('/tickets/new')} className="hidden sm:flex items-center gap-1.5 h-8 px-3 rounded-md bg-brand-600 text-white text-[13px] font-medium hover:bg-brand-700">
              <Plus className="h-4 w-4" /> New ticket
            </button>
          )}
          {can('ai:use') && (
            <button onClick={() => setAssistantOpen(!assistantOpen)} className={cn('h-8 w-8 rounded-md flex items-center justify-center text-muted hover:bg-surface-2 hover:text-default', assistantOpen && 'bg-brand-600/10 text-brand-600')} title="AI assistant">
              <Sparkles className="h-4 w-4" />
            </button>
          )}
          <NotificationBell />
          <ThemeToggle />
          <UserMenu />
        </header>
        <div className="flex-1 flex min-h-0">
          <main className="flex-1 overflow-y-auto p-4 md:p-5">{children}</main>
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
        <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => cn('flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px]', isActive ? 'text-brand-600' : 'text-muted')}>
          <item.icon className="h-4 w-4" />
          {item.label.split(' ')[0]}
        </NavLink>
      ))}
    </nav>
  );
}
