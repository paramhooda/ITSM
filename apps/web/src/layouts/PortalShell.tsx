import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Sparkles } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { cn } from '@/lib/utils';
import { PORTAL_NAV } from './nav';
import { Sidebar, NotificationBell, UserMenu, MobileNav, BrandLogo } from './AppShell';
import { AssistantPanel } from '@/components/AssistantPanel';

export function PortalShell({ children }: { children: ReactNode }) {
  const can = useAuthStore((s) => s.can);
  const navigate = useNavigate();
  const { assistantOpen, setAssistantOpen } = useUiStore();
  return (
    <div className="h-full flex bg-app">
      <Sidebar items={PORTAL_NAV} label="Customer Portal" />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 flex items-center gap-2 px-4 md:px-6 border-b border-default bg-surface shrink-0">
          <div className="text-[13px] text-muted truncate">Managed services portal</div>
          <div className="flex-1" />
          {can('portal:tickets') && (
            <button onClick={() => navigate('/portal/tickets/new')} className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-navy-800 text-white text-[13px] font-medium hover:bg-navy-700 shadow-[0_1px_2px_rgba(9,9,11,0.2)]">
              <Plus className="h-4 w-4" /> Raise a ticket
            </button>
          )}
          {can('ai:use') && (
            <button onClick={() => setAssistantOpen(!assistantOpen)} className={cn('h-9 w-9 rounded-lg flex items-center justify-center text-muted hover:bg-surface-2', assistantOpen && 'bg-surface-2 text-default')} title="AI assistant">
              <Sparkles className="h-[18px] w-[18px]" strokeWidth={1.8} />
            </button>
          )}
          <NotificationBell />
          <div className="hidden sm:block w-px h-6 mx-1" style={{ background: 'var(--border)' }} />
          <BrandLogo className="hidden sm:inline-flex mx-1" />
          <UserMenu />
        </header>
        <div className="flex-1 flex min-h-0">
          <main className="flex-1 overflow-y-auto">
            <div className="p-5 md:p-7 max-w-[1300px] mx-auto">{children}</div>
          </main>
          {assistantOpen && <AssistantPanel />}
        </div>
        <MobileNav items={PORTAL_NAV} />
      </div>
    </div>
  );
}
