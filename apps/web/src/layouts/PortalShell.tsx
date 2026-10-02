import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { PORTAL_NAV } from './nav';
import { Sidebar, NotificationBell, UserMenu, MobileNav, BrandLogo } from './AppShell';
import { GradyWidget } from '@/components/grady/GradyWidget';

export function PortalShell({ children }: { children: ReactNode }) {
  const can = useAuthStore((s) => s.can);
  const navigate = useNavigate();
  return (
    <div className="h-full flex bg-app">
      <Sidebar items={PORTAL_NAV} label="Customer Portal" />
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 flex items-center gap-2 px-4 md:px-6 border-b border-default bg-surface shrink-0">
          <BrandLogo className="md:hidden mr-1" />
          <div className="text-[13px] text-muted truncate">Managed services portal</div>
          <div className="flex-1" />
          {can('portal:tickets') && (
            <button onClick={() => navigate('/portal/tickets/new')} className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-navy-800 text-white text-[13px] font-medium hover:bg-navy-700 shadow-[0_1px_2px_rgba(9,9,11,0.2)]">
              <Plus className="h-4 w-4" /> Raise a ticket
            </button>
          )}
          <NotificationBell />
          <UserMenu />
        </header>
        <div className="flex-1 flex min-h-0">
          <main className="flex-1 overflow-y-auto">
            <div className="p-5 md:p-7 max-w-[1300px] mx-auto">{children}</div>
          </main>
        </div>
        <MobileNav items={PORTAL_NAV} />
      </div>
      <GradyWidget />
    </div>
  );
}
