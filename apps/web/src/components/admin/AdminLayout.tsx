import { type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { Permission } from '@itsm/shared';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';
import { Select , PageHeader } from '@/components/ui';

export interface AdminNavItem {
  to: string;
  label: string;
  perm?: Permission[];
  /** Matches nested routes (e.g. /admin/sla/:id). */
  prefix?: boolean;
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

const CONFIG: Permission[] = ['admin:config'];
const USERS: Permission[] = ['admin:users'];
const SYSTEM: Permission[] = ['admin:system', 'admin:config'];

/** The administration rail, grouped the way the staff navigator is (every `to` has a route in AdminPage.tsx and an APP_PAGES entry). */
export const ADMIN_NAV: AdminNavGroup[] = [
  { label: 'Overview', items: [{ to: '/admin', label: 'Overview' }] },
  {
    label: 'Operating model',
    items: [
      { to: '/admin/options', label: 'Option lists', perm: CONFIG, prefix: true },
      { to: '/admin/priority-matrix', label: 'Priority matrix', perm: CONFIG },
      { to: '/admin/custom-fields', label: 'Custom fields', perm: CONFIG },
      { to: '/admin/services', label: 'Service catalog', perm: ['services:manage'] },
      { to: '/admin/catalog', label: 'Request catalog', perm: CONFIG, prefix: true },
    ],
  },
  {
    label: 'Service levels',
    items: [
      { to: '/admin/sla', label: 'SLA policies', perm: CONFIG, prefix: true },
      { to: '/admin/calendars', label: 'Business calendars', perm: CONFIG },
      { to: '/admin/holidays', label: 'Holiday calendars', perm: CONFIG },
    ],
  },
  {
    label: 'Workflow & automation',
    items: [
      { to: '/admin/assignment-rules', label: 'Assignment rules', perm: CONFIG },
      { to: '/admin/escalation-rules', label: 'Escalation rules', perm: CONFIG },
      { to: '/admin/approvals', label: 'Approval workflows', perm: CONFIG },
      // slot #6: { to: '/admin/surveys', label: 'Satisfaction surveys', perm: ['surveys:manage', 'admin:config'] }
    ],
  },
  {
    label: 'Change management',
    items: [
      { to: '/admin/change-templates', label: 'Standard change templates', perm: CONFIG },
      { to: '/admin/change-risk-questions', label: 'Change risk questions', perm: CONFIG },
      { to: '/admin/change-blackouts', label: 'Blackout windows', perm: CONFIG },
    ],
  },
  {
    label: 'CMDB model',
    items: [
      { to: '/admin/ci-types', label: 'CI types', perm: CONFIG },
      { to: '/admin/relationship-types', label: 'Relationship types', perm: CONFIG },
    ],
  },
  {
    label: 'Notifications',
    items: [
      { to: '/admin/notifications/templates', label: 'Notification templates', perm: CONFIG },
      { to: '/admin/notifications/rules', label: 'Notification rules', perm: CONFIG },
      { to: '/admin/whatsapp', label: 'WhatsApp', perm: SYSTEM },
      { to: '/admin/outbox', label: 'Notification outbox', perm: SYSTEM },
    ],
  },
  {
    label: 'Access',
    items: [
      { to: '/admin/users', label: 'Users', perm: USERS },
      { to: '/admin/roles', label: 'Roles', perm: USERS },
      { to: '/admin/teams', label: 'Teams', perm: USERS },
      { to: '/admin/api-keys', label: 'API keys', perm: ['integrations:manage'] },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/admin/settings', label: 'Settings', perm: SYSTEM },
      { to: '/admin/ai', label: 'AI assistant', perm: SYSTEM },
      { to: '/admin/audit', label: 'Audit log', perm: ['admin:audit'] },
      { to: '/admin/integrations', label: 'Monitoring & SIEM', perm: ['integrations:events', 'integrations:manage'] },
    ],
  },
];

export function useAdminNav() {
  const can = useAuthStore((s) => s.can);
  return ADMIN_NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.perm || can(...i.perm)) })).filter((g) => g.items.length);
}

/** Left sub-navigation + plain content pane for the administration area. */
export function AdminLayout({ children }: { children: ReactNode }) {
  const groups = useAdminNav();
  const location = useLocation();
  const navigate = useNavigate();
  const current = groups.flatMap((g) => g.items).find((i) => (i.prefix ? location.pathname.startsWith(i.to) : location.pathname === i.to))?.to ?? '/admin';
  return (
    <div className="flex gap-6 min-h-full">
      <aside className="hidden lg:block w-48 shrink-0">
        <div className="sticky top-0">
          <div className="text-[15px] font-semibold px-2 pb-2 tracking-[-0.01em]">Administration</div>
          {groups.map((g) => (
            <div key={g.label} className="mb-3">
              {g.label !== 'Overview' && <div className="px-2 pt-2 pb-1 text-[10.5px] uppercase tracking-wider text-subtle font-semibold">{g.label}</div>}
              {g.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={!item.prefix}
                  className={({ isActive }) => cn('block rounded-md px-2 py-1 text-[13px] my-0.5 transition-colors', isActive || (item.prefix && location.pathname.startsWith(item.to + '/')) ? 'bg-surface-2 text-default font-medium' : 'text-muted hover:bg-surface-2/70 hover:text-default')}
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <div className="flex-1 min-w-0">
        <div className="lg:hidden mb-3">
          <Select value={current} onChange={(e) => navigate(e.target.value)}>
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((i) => (
                  <option key={i.to} value={i.to}>
                    {i.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Page title of every admin screen: the same `PageHeader` as the rest of the application, so administration reads like any other page. */
export function SectionHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return <PageHeader title={title} subtitle={description} actions={actions} />;
}

export function NotAllowed() {
  return <div className="card p-8 text-center text-muted text-[13px]">You do not have permission to view this area.</div>;
}
