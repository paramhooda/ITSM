import type { Permission, NavArea } from '@itsm/shared';
import { LayoutDashboard, Ticket, Building2, FileSignature, Boxes, Server, Wrench, CalendarCheck, BookOpen, BarChart3, Settings, Layers, ClipboardCheck, UsersRound } from 'lucide-react';

/** A module inside an application (ServiceNow's navigator: Application → Modules). */
export interface NavChild {
  to: string;
  label: string;
  /** Any of these permissions unlocks the module (routes guard again). */
  perm?: Permission[];
  area?: NavArea;
}

export interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Any of these permissions unlocks the item (routes guard again). */
  perm?: Permission[];
  /** Navigation area; shown only when the user's roles include it (roles without areas show everything their permissions allow). */
  area?: NavArea;
  section?: string;
  /** Modules listed under the application when it is expanded. */
  children?: NavChild[];
}

export const MSP_NAV: NavItem[] = [
  { to: '/', label: 'Dashboards', icon: LayoutDashboard },
  {
    to: '/tickets',
    label: 'Tickets',
    icon: Ticket,
    perm: ['tickets:read'],
    area: 'tickets',
    section: 'Service desk',
    children: [
      { to: '/tickets', label: 'Open' },
      { to: '/tickets?assignee=me', label: 'Assigned to me' },
      { to: '/tickets?assignee=unassigned', label: 'Unassigned' },
      { to: '/tickets?type=incident', label: 'Incidents' },
      { to: '/tickets?type=request', label: 'Requests' },
      { to: '/tickets?type=problem', label: 'Problems' },
      { to: '/tickets?type=change', label: 'Changes' },
      { to: '/tickets/new', label: 'Create new', perm: ['tickets:create'] },
    ],
  },
  { to: '/customers', label: 'Customers', icon: Building2, perm: ['customers:read'], area: 'customers', section: 'Accounts' },
  { to: '/contracts', label: 'Contracts & Scope', icon: FileSignature, perm: ['contracts:read'], area: 'contracts' },
  { to: '/services', label: 'Service Catalog', icon: Layers, perm: ['services:read'], area: 'catalog' },
  { to: '/teams', label: 'Teams', icon: UsersRound, perm: ['tickets:read', 'admin:users'], area: 'teams' },
  {
    to: '/cmdb',
    label: 'Configuration (CMDB)',
    icon: Server,
    perm: ['cmdb:read'],
    area: 'cmdb',
    section: 'Infrastructure',
    children: [
      { to: '/cmdb', label: 'Overview' },
      { to: '/cmdb/cis', label: 'Configuration items' },
      { to: '/cmdb/services', label: 'Business services' },
      { to: '/cmdb/map', label: 'Service map' },
      { to: '/cmdb/classes', label: 'CI classes' },
      { to: '/cmdb/discovery', label: 'Discovery', perm: ['discovery:run', 'discovery:manage'], area: 'discovery' },
    ],
  },
  { to: '/assets', label: 'Assets', icon: Boxes, perm: ['assets:read'], area: 'assets' },
  { to: '/field', label: 'Field Service', icon: Wrench, perm: ['field:read'], area: 'field', section: 'Delivery' },
  { to: '/maintenance', label: 'Preventive Maintenance', icon: CalendarCheck, perm: ['pm:read'], area: 'maintenance' },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen, perm: ['kb:read'], area: 'knowledge' },
  { to: '/reports', label: 'Reports', icon: BarChart3, perm: ['reports:run'], area: 'reports', section: 'Insight' },
  { to: '/admin', label: 'Administration', icon: Settings, perm: ['admin:config', 'admin:users', 'admin:audit', 'admin:system', 'integrations:manage', 'integrations:events'], section: 'System' },
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
  { to: '/portal/users', label: 'Users', icon: UsersRound, perm: ['portal:manage_users'] },
];

type Can = (...perms: Permission[]) => boolean;
const allowed = (item: { perm?: Permission[]; area?: NavArea }, can: Can, areas: string[] | null | undefined) => (!item.perm || can(...item.perm)) && (!item.area || !areas || areas.includes(item.area));

/** Items (and their modules) the user may see, by permission and navigation area. */
export function visibleNav(items: NavItem[], can: Can, areas: string[] | null | undefined): NavItem[] {
  return items.filter((i) => allowed(i, can, areas)).map((i) => (i.children ? { ...i, children: i.children.filter((c) => allowed(c, can, areas)) } : i));
}
