import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Sparkles, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { cn } from '@/lib/utils';
import { PORTAL_NAV } from './nav';
import { SidebarNav, ThemeToggle, NotificationBell, UserMenu, MobileNav } from './AppShell';
import { AssistantPanel } from '@/components/AssistantPanel';

export function PortalShell({ children }: { children: ReactNode }) {
  const can = useAuthStore((s) => s.can);
  const navigate = useNavigate();
  const { assistantOpen, setAssistantOpen, sidebarCollapsed } = useUiStore();
  return (
    <div className="h-full flex">
      <aside className={cn('hidden md:flex flex-col border-r border-default bg-surface shrink-0', sidebarCollapsed ? 'w-14' : 'w-56')}>
        <div className={cn('flex items-center gap-2 h-12 px-3 border-b border-default', sidebarCollapsed && 'justify-center px-0')}>
          <div className="h-7 w-7 rounded-md bg-slate-900 dark:bg-brand-600 text-sky-400 dark:text-white flex items-center justify-center shrink-0">
            <ShieldCheck className="h-4 w-4" />
          </div>
          {!sidebarCollapsed && <div className="font-semibold text-[13px] leading-tight truncate">Customer Portal</div>}
        </div>
        <SidebarNav items={PORTAL_NAV} />
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 flex items-center gap-2 px-3 border-b border-default bg-surface shrink-0">
          <div className="text-[13px] text-muted truncate">Managed Services Portal</div>
          <div className="flex-1" />
          {can('portal:tickets') && (
            <button onClick={() => navigate('/portal/tickets/new')} className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-brand-600 text-white text-[13px] font-medium hover:bg-brand-700">
              <Plus className="h-4 w-4" /> Raise a ticket
            </button>
          )}
          {can('ai:use') && (
            <button onClick={() => setAssistantOpen(!assistantOpen)} className={cn('h-8 w-8 rounded-md flex items-center justify-center text-muted hover:bg-surface-2', assistantOpen && 'bg-brand-600/10 text-brand-600')} title="AI assistant">
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
        <MobileNav items={PORTAL_NAV} />
      </div>
    </div>
  );
}
