import type { Permission, NavArea } from '@itsm/shared';
import { LayoutDashboard, Ticket, Building2, FileSignature, Boxes, Server, Share2, Radar, Wrench, CalendarCheck, BookOpen, BarChart3, Settings, Plug, Layers, ClipboardCheck, Users, ShieldCheck, UsersRound } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Any of these permissions unlocks the item (routes guard again). */
  perm?: Permission[];
  /** Navigation area; shown only when the user's roles include it (roles without areas show everything their permissions allow). */
  area?: NavArea;
  section?: string;
}

export const MSP_NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/tickets', label: 'Tickets', icon: Ticket, perm: ['tickets:read'], area: 'tickets' },
  { to: '/customers', label: 'Customers', icon: Building2, perm: ['customers:read'], area: 'customers', section: 'Accounts' },
  { to: '/contracts', label: 'Contracts & Scope', icon: FileSignature, perm: ['contracts:read'], area: 'contracts' },
  { to: '/services', label: 'Service Catalog', icon: Layers, perm: ['services:read'], area: 'catalog' },
  { to: '/teams', label: 'Teams', icon: UsersRound, perm: ['tickets:read', 'admin:users'], area: 'teams' },
  { to: '/assets', label: 'Assets', icon: Boxes, perm: ['assets:read'], area: 'assets', section: 'Infrastructure' },
  { to: '/cmdb', label: 'CMDB', icon: Server, perm: ['cmdb:read'], area: 'cmdb' },
  { to: '/discovery', label: 'Discovery', icon: Radar, perm: ['discovery:run', 'discovery:manage'], area: 'discovery' },
  { to: '/integrations', label: 'Monitoring & SIEM', icon: Plug, perm: ['integrations:events', 'integrations:manage'], area: 'monitoring' },
  { to: '/field', label: 'Field Service', icon: Wrench, perm: ['field:read'], area: 'field', section: 'Delivery' },
  { to: '/maintenance', label: 'Preventive Maintenance', icon: CalendarCheck, perm: ['pm:read'], area: 'maintenance' },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen, perm: ['kb:read'], area: 'knowledge' },
  { to: '/reports', label: 'Reports', icon: BarChart3, perm: ['reports:run'], area: 'reports', section: 'Insight' },
  { to: '/admin', label: 'Administration', icon: Settings, perm: ['admin:config', 'admin:users', 'admin:audit', 'admin:system', 'integrations:manage'], section: 'System' },
];

export const PORTAL_NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/portal/tickets', label: 'My Tickets', icon: Ticket, perm: ['portal:tickets'] },
  { to: '/portal/approvals', label: 'Approvals', icon: ClipboardCheck, perm: ['portal:approve'] },
  { to: '/portal/services', label: 'Services & Contracts', icon: FileSignature, perm: ['portal:contracts'] },
  { to: '/portal/assets', label: 'Assets', icon: Boxes, perm: ['portal:assets'] },
  { to: '/portal/maintenance', label: 'Maintenance & Visits', icon: CalendarCheck, perm: ['portal:access'] },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen, perm: ['portal:access'] },
  { to: '/reports', label: 'Reports', icon: BarChart3, perm: ['portal:reports'] },
  { to: '/portal/users', label: 'Users', icon: Users, perm: ['portal:manage_users'] },
];

/** Items the current user may see: permission first, then the navigation areas of their roles (when any role sets them). */
export function visibleNav(items: NavItem[], can: (...perms: Permission[]) => boolean, areas: string[] | null | undefined) {
  return items.filter((i) => (!i.perm || can(...i.perm)) && (!i.area || !areas || areas.includes(i.area)));
}

export { Share2, ShieldCheck };
